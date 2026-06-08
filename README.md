# Order Alert SMS (owner escalation via MSG91) — Build Plan

> **Status:** Planning
> **Duration:** ~1 day
> **Goal:** When a customer places an order and the restaurant does **not** accept or decline it within ~1 minute, RedLotus automatically sends **one** SMS to the restaurant's phone (`restaurants.phone`) prompting the owner to open the dashboard and confirm the order. This is a *backstop* for the in-dashboard audio alert (`useNewOrderAlert`), which only fires when the owner has the dashboard open in a browser tab with sound unlocked.
> **Prerequisites:**
> - Phases 0–4 complete and merged. Ordering, the owner dashboard, and the `expire-orders` cron all work in production.
> - **DLT registration with Airtel complete** for the order-alert content template (details in §3). This is non-negotiable in India — TRAI drops any transactional SMS sent without a DLT-approved template/header pairing.
> - **MSG91 account active** with the Airtel DLT mapping linked (PE ID, Header `RDLOTS`, the order-alert content template), and a **Flow created in MSG91** for that template (§3.2) — the Flow yields MSG91's internal template ID, which is what the API needs.
> - Supabase Edge Functions + `pg_cron`/`pg_net` already proven by the live `expire-orders` deployment. This feature reuses that exact plumbing.

---

## 1. Why This Feature Exists

The owner dashboard already plays a chime when a new order arrives (`src/pages/dashboard/useNewOrderAlert.ts` → `OwnerDashboard.tsx`). But that alert has a hard precondition: **the dashboard must be open in a live browser tab, and the browser's autoplay gesture must have been unlocked.** In practice, the owner is frequently *not* looking at the dashboard:

- The phone is in their pocket / the tab is backgrounded or closed.
- The laptop is asleep, or they're serving customers in the shop.
- Browser autoplay reset the audio unlock on the last page reload and nobody re-armed it.

When that happens, a new order sits in `pending` and silently rides the **15-minute auto-expiry** clock (`expire-orders`). The customer waits, the order expires, and a sale is lost — the single worst outcome in the funnel, because the customer was ready to pay (COD) and we simply failed to reach the restaurant.

SMS solves the one thing the in-app chime cannot: it reaches the restaurant **at the device level, without the dashboard being open**. The escalation ladder becomes:

| Time after order | Channel | Requires dashboard open? |
|---|---|---|
| 0 s | In-app chime + title-bar flash (`useNewOrderAlert`) | Yes |
| ~1–2 min, still `pending` | **SMS to `restaurants.phone`** (this feature) | **No** |
| 15 min, still `pending` | Auto-expire (`expire-orders`) | No |

This feature fills the middle rung.

---

## 2. Decisions & Constraints

These are settled. Each is load-bearing on the implementation below.

### 2.1 Recipient — the restaurant line (`restaurants.phone`)

The SMS goes to **`restaurants.phone`**, not the owner's personal `users.phone`. Rationale: the restaurant line is the operational number the founder records for each restaurant at onboarding, and it's the number a restaurant expects order traffic on.

> **Data-quality requirement (new, important):** `restaurants.phone` is **nullable** today (`001_schema.sql`) and is documented as *"internal/admin only."* For this feature to work, **every active restaurant must carry a valid 10-digit Indian mobile in `restaurants.phone`.** This becomes an onboarding checklist item. An order whose restaurant has a null/invalid phone is **permanently skipped** by the function (logged once, never alerted) — see §6.3. Audit existing rows before launch:
> ```sql
> SELECT id, name, phone FROM public.restaurants
> WHERE is_active = true
>   AND (phone IS NULL OR phone !~ '^[6-9][0-9]{9}$');
> -- Every row returned is a restaurant that will NOT receive order alerts.
> ```

> **Deferred (v2):** alerting the owner's personal `users.phone` as well, or instead, or letting a restaurant register multiple alert numbers (owner + manager). Logged in §10.

### 2.2 Cadence — one SMS per order, ever

A single SMS is sent per order, once, ~1 minute after placement if the order is still `pending`. **No repeat reminders.** This keeps the design to a single idempotency marker (`orders.owner_notified_at`), keeps cost trivial, and avoids hammering a restaurant that is mid-rush with the same generic buzz. Repeating reminders / escalation cadence is a v2 item (§10).

### 2.3 Provider — MSG91 **Flow API** (transactional SMS), *not* the OTP API

The OTP flow (`send-otp`/`verify-otp`) uses MSG91's **OTP API** (`/api/v5/otp`). This is a different product. A plain DLT-templated transactional SMS goes through the **Flow API**:

```
POST https://control.msg91.com/api/v5/flow/
```

> **Why this matters:** the OTP API generates and stores a code; we don't want a code, we want to deliver fixed approved copy. The Flow API takes a `template_id` (MSG91's internal ID for a *Flow* you create around the DLT template) plus a `recipients[]` list. Because our approved template has **no variables**, the recipient object only carries `mobiles`.

### 2.4 The `template_id` gotcha (same trap as the OTP template)

> **`MSG91_ORDER_ALERT_TEMPLATE_ID` must be MSG91's internal Flow/template ID — NOT the Airtel DLT registry number `1007344532626504981`.**

This is the exact gotcha already burned into `CLAUDE.md` for the OTP template ("must be MSG91's internal 24-char ObjectId … NOT the long-numeric DLT registry ID"). Passing the DLT number `1007344532626504981` to the Flow API returns a template-invalid error surfaced as a provider failure and **no SMS is delivered**, even though the call may look like it succeeded. You get the internal ID only by **creating a Flow in MSG91** around the approved template (§3.2).

### 2.5 A separate Edge Function on its own cron (not folded into `expire-orders`)

We add a new function `notify-pending-orders` with its **own** `pg_cron` schedule, rather than extending `expire-orders`. Rationale — same blast-radius logic the phone plan used to keep `send-otp`/`verify-otp` split:

- `expire-orders` does a free, idempotent, single-statement state change. `notify-pending-orders` **spends money** (paid SMS) and calls a flaky third party. Different failure modes, different things to monitor, different deploy cadence — keep the audit boundary clean.
- A bug in the SMS loop must never be able to break order expiry, and vice-versa.

Both run every minute; running two per-minute cron jobs is fine at this scale.

### 2.6 Timing — threshold is 1 minute, effective delay is ~1–2 minutes

The function selects orders whose `created_at` is **≥ 1 minute** in the past and that are still `pending`. Because the cron fires once per minute, the *actual* delay a given order experiences is between **1 and 2 minutes** (an order placed at 12:00:30 is too young at the 12:01:00 run and is first picked up at 12:02:00). This is acceptable and is documented behaviour, not a bug. The threshold is a single constant (`ALERT_AFTER_MINUTES = 1`) — trivially tunable later.

### 2.7 Idempotency — "claim-then-send" via `orders.owner_notified_at`

A new nullable column `orders.owner_notified_at timestamptz` marks an order as *handled by the alert pipeline*. The function **claims** an order with a conditional `UPDATE … WHERE status='pending' AND owner_notified_at IS NULL` **before** sending the SMS. Two guarantees fall out:

1. **No double-send.** If two cron invocations overlap (a slow run + the next tick), only one wins the conditional UPDATE; the other sees 0 rows and skips.
2. **No spurious send after the owner acts.** The claim filters `status='pending'`, so if the owner accepted/declined in the meantime, the claim returns 0 rows and we never send.

> **Documented trade-off:** claim-*before*-send means a transient MSG91 outage at the moment of sending **skips that order's alert** (the row is already claimed, so the next run won't retry). This is deliberate: for a money-spending backstop, *not double-charging / not double-buzzing* matters more than guaranteeing every single alert, and the in-app chime + 15-min expiry still apply. A retry-on-failure upgrade (reset `owner_notified_at` to NULL in the failure branch) is a one-line change documented in §6.4 and listed in §10.

`owner_notified_at` semantics: **set when the SMS is sent OR when the order is permanently skipped (no valid restaurant phone). `NULL` = not yet handled.**

### 2.8 SMS wording — DLT-approved text ships as-is (accepted exception to "no app" rule)

The approved content is, verbatim:

```
Order Alert! You have a new order on RedLotus! Open the Restaurant Partner app to view & confirm the order. - Team RedLotus
```

> **Known exception:** RedLotus's product rule is *website-only — never reference "app"/"download"/"install" in UI* (`CLAUDE.md` → Product constraints). This SMS says *"Restaurant Partner app."* We ship it anyway, because **DLT-approved template text cannot be edited without a fresh Airtel approval cycle**, and re-approval is not worth blocking this feature on. This is a conscious, documented exception confined to the SMS channel.
>
> **v2 option (logged in §10):** submit a website-friendly variant (e.g. *"Open your RedLotus dashboard to confirm the order"*) for DLT re-approval, then swap the Flow's template.

### 2.9 Cost

- MSG91 transactional SMS: ~₹0.20–0.25 per message (confirm the live rate in **MSG91 Dashboard → Wallet → Pricing**).
- This SMS only fires when an order is *ignored* for a minute. Early on (owners not yet habituated to the dashboard) it may fire often; as owners learn to keep the dashboard open it should taper. Even a pessimistic 20 alerts/day ≈ **₹4/day ≈ ₹120/month** worst case; realistically a fraction of that. Negligible for v1; glance at the MSG91 wallet weekly (§9).

---

## 3. Provider Setup (MSG91 Dashboard — manual, one-time)

These steps happen in the MSG91 web UI, not in code. Do them once before Step 1 of the build sequence.

### 3.1 Confirm the Airtel DLT mapping is loaded in MSG91

1. **MSG91 → Inbound → DLT → Connect DLT.** The Airtel PE shows `Verified`.
2. **MSG91 → Inbound → DLT → Headers.** Header **`RDLOTS`** is `Approved`. (Its DLT Header ID is `1005132367990441245` — the same header already used by the OTP flow; see `phone_verification_plan.md` §3.1.)
3. **MSG91 → Inbound → DLT → Templates.** The order-alert **content** template is present and `Approved`, mapped to DLT content template ID **`1007344532626504981`**, with body exactly:
   ```
   Order Alert! You have a new order on RedLotus! Open the Restaurant Partner app to view & confirm the order. - Team RedLotus
   ```

### 3.2 Create the Flow → get MSG91's internal template ID

The Flow API needs MSG91's **internal** template ID, not the DLT registry number (§2.4).

1. **MSG91 → Campaigns / Flows → Create Flow** (UI labels shift over MSG91 versions; it may sit under **Send → Flow** or **SMS → Templates**).
2. Bind it to the **`RDLOTS`** sender and the **approved order-alert content template** from §3.1.
3. Because the content has **no `{#var#}` placeholders**, the Flow has **no variables**.
4. Save. MSG91 issues an **internal template/Flow ID** (a 24-char hex/ObjectId, e.g. `6a1b…`). **This is `MSG91_ORDER_ALERT_TEMPLATE_ID`.**

### 3.3 Recorded values for RedLotus Foods

| Field | Value |
|---|---|
| Header (Sender ID) | `RDLOTS` |
| Header DLT ID | `1005132367990441245` |
| DLT **content** template ID (Airtel registry) | `1007344532626504981` |
| **MSG91 internal Flow/template ID** | `<fill in after §3.2 — this is the env var value>` |
| Approved content | `Order Alert! You have a new order on RedLotus! Open the Restaurant Partner app to view & confirm the order. - Team RedLotus` |

> These IDs are **not secrets** (registry/flow identifiers are useless without the MSG91 Auth Key, which *is* secret and never committed). Safe to keep in this doc and reference from config.

---

## 4. Architecture

```
        ┌──────────────────────────────────────────────────────────┐
        │  Postgres: pg_cron  '* * * * *'  (every minute)            │
        │     └─ pg_net.http_post → Edge Function                    │
        │            with header  X-Cron-Secret: <CRON_SECRET>       │
        └───────────────────────────┬──────────────────────────────┘
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │   Edge Function: notify-pending-orders (service role)      │
        │  ┌────────────────────────────────────────────────────┐   │
        │  │ 1. Auth: X-Cron-Secret == CRON_SECRET              │   │
        │  │ 2. SELECT orders WHERE status='pending'            │   │
        │  │      AND owner_notified_at IS NULL                 │   │      MSG91 Flow API
        │  │      AND created_at <= now() - 1 min               │   │   ┌──────────────────┐
        │  │      JOIN restaurants (id, name, phone)            │   │   │ POST /api/v5/    │
        │  │ 3. for each candidate:                             │   │   │      flow/       │
        │  │    a. CLAIM: UPDATE owner_notified_at=now()        │───┼──▶│  template_id     │
        │  │       WHERE id=? AND status='pending'              │   │   │  recipients[]    │
        │  │       AND owner_notified_at IS NULL  (0 rows→skip) │   │   │   mobiles=91XXXX │
        │  │    b. validate restaurant phone (^[6-9]\d{9}$)     │   │   └──────────────────┘
        │  │    c. send SMS via MSG91 Flow                      │   │            │
        │  │ 4. return { sent, skippedNoPhone, … }              │   │            ▼
        │  └────────────────────────────────────────────────────┘   │   SMS to restaurant
        └──────────────────────────────────────────────────────────┘   header: RDLOTS
```

Guarantees baked into this shape:

1. **Only our cron can invoke it.** The `X-Cron-Secret` gate is identical to `expire-orders`; there is no user-facing path and `verify_jwt = false`.
2. **The restaurant phone never leaves the server.** It is read server-side via the service-role client and used only as the SMS destination — never returned in the HTTP response and never written to logs (we log order/restaurant **IDs**, never phone numbers).
3. **No double-send, no post-action send.** The claim-then-send pattern (§2.7) enforces both.

---

## 5. Prerequisite Migration — `010_order_alert_sms.sql`

### 5.1 What it does

1. Adds `orders.owner_notified_at timestamptz` (nullable, default `NULL`) — the claim/idempotency marker (§2.7).
2. Adds a **partial index** so the per-minute cron query stays O(few) forever: it indexes only rows that are `pending AND owner_notified_at IS NULL`. As soon as an order is claimed or leaves `pending`, it drops out of the index.

No RLS change is required: the service-role client bypasses RLS, and no customer/owner query reads this column. (It would be harmless even if surfaced — it's just a timestamp.)

### 5.2 SQL

```sql
-- ============================================================
-- 010_order_alert_sms.sql
-- Owner escalation alert: one-time SMS to the restaurant when an
-- order sits in 'pending' longer than ~1 minute without owner action.
--   (1) orders.owner_notified_at — claim / idempotency marker
--   (2) partial index to keep the per-minute cron SELECT + claim cheap
-- See src/docs/order_alert_sms_plan.md for the design.
-- Run this TENTH in Supabase SQL Editor (after 009_menu_image_rls_security_definer.sql)
-- ============================================================

-- ── 1. orders.owner_notified_at ──────────────────────────────
-- Timestamp the alert pipeline finished handling this order:
-- set when the SMS is SENT, or when the order is PERMANENTLY
-- SKIPPED (restaurant has no valid phone). NULL = not yet handled.
-- notify-pending-orders "claims" an order by setting this column
-- with a conditional UPDATE *before* sending, so two overlapping
-- cron runs can never double-send and an order the owner just
-- acted on is never alerted.
ALTER TABLE public.orders
  ADD COLUMN owner_notified_at timestamptz;

-- ── 2. Partial index for the cron query ──────────────────────
-- The cron selects pending, not-yet-notified orders past the age
-- cutoff every minute. This partial index holds only the handful
-- of rows in that state at any instant, so the SELECT and the
-- by-id claim stay fast regardless of total order volume.
CREATE INDEX idx_orders_pending_alert
  ON public.orders (created_at)
  WHERE status = 'pending' AND owner_notified_at IS NULL;
```

### 5.3 Deploy notes

- **Apply order:** `001 → … → 009 → 010`. Additive only (new nullable column + index) — safe on a live table, no rewrite, no backfill. Existing pending rows get `owner_notified_at = NULL` and become immediately eligible (they'll be picked up on the next cron tick once the function is live — see the rollout note in §7, Step 4).
- **Regenerate types:** `npx supabase gen types typescript --local > src/types/database.ts`. The new column will appear on the `orders` row type; nothing in the app reads it, but keep types fresh.
- **Preview branches:** the Supabase↔GitHub integration applies this migration automatically on the PR's preview branch.

---

## 6. The Edge Function — `notify-pending-orders`

### 6.1 File

`supabase/functions/notify-pending-orders/index.ts` (new).

### 6.2 Reference implementation

This mirrors `expire-orders` (cron auth + service-role client) and `send-otp` (MSG91 call + env handling). The Supabase client is untyped here, same as elsewhere in the repo, so the embedded `restaurant` relation is cast.

```ts
// ============================================================
// notify-pending-orders Edge Function
// Sends ONE SMS alert to a restaurant when one of its orders has
// been 'pending' longer than ALERT_AFTER_MINUTES without the owner
// accepting/declining — i.e. the owner is away from the dashboard
// and missed the in-app chime.
//
// Invocation: scheduled every minute via pg_cron (see §7 Step 4).
// Auth: requires the X-Cron-Secret header to match CRON_SECRET.
//
// Idempotency (claim-then-send): each candidate order is "claimed"
// with a conditional UPDATE of owner_notified_at BEFORE the SMS is
// sent, so overlapping cron runs cannot double-send and an order the
// owner just acted on is skipped (the claim filters status='pending').
// Trade-off: a transient MSG91 outage skips that order's alert (no
// retry). The in-app chime + 15-min expiry still apply. See §6.4.
//
// ── Deploy:
//   supabase functions deploy notify-pending-orders --no-verify-jwt
//
// ── Schedule (run once in SQL Editor, after deploying): see §7 Step 4.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow/";
const PHONE_RE = /^[6-9]\d{9}$/;
const ALERT_AFTER_MINUTES = 1;
const BATCH_LIMIT = 50;

Deno.serve(async (req) => {
  // ── 1. Auth: only our pg_cron schedule may call this.
  const providedSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (!expectedSecret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (providedSecret !== expectedSecret) return json({ error: "unauthorized" }, 401);

  // ── 2. Env.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authKey = Deno.env.get("MSG91_AUTH_KEY");
  const templateId = Deno.env.get("MSG91_ORDER_ALERT_TEMPLATE_ID");
  if (!supabaseUrl || !serviceRoleKey || !authKey || !templateId) {
    console.error("notify-pending-orders: missing env vars");
    return json({ error: "server_misconfigured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 3. Find pending orders older than the threshold that have not
  //       been alerted yet, with their restaurant's contact phone.
  const cutoff = new Date(Date.now() - ALERT_AFTER_MINUTES * 60_000).toISOString();
  const { data: candidates, error: selErr } = await supabase
    .from("orders")
    .select("id, restaurant:restaurants(id, name, phone)")
    .eq("status", "pending")
    .is("owner_notified_at", null)
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (selErr) {
    console.error("notify-pending-orders: select failed", selErr);
    return json({ error: selErr.message }, 500);
  }

  let sent = 0;
  let skippedNoPhone = 0;
  let skippedClaimLost = 0;
  let failed = 0;

  for (const row of candidates ?? []) {
    const restaurant = row.restaurant as unknown as
      | { id: string; name: string; phone: string | null }
      | null;

    // ── 3a. CLAIM before sending: overlapping runs can't double-send,
    //         and an order the owner just acted on is skipped.
    const { data: claimed, error: claimErr } = await supabase
      .from("orders")
      .update({ owner_notified_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .is("owner_notified_at", null)
      .select("id");

    if (claimErr) {
      console.error(`notify-pending-orders: claim failed for order ${row.id}`, claimErr);
      failed++;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      skippedClaimLost++; // owner acted, or another run claimed it first
      continue;
    }

    // ── 3b. Resolve + validate the restaurant phone (10-digit Indian).
    //         Tolerant of stored '+91'/spaces: strip non-digits, take last 10.
    const digits = (restaurant?.phone ?? "").replace(/\D/g, "");
    const mobile = digits.length > 10 ? digits.slice(-10) : digits;
    if (!PHONE_RE.test(mobile)) {
      // Permanently skipped. The claim is already set, so this logs ONCE
      // (not every minute). Fix the restaurant row so future orders alert.
      console.warn(
        `notify-pending-orders: order ${row.id} restaurant ${restaurant?.id} ` +
          `has no valid phone — alert skipped`,
      );
      skippedNoPhone++;
      continue;
    }

    // ── 3c. Send the DLT-approved order-alert SMS via MSG91 Flow API.
    //         Template has no variables, so recipients carry only `mobiles`.
    let providerResp: Response;
    try {
      providerResp = await fetch(MSG91_FLOW_URL, {
        method: "POST",
        headers: {
          authkey: authKey,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          template_id: templateId,
          short_url: "0",
          recipients: [{ mobiles: `91${mobile}` }],
        }),
      });
    } catch (e) {
      console.error(`notify-pending-orders: msg91 fetch failed for order ${row.id}`, e);
      failed++;
      continue;
    }

    const provider = await providerResp.json().catch(() => ({}));
    if (!providerResp.ok || provider?.type !== "success") {
      console.error(`notify-pending-orders: msg91 non-success for order ${row.id}`, {
        status: providerResp.status,
        type: provider?.type, // never log phone numbers
      });
      failed++;
      continue;
    }

    sent++;
  }

  const summary = { sent, skippedNoPhone, skippedClaimLost, failed };
  if (sent > 0 || failed > 0 || skippedNoPhone > 0) {
    console.log("notify-pending-orders:", summary);
  }
  return json(summary);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

### 6.3 Behaviour at a glance

| Candidate state at run time | Outcome |
|---|---|
| Still `pending`, ≥1 min old, valid restaurant phone | **SMS sent**, `owner_notified_at` set (`sent++`) |
| Owner accepted/declined since the SELECT | Claim returns 0 rows → skipped (`skippedClaimLost++`) |
| Restaurant phone null / not `^[6-9]\d{9}$` | Claimed (to stop re-logging) then **skipped**, one warning (`skippedNoPhone++`) |
| MSG91 unreachable / non-`success` | Claimed, **no SMS**, error logged, **no retry** (`failed++`) — see §6.4 |
| `created_at` < 1 min ago | Not selected this run; eligible next run |
| Already `expired` / `accepted` / etc. | Not selected (`status != 'pending'`) |

### 6.4 Optional: retry-on-failure (v2-ready, one-line change)

If you later want a transient MSG91 blip to retry on the next tick instead of being skipped, **un-claim on failure** — in the two failure branches (`fetch` throw and non-`success`), reset the marker before `continue`:

```ts
await supabase.from("orders")
  .update({ owner_notified_at: null })
  .eq("id", row.id)
  .eq("status", "pending");   // don't un-claim an order that has since changed state
```

This preserves the no-double-send guarantee (only one run holds the claim at a time) while allowing bounded retries until the order is accepted, declined, or expires at 15 min. Left out of the v1 reference to keep it simple; logged in §10.

### 6.5 Config — `supabase/config.toml`

Add a block so the preview-branch bot deploys it (mirrors the `expire-orders` entry):

```toml
[functions.notify-pending-orders]
# Called by pg_cron via pg_net with an X-Cron-Secret header matching the
# CRON_SECRET env var — never by a user JWT.
verify_jwt = false
```

---

## 7. Build Sequence

Each step is independently verifiable. Do not skip ahead.

### Step 1 — MSG91 secret + curl smoke test

**Why first:** prove the auth key + internal template ID + `RDLOTS` header actually deliver a real SMS *before* writing function code, so any later failure is unambiguously a code bug, not provider misconfiguration.

1. Create the Flow and record the internal template ID (§3.2).
2. Add the new secret to the production Supabase project (and staging if separate). `MSG91_AUTH_KEY` and `CRON_SECRET` already exist from prior features — only the template ID is new:
   ```bash
   supabase secrets set \
     MSG91_ORDER_ALERT_TEMPLATE_ID='<MSG91 internal Flow/template id from §3.2>' \
     --project-ref <your-project-ref>
   ```
   Verify with `supabase secrets list --project-ref <ref>`.
3. Smoke-test the Flow API against your own phone:
   ```bash
   curl -X POST 'https://control.msg91.com/api/v5/flow/' \
     -H 'authkey: <MSG91_AUTH_KEY>' \
     -H 'Content-Type: application/json' \
     -H 'accept: application/json' \
     -d '{
       "template_id": "<MSG91 internal template id>",
       "short_url": "0",
       "recipients": [{ "mobiles": "91<YOUR_10_DIGIT_NUMBER>" }]
     }'
   ```
   Expected: `{ "type": "success", "message": "<request id>" }` and the SMS arrives within ~10 s with header `RDLOTS` and the exact approved body.

> **If MSG91 returns `success` but no SMS lands:** header/template mismatch on the Airtel DLT side. Check **MSG91 → Logs → SMS Logs** for the carrier delivery report. Do not proceed until a real SMS reaches a real device — sandbox success does not prove DLT delivery.

**Testable output:** a real order-alert SMS on your phone, sent via the Flow API with the production auth key.

---

### Step 2 — Apply migration `010_order_alert_sms.sql`

1. Write the file (§5.2).
2. Apply to staging / local first (`supabase db reset` or `supabase db push --project-ref <staging>`); confirm:
   ```sql
   \d public.orders                       -- owner_notified_at column present, nullable
   SELECT indexname FROM pg_indexes
   WHERE tablename = 'orders' AND indexname = 'idx_orders_pending_alert';
   ```
3. Apply to production: `supabase db push --project-ref <prod-ref>`.
4. Regenerate types (§5.3).

**Testable output:** `orders.owner_notified_at` exists and is `NULL` for all rows; the partial index exists.

---

### Step 3 — Implement + deploy the function

1. Create `supabase/functions/notify-pending-orders/index.ts` (§6.2) and the `config.toml` block (§6.5).
2. Deploy (no JWT — it's cron-only):
   ```bash
   supabase functions deploy notify-pending-orders --no-verify-jwt --project-ref <ref>
   ```
3. Invoke it manually with the cron secret to dry-run the query path (it will alert any genuinely-stale pending orders, so do this when none exist, or accept a real SMS):
   ```bash
   curl -X POST 'https://<project-ref>.supabase.co/functions/v1/notify-pending-orders' \
     -H 'X-Cron-Secret: <CRON_SECRET>' -H 'Content-Type: application/json'
   # Expected: {"sent":0,"skippedNoPhone":0,"skippedClaimLost":0,"failed":0} on a quiet DB
   ```
4. Confirm the auth gate: the same call **without** the header returns `401 unauthorized`.

**Testable output:** function returns a JSON summary; unauthorized calls are rejected.

---

### Step 4 — Schedule the cron

Run **once** in the Supabase SQL Editor after the function is deployed (mirrors the `expire-orders` schedule in that function's header comment):

```sql
select cron.schedule(
  'notify-pending-orders-every-minute',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/notify-pending-orders',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'X-Cron-Secret', '<CRON_SECRET>'
      )
    );
  $$
);
```

Verify and manage:
```sql
SELECT jobid, jobname, schedule, active FROM cron.job;          -- expire-orders + notify-pending-orders both listed
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;  -- recent runs
-- To remove later: SELECT cron.unschedule('notify-pending-orders-every-minute');
```

> **Rollout note:** the instant this cron goes live, **every order already sitting in `pending` for >1 min with `owner_notified_at IS NULL` gets an SMS on the first tick.** Schedule it during a quiet window (avoid 12–2 PM / 7–9:30 PM peak per `CLAUDE.md`), and ideally when no orders are pending, so the first run doesn't fan out a burst of alerts for in-flight orders.

**Testable output:** `cron.job` lists the new job as `active`; `cron.job_run_details` shows successful per-minute runs.

---

### Step 5 — End-to-end test on a real device

This is the only step that proves DLT delivery + the timing/idempotency logic together.

| # | Scenario | Expected |
|---|---|---|
| 1 | Place a test order; **do nothing** for ~2 min | One SMS lands on `restaurants.phone` (~1–2 min); `orders.owner_notified_at` is now set |
| 2 | Place a test order; **accept within 30 s** | **No SMS** (claim finds `status != 'pending'`); `owner_notified_at` stays `NULL` |
| 3 | Let test order #1 keep sitting after the SMS | **No second SMS** (single-send) until 15-min expiry |
| 4 | Order for a restaurant whose `phone` is null/invalid | **No SMS**; exactly **one** `skippedNoPhone` warning in function logs; `owner_notified_at` set |
| 5 | Two pending orders for the **same** restaurant, both ignored | **Two** SMS (one per order — v1 behaviour, §10 notes coalescing as v2) |
| 6 | Watch two adjacent cron ticks for one stale order | Exactly **one** SMS total (no double-send) |
| 7 | Cost check | MSG91 wallet shows ~₹0.2 deducted per delivered alert |

**Pre-launch gate:** do not consider this feature live until #1, #2, #3, and #6 pass on a physical phone with the production key.

---

## 8. Security Considerations

| Threat | Mitigation |
|---|---|
| Public / user invocation of the function | `X-Cron-Secret` gate identical to `expire-orders`; `verify_jwt = false` but the secret is required; no user-facing route |
| MSG91 auth key leakage | Key lives only in Edge Function secrets; never in `import.meta.env` or any client-readable surface; never returned or logged |
| Restaurant phone (internal/admin data) leaking | Read server-side via service role; **never** returned in the HTTP response; logs carry order/restaurant **IDs only**, never phone numbers |
| Double-charge / SMS spam from overlapping runs | Claim-then-send conditional UPDATE (§2.7) — only one run can claim an order |
| Alerting an order the owner already handled | Claim filters `status='pending'` — a handled order yields 0 rows and is skipped |
| Stolen `CRON_SECRET` | Attacker could trigger extra runs, but the function is idempotent (claimed orders won't re-send) and only ever messages legitimately-pending orders' own restaurants. Rotate `CRON_SECRET` if suspected; it's a single secret shared with `expire-orders` |
| Sending to an attacker-controlled number | Impossible — destination comes solely from `restaurants.phone` server-side; no client input reaches the function |

---

## 9. Cost & Monitoring

- **Per-alert cost:** ~₹0.20–0.25. Confirm in **MSG91 → Wallet → Pricing**.
- **Expected volume:** only ignored-for-a-minute orders. Pessimistically ~20/day early on → **~₹120/month** worst case; should taper as owners habituate. Negligible.
- **Weekly glance:**
  - **MSG91 → Logs → SMS Logs** — look for `Failed`/`Rejected` (DLT drift or carrier block).
  - **Supabase → Edge Functions → notify-pending-orders → Logs** — the per-run `{ sent, skippedNoPhone, skippedClaimLost, failed }` summary. A non-zero **`skippedNoPhone`** means a restaurant is missing a valid `phone` (fix the row). A persistently non-zero **`failed`** means MSG91 trouble.
  - **`cron.job_run_details`** — confirm the job is still firing every minute.
- **Abuse / runaway signal:** if `sent` per day spikes far beyond order volume, inspect for a loop bug or a stuck-pending order that isn't expiring.

---

## 10. v2 Deferrals (add to `src/docs/v2_deferred_issues.md`)

1. **Retry-on-failure** — un-claim `owner_notified_at` in the failure branches so a transient MSG91 outage retries on the next tick (one-line change, §6.4). Deferred to keep v1 simple.
2. **Repeat / escalation cadence** — a second nudge at, say, 5 min, or escalation to a different number. v1 sends exactly one SMS.
3. **Owner `users.phone` as an additional/alternative recipient**, and **multiple alert numbers per restaurant** (owner + manager). v1 targets only `restaurants.phone`.
4. **Per-restaurant coalescing** — if N orders pile up unconfirmed in the same window, send one "you have new orders" SMS instead of N. Needs a reworded DLT template (current copy is singular) and a different claim model.
5. **Website-friendly DLT template** — re-approve copy without the word "app" (e.g. *"Open your RedLotus dashboard to confirm the order"*) and swap the Flow's template (§2.8).
6. **WhatsApp escalation** — cheaper, richer, higher open-rate; requires Meta Business verification + template approval.
7. **Presence-aware suppression** — skip the SMS if the owner's dashboard is provably active (would require presence tracking; not worth it for v1, where an occasional harmless SMS to a watching owner is fine).

---

## Appendix A — Files Touched by This Plan

```
supabase/migrations/
  └── 010_order_alert_sms.sql                    (new)

supabase/functions/
  └── notify-pending-orders/index.ts             (new)

supabase/
  └── config.toml                                (add [functions.notify-pending-orders])

src/types/database.ts                            (regenerate — owner_notified_at column)

src/docs/
  ├── order_alert_sms_plan.md                    (this file)
  └── v2_deferred_issues.md                      (add §10 entries)

CLAUDE.md                                         (Hosting & env: list notify-pending-orders +
                                                  MSG91_ORDER_ALERT_TEMPLATE_ID secret;
                                                  Database: note orders.owner_notified_at;
                                                  Owner dashboard: note SMS escalation)
GEMINI.md                                         (mirror the CLAUDE.md change)
```

Manual one-time steps (not files):
- MSG91 Dashboard — create the Flow, record the internal template ID (§3.2).
- `supabase secrets set MSG91_ORDER_ALERT_TEMPLATE_ID=…` (§7 Step 1).
- `cron.schedule('notify-pending-orders-every-minute', …)` in SQL Editor (§7 Step 4).
- Audit `restaurants.phone` for all active restaurants (§2.1).

---

## Appendix B — MSG91 Flow API Quick Reference

> Verify exact field names against MSG91's live docs (`https://docs.msg91.com/`) before implementing; provider parameter names occasionally shift. Shapes below match the v5 Flow API as of this writing.

```
POST  https://control.msg91.com/api/v5/flow/
      headers: authkey, Content-Type: application/json, accept: application/json
      body:
        {
          "template_id": "<MSG91 internal Flow/template id>",   // NOT the DLT registry number
          "short_url": "0",
          "recipients": [
            { "mobiles": "91XXXXXXXXXX" }                       // + var1/var2… only if template has variables
          ]
        }
      success: { "type": "success", "message": "<request id>" }
      failure: { "type": "error",   "message": "<reason>" }     // e.g. invalid template id
```

Contrast with the OTP API used by `send-otp` (`POST /api/v5/otp`) — different product, different ID, do not mix them up.
