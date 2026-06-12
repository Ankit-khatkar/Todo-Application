# Customer Order Cancellation + Owner-Set Delivery ETA — Build Plan

> **Status:** Design — not started. Two independent features, planned together because they both live on the `pending → accepted` boundary and touch the same files (`OrderStatus.tsx`, `OwnerDashboard.tsx`, the status-transition trigger).
> **Duration:** ~1 day each (migration + frontend + tests). They can ship as two separate PRs in either order — see §8 rollout notes.
> **Goal:**
> 1. **Customer cancellation** — a customer can cancel their own order **while it is still `pending`** (i.e. before the restaurant accepts). After acceptance, no cancellation — unchanged from v1.
> 2. **Delivery ETA** — when the owner accepts an order they pick a time duration ("this order will reach the customer in ~X minutes"); the customer's `/orders/:id` page shows that promise as an arrival window so they know when food is coming.
> **Prerequisites:** none technical — both are schema tweaks + frontend on existing tables/pages. No new services, no new Edge Functions, no new cron.

---

## 1. Why These Features Exist

**Cancellation.** Today the customer's only path out of a mis-placed order (wrong restaurant, fat-fingered quantity, changed their mind) is calling the restaurant or waiting 15 minutes for auto-expiry. That's bad for both sides: the customer feels trapped, and the owner gets a chime + possibly an SMS for an order the customer never wanted. The key insight that makes this safe in v1: **`pending` means the restaurant has not accepted and has not started cooking.** Cancelling a pending order costs the restaurant nothing. That's why the line is drawn exactly there — see §2.1.

**ETA.** Today the customer's status page says *"Order confirmed! The restaurant is getting ready."* with no time attached. The customer has no idea whether food is 15 or 60 minutes away, which drives "where is my order" phone calls straight to the restaurant (the only phone number the customer has is their own order history... so in practice to Ankit on WhatsApp). A visible owner-made promise ("arriving in 30–40 min") is the single highest-leverage trust signal on the order-status page, and it costs the owner one extra tap at accept time.

---

## 2. Feature A — Customer Cancellation of Pending Orders

### 2.1 Decisions & constraints

#### 2.1.1 Pending-only — a clean, explainable rule

Cancellation is allowed **only while `status = 'pending'`**. The moment the owner accepts, the kitchen may have started and ingredients are committed — from `accepted` onward, no cancellation (call the restaurant / Ankit for exceptions, exactly as today). This is the rule customers intuitively expect ("I can take it back until the restaurant says yes") and it's the rule that costs restaurants nothing. A grace window after acceptance was considered and rejected for v1 — it reopens the food-waste problem the no-cancellation rule existed to prevent. Logged as a v2 idea (§9).

#### 2.1.2 New enum value `cancelled` — not a reuse of `declined`

`declined` is an owner action with a mandatory reason; reusing it with a synthetic reason ("Cancelled by customer") would corrupt owner-facing history, decline analytics, and the `decline_reason_required` CHECK's meaning. A distinct terminal status keeps every surface honest:

```
pending → accepted → preparing → out_for_delivery → completed
pending → declined   (owner, with reason)
pending → expired    (cron, after 15 min)
pending → cancelled  (customer)            ← NEW
```

`cancelled` is terminal. No backward transitions, no resurrection.

#### 2.1.3 No cancellation reason in v1

The owner hasn't started anything, so the customer owes no explanation. No new text column, no extra modal field, no validation. If cancellation-rate analytics later show abuse, a reason field (or rate limiting, §9) can be added then.

#### 2.1.4 No new timestamp column

`updated_at` already captures when the cancellation happened (the status flip is the last write to a cancelled order). Same reasoning as `declined`/`expired`, which also have no dedicated timestamps.

#### 2.1.5 RPC, **not** a customer UPDATE RLS policy

Customers currently have **no UPDATE policy on `orders`** — and that must stay true. RLS can restrict *which rows* a user may update but not *which columns or values*, so a naive `orders_customer_update` policy would let a customer:

- set `status = 'accepted'` on their own order (the transition trigger allows `pending → accepted` regardless of actor) — fake-accepting to dodge the 15-min expiry and the SMS backstop;
- set `status = 'declined'` with a fabricated reason, impersonating the restaurant;
- rewrite `delivery_address` / `special_instructions` after the owner has seen the card.

**Decision:** cancellation goes through a `cancel_order(p_order_id uuid)` SECURITY DEFINER RPC — the same pattern as `place_order`. The RPC bypasses RLS (customers keep zero direct UPDATE grants) and enforces ownership + state in its own `WHERE` clause. Atomicity and races come free from the conditional UPDATE (§2.1.6).

#### 2.1.6 Race handling — the same conditional-UPDATE pattern the dashboard already uses

Three actors can touch a pending order at the same instant: the customer (cancel), the owner (accept/decline), and the cron (expire). All three already/will use `UPDATE … WHERE status = 'pending'`, so Postgres row locking serialises them — whoever commits first wins, everyone else matches 0 rows:

| Race | Winner behaviour | Loser behaviour |
|---|---|---|
| Customer cancels vs owner accepts | First commit wins | Owner: existing *"This order is no longer pending. Refreshing…"* toast + refetch. Customer: RPC returns `false` → *"The restaurant has already accepted your order."* + refetch shows live status. |
| Customer cancels vs owner declines | Same | Same pattern on both sides. |
| Customer cancels vs cron expires | Same | Customer who loses to the cron sees the expired state — functionally identical outcome for them. |

No new locking machinery, no advisory locks, nothing clever.

#### 2.1.7 Defence-in-depth: the transition trigger checks the actor

Allowing `pending → cancelled` in `enforce_status_transition()` alone would let an **owner** (who *does* have an UPDATE policy on their restaurant's orders) set `cancelled` — sidestepping the mandatory decline reason while making it look customer-initiated. The trigger therefore gates the new transition on the actor:

`NEW.status = 'cancelled'` is allowed only when `auth.uid() = OLD.customer_id`. `auth.uid()` reads the JWT claims, so it still returns the customer's id inside the SECURITY DEFINER RPC — the legitimate path passes, the owner path raises. (Admin/service-role sessions have no JWT `sub` matching the customer; if Ankit ever needs to force-cancel, the Supabase Dashboard runs as a true superuser session where the trigger can be worked around deliberately — acceptable for a sole-admin v1.)

#### 2.1.8 Interplay with the SMS backstop and expiry cron — zero changes needed

- `expire-orders` only touches `status = 'pending'` rows — a cancelled order naturally drops out of its window.
- `notify-pending-orders` claims via `status = 'pending' AND owner_notified_at IS NULL` — cancel **before** the ~1-min alert and no SMS is ever sent (a genuine win: instant-regret cancellations stop pinging owners). Cancel **after** the SMS went out and the owner gets a text for an order that's gone — they open the dashboard and find it in Today's History as *Cancelled*. Mildly annoying, inherent to any alert-then-cancel ordering, accepted for v1.
- `owner_notified_at` semantics are untouched.

#### 2.1.9 Owner dashboard must learn the new status (Realtime)

The dashboard's Realtime UPDATE handler currently routes `expired`, active statuses, and `completed`/`declined`. An unrecognised `cancelled` payload would match **no branch — the pending card would sit on screen as a ghost** until reload. The handler gets a `cancelled` branch that mirrors `expired` (remove from pending, snapshot into Today's History), plus a toast — unlike silent cron expiry, a cancellation can land seconds before the owner taps Accept, so an explicit *"Order cancelled by the customer."* heads off confusion. `HISTORY_STATUSES` and `historyStatusLabel` gain `cancelled` accordingly.

### 2.2 Migrations

**Two files, not one.** `ALTER TYPE … ADD VALUE` commits fine inside a migration's transaction (PG 12+), but the new value **cannot be referenced by parsed SQL in the same transaction** — Postgres raises *"unsafe use of new value"* for policies, CHECK constraints, or partial-index predicates that mention it. plpgsql function bodies escape this (they're stored as strings, parsed at runtime), but splitting is the rule that never bites: enum addition in its own migration, everything that uses the value in the next.

#### `012_order_status_cancelled.sql`

```sql
-- ============================================================
-- 012_order_status_cancelled.sql
-- Adds the 'cancelled' terminal status (customer-initiated).
-- MUST be its own migration: a new enum value cannot be referenced
-- by parsed SQL (policies / CHECKs / index predicates) in the same
-- transaction that adds it. 013 holds everything that uses it.
-- See src/docs/customer_cancellation_and_eta_plan.md for the design.
-- ============================================================

ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'cancelled';
```

#### `013_customer_cancellation.sql`

```sql
-- ============================================================
-- 013_customer_cancellation.sql
--   (1) enforce_status_transition: allow pending → cancelled,
--       customer-actor-gated (defence-in-depth vs owner misuse)
--   (2) cancel_order RPC — the ONLY cancellation path; customers
--       keep zero direct UPDATE grants on orders
-- See src/docs/customer_cancellation_and_eta_plan.md.
-- ============================================================

-- ── 1. Status transition trigger v2 ──────────────────────────
-- Adds pending → cancelled, allowed only when the JWT subject is
-- the order's customer. auth.uid() still resolves to the customer
-- inside the SECURITY DEFINER cancel_order RPC (it reads claims,
-- not the function owner), so the legitimate path passes while an
-- owner-session UPDATE to 'cancelled' raises.

CREATE OR REPLACE FUNCTION public.enforce_status_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending'          AND NEW.status IN ('accepted', 'declined', 'expired'))
  OR (OLD.status = 'accepted'         AND NEW.status = 'preparing')
  OR (OLD.status = 'preparing'        AND NEW.status = 'out_for_delivery')
  OR (OLD.status = 'out_for_delivery' AND NEW.status = 'completed')
  THEN
    RETURN NEW;
  END IF;

  -- Customer cancellation: pending only, customer actor only.
  IF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    IF auth.uid() = OLD.customer_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only the customer can cancel an order';
  END IF;

  RAISE EXCEPTION 'Invalid status transition from % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

-- Trigger object already exists (003); CREATE OR REPLACE of the
-- function is sufficient — do not re-create the trigger.

-- ── 2. cancel_order RPC ──────────────────────────────────────
-- Mirrors place_order: SECURITY DEFINER so no customer UPDATE
-- policy is ever added to orders. Ownership + state live in the
-- WHERE clause; the conditional UPDATE is the race guard (same
-- pattern as the owner dashboard's accept/decline).
-- Returns true on success, false on a lost race (already
-- accepted / declined / expired) — the frontend maps false to
-- "The restaurant has already accepted your order." + refetch.

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid)
RETURNS boolean AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.orders
  SET status = 'cancelled'
  WHERE id = p_order_id
    AND customer_id = auth.uid()
    AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

After applying: regenerate types (`npx supabase gen types typescript --local` → `src/types/database.ts`) so the `order_status` enum gains `'cancelled'`. Until regen lands, the placeholder enum in `database.ts` must be edited by hand — `OrderStatus` in `models.ts` derives from it.

### 2.3 Frontend — customer side

All changes in `src/pages/orders/` plus one new modal component.

**`OrderStatus.tsx`**
- `STATUS_MESSAGES` gains `cancelled: "You cancelled this order."` and `TERMINAL` gains `"cancelled"`. The status card renders it neutrally (customer's own action — **not** the red error treatment used for `declined`/`expired`), with a *"Order again"* link to `/restaurants` mirroring the expired-state CTA.
- While `status === 'pending'`, render a **"Cancel order"** button (ghost/danger style) under the status card, with helper copy: *"You can cancel until the restaurant accepts."*
- Clicking opens **`CancelOrderModal`** (new, co-located) mirroring `ConfirmOrderModal` / `DeclineModal` patterns exactly: focus restoration, ESC, backdrop click, body scroll lock, errors rendered inside the modal. **Default focus on "Keep my order"** — the same fat-finger-Enter defence `ConfirmOrderModal` uses, pointed the safe way.
- Confirm handler: `supabase.rpc('cancel_order', { p_order_id: id })`.
  - `data === true` → optimistically set local `status = 'cancelled'`, close modal. The Realtime UPDATE echo merges the same value — idempotent.
  - `data === false` → lost race. Show *"The restaurant has already accepted your order."* inside the modal (or as the close-out message) and refetch the order so the page reflects the live status.
  - Error → `humaniseSupabaseError`, rendered inside the modal so retry doesn't require reopening (same rule as `ConfirmOrderModal`).
- The page already subscribes to Realtime UPDATEs and spreads `payload.new` — a cancellation made in another tab flips this page with no extra work. The button must be derived from `order.status` (it is, by construction) so it disappears the instant the status leaves `pending` for *any* reason.

**`OrderHistory.tsx`** — `badgeClass` gains a `cancelled` case. Use a new neutral grey badge class (`ohist__badge--neutral`), not the red error class: a cancellation is the customer's own action, not a failure.

**`Checkout.tsx` / `ConfirmOrderModal.tsx`** (copy only) — the confirm modal's framing can now soften: a line like *"You can still cancel before the restaurant accepts."* The modal's place as the deliberate-click safety net is unchanged; cancellation is a second net, not a replacement.

### 2.4 Frontend — owner dashboard

All changes in `src/pages/dashboard/`.

- **`utils.ts`** — `HISTORY_STATUSES` gains `"cancelled"`; `historyStatusLabel` returns `{ label: "Cancelled", variant: "neutral" }` for it.
- **`OwnerDashboard.tsx`** Realtime UPDATE handler — extend the existing `expired` branch to `status === "expired" || status === "cancelled"` (identical mechanics: find in `pendingOrdersRef`, snapshot into `HistoryOrder`, remove from pending). For `cancelled` only, additionally `showToast("warning", "Order cancelled by the customer.")` — the owner may be looking straight at the card when it vanishes.
- **No changes** to `handleAccept` / `handleDeclineConfirm` — their 0-row race path already covers "customer cancelled first" via the generic *"no longer pending"* toast + refetch.
- **`HistorySection`** — renders the new label/variant; no structural change.

---

## 3. Feature B — Owner-Set Delivery ETA

### 3.1 Decisions & constraints

#### 3.1.1 The duration means **time to the customer's door**, not kitchen prep time

Restaurants handle their own delivery (v1 business rule), and the customer cares about one number: *when does food arrive*. An owner-facing "prep time" that silently excludes the ride would systematically under-promise. The owner-side picker is therefore labelled in door terms (*"How long until this order reaches the customer?"*) and the customer-side copy says **"Arriving"**, never "ready".

#### 3.1.2 Selected at **accept time**, as part of the accept action

The owner knows the realistic total time only when looking at the actual items + current kitchen load — exactly the moment they tap Accept. Decision: tapping **Accept** opens a small **`AcceptOrderModal`** (mirroring `DeclineModal` mechanics) with preset duration chips; confirming performs the accept UPDATE with the ETA in the same statement. One atomic write, one Realtime event, no second decision point.

Cost: accept goes from one tap to two. Mitigation: a **default chip is preselected (30 min)** so the fast path is *Accept → Confirm* with zero extra thought. A per-restaurant default or "remember last choice" is a v2 nicety (§9).

#### 3.1.3 Presets only — `20 / 30 / 45 / 60` minutes, no free-text

Free-text minutes invite typos (3 instead of 30) that become broken promises on the customer's screen. Four chips cover the realistic Gudha Gorji delivery range; the DB CHECK (`BETWEEN 10 AND 120`, §3.2) deliberately stays looser than the UI so adding a chip later (15? 90?) is frontend-only.

#### 3.1.4 Storage — `eta_minutes` (the choice) + `accepted_at` (server-stamped anchor)

```
orders.eta_minutes  integer      — what the owner chose; snapshot, immutable once set
orders.accepted_at  timestamptz  — when pending → accepted committed; trigger-stamped
```

Promise time is **derived**: `accepted_at + eta_minutes`. Why not store a `promised_at` timestamp directly? Because the client would have to compute it (`supabase-js` can't send `now() + interval` through `.update()`), making the promise hostage to the owner device's clock. A trigger stamps `accepted_at = now()` server-side (§3.2), the owner's write carries only the small integer, and both raw facts stay queryable for v2 analytics (*promised vs actual delivery time per restaurant* — the future report that justifies keeping `eta_minutes` rather than only a timestamp).

`updated_at` is **not** a usable anchor — it moves on every subsequent status progression.

#### 3.1.5 Enforcement at the transition, not via a table CHECK

A table-level `CHECK (status requires eta_minutes)` would break existing pre-feature rows (old accepted/completed orders have `NULL`) and — even as `NOT VALID` — would trip on *status progressions of orders accepted before the deploy*, because Postgres re-checks NOT-VALID constraints on every UPDATE. Instead, the requirement lives **in the accept-stamping trigger** (§3.2): `pending → accepted` with `eta_minutes IS NULL` raises. Pre-feature in-flight orders progress untouched (they never re-enter `pending`), and new accepts can't skip the ETA even if a stale client tries.

The same trigger makes `eta_minutes` and `accepted_at` immutable once set — the snapshot rule this codebase already applies to `unit_price` and `discount_amount`. "Owner extends the ETA when running late" is a real future feature, deferred deliberately (§9) — it needs its own customer-facing "ETA updated" treatment to not feel like gaslighting.

#### 3.1.6 Customer display — a window, not a point; never a negative countdown

A single minute ("arriving in 34 min") reads as precision nobody can deliver. The customer page shows:

- **Window:** `eta_minutes` to `eta_minutes + 10` → *"Arriving in 30–40 min"* — the fixed +10 buffer is display-only (under-promise lives in the UI layer; the DB stores the owner's actual choice).
- **Anchor time:** *"by ~7:45 PM"* using the **window end** (`accepted_at + eta + 10 min`), formatted IST like every other timestamp.
- **Overdue:** once `now()` passes the window end and the order isn't `completed`, the banner swaps to *"Taking a little longer than expected — your food is still on the way."* Never `-5 min`. No auto-escalation in v1.

Shown for `accepted`, `preparing`, and `out_for_delivery`. Hidden for terminal states and for pre-feature orders (`eta_minutes IS NULL` → render nothing, exactly today's behaviour). A 60 s `setInterval` tick re-renders the banner across the on-track → overdue boundary — same lightweight-tick pattern as `DiscountConfigContext`.

The pure math + state goes in **`src/lib/eta.ts`** (`computeEtaWindow(acceptedAt, etaMinutes, nowMs)`) so it's unit-testable — same extraction rationale as `geo.ts` and `pricing.ts`.

#### 3.1.7 Owner accountability — the promise shows on the active card too

`ActiveOrderCard` gets one line: *"Promised by 7:45 PM"*, flipping to an overdue style after the window ends. The owner made the promise; the dashboard should keep it in view. (This also means the existing `ACTIVE_ORDER_SELECT` and `ActiveOrder` type grow the two new fields.)

#### 3.1.8 What needs **no** change

- **Realtime** — `orders` is already in the publication (006); new columns ride along on UPDATE payloads, and `OrderStatus.tsx` already spreads `payload.new`, so a customer staring at the pending screen sees the ETA banner appear the moment the owner confirms. Zero wiring.
- **RLS** — owners already hold the UPDATE policy used for accept; customers/owners already SELECT these rows. The actor-gating in §2.1.7 doesn't conflict (cancel touches only `status`).
- **`place_order`, pricing, SMS backstop, expiry cron** — untouched.

### 3.2 Migration — `014_order_eta.sql`

```sql
-- ============================================================
-- 014_order_eta.sql
-- Owner-selected delivery ETA, chosen at accept time.
--   (1) orders.eta_minutes + orders.accepted_at
--   (2) stamp_order_accept trigger: requires eta on
--       pending → accepted, stamps accepted_at server-side,
--       makes both columns immutable once set
-- Promise time is derived (accepted_at + eta_minutes); the +10 min
-- display buffer is frontend-only. See
-- src/docs/customer_cancellation_and_eta_plan.md.
-- ============================================================

-- ── 1. Columns ────────────────────────────────────────────────
-- eta_minutes: owner's choice, snapshot semantics (like
-- discount_amount / unit_price). CHECK range is wider than the
-- UI's 20/30/45/60 chips on purpose — adding a chip later is
-- frontend-only. NULL = pre-feature order or not yet accepted.
ALTER TABLE public.orders
  ADD COLUMN eta_minutes integer
    CHECK (eta_minutes IS NULL OR eta_minutes BETWEEN 10 AND 120),
  ADD COLUMN accepted_at timestamptz;

COMMENT ON COLUMN public.orders.eta_minutes IS
  'Owner-promised minutes from acceptance to delivery at the door. '
  'Set once at accept (required by stamp_order_accept), immutable. '
  'NULL on pre-feature and never-accepted orders.';
COMMENT ON COLUMN public.orders.accepted_at IS
  'Server-stamped at the pending → accepted transition. Anchor for '
  'the customer-facing arrival window (accepted_at + eta_minutes).';

-- ── 2. Accept-stamping trigger ────────────────────────────────
-- Enforcement lives HERE, not in a table CHECK: a CHECK (even
-- NOT VALID) is re-evaluated on every UPDATE, so it would block
-- status progressions of orders accepted before this deploy
-- (which legitimately have NULL eta). The trigger fires only on
-- the transition itself, so in-flight pre-feature orders progress
-- untouched while every NEW accept must carry an ETA.

CREATE OR REPLACE FUNCTION public.stamp_order_accept()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    IF NEW.eta_minutes IS NULL THEN
      RAISE EXCEPTION 'ETA_REQUIRED: eta_minutes must be set when accepting an order';
    END IF;
    NEW.accepted_at := now();
    RETURN NEW;
  END IF;

  -- Snapshot rule: once set, neither field moves (same contract
  -- as unit_price / discount_amount). Silently restore rather than
  -- raise so unrelated UPDATEs that echo stale values stay safe.
  IF OLD.eta_minutes IS NOT NULL THEN
    NEW.eta_minutes := OLD.eta_minutes;
  END IF;
  IF OLD.accepted_at IS NOT NULL THEN
    NEW.accepted_at := OLD.accepted_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stamp_order_accept
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.stamp_order_accept();
```

After applying: regenerate `src/types/database.ts` (or hand-extend the placeholder) and add `eta_minutes: number | null` + `accepted_at: string | null` to `Order` in `src/types/models.ts`.

### 3.3 Frontend — owner dashboard

- **`AcceptOrderModal.tsx`** (new, `src/pages/dashboard/`) — mirrors `DeclineModal` mechanics one-for-one (autofocus, ESC, backdrop click, body scroll lock, focus restoration, internal error banner). Content: title *"How long until this order reaches the customer?"*, four radio-style chips (`20 / 30 / 45 / 60 min`) with **30 preselected**, primary button *"Accept order"*, ghost button *"Go back"*. Driven by `acceptingId` state in `OwnerDashboard` exactly the way `decliningId` drives `DeclineModal`.
- **`OwnerDashboard.tsx`** — `handleAccept(orderId)` becomes `setAcceptingId(orderId)` (opens the modal); the actual mutation moves into `handleAcceptConfirm(etaMinutes: number)`:
  ```ts
  .update({ status: "accepted", eta_minutes: etaMinutes })
  .eq("id", orderId).eq("status", "pending")
  .select("id, status, eta_minutes, accepted_at")
  ```
  Everything downstream is the existing pattern: 0 rows → lost-race toast + refetch; success → optimistic move to Active carrying `eta_minutes` + the returned `accepted_at`. (Note the `.select()` now returns the trigger-stamped `accepted_at` — use it rather than `Date.now()` so the card and the customer page agree.)
- **`utils.ts` / `types.ts`** — `ACTIVE_ORDER_SELECT` gains `eta_minutes, accepted_at`; `ActiveOrder` gains both fields. `PENDING_ORDER_SELECT` unchanged (pending orders have no ETA yet).
- **`ActiveOrderCard.tsx`** — one `acard__promise` line: *"Promised by {formatIstTime(windowEnd)}"*, with an `is-overdue` modifier class past the window. Reuses `computeEtaWindow` from `src/lib/eta.ts` and the dashboard's existing per-second/minute tick economy (a 60 s tick at the section level is enough; do **not** join the 1 s pending-countdown ticker).

### 3.4 Frontend — customer side

- **`src/lib/eta.ts`** (new) —
  ```ts
  interface EtaWindow {
    windowStartMin: number;   // eta_minutes
    windowEndMin: number;     // eta_minutes + ETA_BUFFER_MIN (10)
    promisedBy: Date;         // accepted_at + windowEndMin
    state: "on-track" | "overdue";
  }
  function computeEtaWindow(acceptedAtIso: string, etaMinutes: number, nowMs: number): EtaWindow
  ```
  Pure, no Supabase, fully unit-tested (§6).
- **`OrderStatus.tsx`** — fetch already uses `select("*")` so the new columns arrive for free. When `status ∈ {accepted, preparing, out_for_delivery}` and `eta_minutes != null`:
  - on-track: an ETA banner under the status card — **"Arriving in 30–40 min · by ~7:45 PM"**;
  - overdue: *"Taking a little longer than expected — your food is still on the way."*;
  - 60 s tick to cross the boundary without a refresh; Realtime UPDATE delivers the initial appearance live.
  - `eta_minutes == null` (pre-feature / not yet accepted) → no banner, today's rendering exactly.

---

## 4. Cross-Feature Notes

- **The accept modal vs the cancel button.** The owner can be inside `AcceptOrderModal` choosing a chip while the customer cancels. The confirm's conditional UPDATE matches 0 rows → the existing lost-race toast fires and the modal closes. No new handling — this is just §2.1.6 with a modal in front of it.
- **`cancelled` orders never carry an ETA** (`eta_minutes` only gets set on the accept path, and cancel is pending-only). No display interaction exists.
- **Stale clients during rollout.** The PWA's `skipWaiting`/`clientsClaim` config means one reload picks up the new bundle. Until then: an old *customer* client simply lacks the cancel button and ETA banner (additive, harmless); an old *owner* client ignores a `cancelled` Realtime payload, leaving a ghost pending card whose Accept/Decline then hits the 0-row race path — degraded but safe. An old owner client accepting **without** `eta_minutes` is blocked by the trigger (`ETA_REQUIRED`), surfacing as the generic *"Couldn't accept"* toast — acceptable for the minutes-long window, and the reason migration 014 should be applied together with (not days before) the frontend deploy.

---

## 5. File-Touch Summary

| Area | File | Change |
|---|---|---|
| DB | `supabase/migrations/012_order_status_cancelled.sql` | new — enum value only |
| DB | `supabase/migrations/013_customer_cancellation.sql` | new — transition trigger v2 + `cancel_order` RPC |
| DB | `supabase/migrations/014_order_eta.sql` | new — `eta_minutes`, `accepted_at`, `stamp_order_accept` trigger |
| Types | `src/types/database.ts` | regen (`'cancelled'` enum value) |
| Types | `src/types/models.ts` | `Order` + `eta_minutes`, `accepted_at` |
| Lib | `src/lib/eta.ts` (+ `eta.test.ts`) | new — `computeEtaWindow` |
| Customer | `src/pages/orders/OrderStatus.tsx` (+ `.css`) | cancel button + modal wiring, `cancelled` status copy, ETA banner, 60 s tick |
| Customer | `src/pages/orders/CancelOrderModal.tsx` (+ `.css`) | new — mirrors `ConfirmOrderModal` patterns, default focus "Keep my order" |
| Customer | `src/pages/orders/OrderHistory.tsx` (+ `.css`) | neutral `cancelled` badge |
| Customer | `src/pages/checkout/ConfirmOrderModal.tsx` | copy: "you can still cancel before the restaurant accepts" |
| Owner | `src/pages/dashboard/AcceptOrderModal.tsx` (+ `.css`) | new — ETA chips, mirrors `DeclineModal` |
| Owner | `src/pages/dashboard/OwnerDashboard.tsx` | accept flow via modal + `eta_minutes`; Realtime `cancelled` branch + toast |
| Owner | `src/pages/dashboard/ActiveOrderCard.tsx` (+ `.css`) | "Promised by …" line + overdue style |
| Owner | `src/pages/dashboard/utils.ts` | `HISTORY_STATUSES` + `historyStatusLabel` + `ACTIVE_ORDER_SELECT` |
| Owner | `src/pages/dashboard/types.ts` | `ActiveOrder` + `eta_minutes`, `accepted_at` |
| Tests | `src/pages/dashboard/utils.test.ts` | `historyStatusLabel('cancelled')` |
| Docs | `CLAUDE.md`, `GEMINI.md` | see §7 |

---

## 6. Testing

Stays inside the v1 testing philosophy (high-risk pure logic only, no mocked Supabase):

- **`src/lib/eta.test.ts`** — `computeEtaWindow`: window math (30 → 30–40), `promisedBy` derivation, on-track/overdue exactly at the boundary minute, and a pre-feature guard isn't needed (callers gate on `eta_minutes != null`).
- **`src/pages/dashboard/utils.test.ts`** — `historyStatusLabel("cancelled")` → `{ label: "Cancelled", variant: "neutral" }`.
- **DB behaviour** (trigger actor-gating, RPC races, ETA_REQUIRED, immutability) falls under the deferred real-Supabase integration suite (`phase4_stabilisation_plan.md` §3.2) — verified manually via the checklist below for now.

### Manual verification checklist

1. Customer places order → `/orders/:id` shows the Cancel button; cancel → status flips to *"You cancelled this order."*; owner dashboard pending card disappears with the *"cancelled by the customer"* toast; row appears in Today's History as **Cancelled** (neutral badge); no SMS arrives a minute later.
2. Two windows: owner accepts a split-second before the customer confirms cancel → customer sees *"already accepted"*, page shows accepted + ETA. Repeat inverted: cancel first → owner gets the lost-race toast.
3. Owner accepts: modal shows chips, 30 preselected; confirm → customer page (already open on pending) live-updates to the ETA banner with the right IST time; active card shows *"Promised by …"*.
4. SQL editor as owner session: `UPDATE orders SET status='cancelled' …` on a pending order → raises *"Only the customer can cancel an order"*. `UPDATE … SET status='accepted'` without `eta_minutes` → raises `ETA_REQUIRED`. `UPDATE … SET eta_minutes = 99` on an accepted order → value silently restored.
5. Pre-feature in-flight order (accepted before 014): progress it through to completed → no trigger errors, no ETA banner on the customer page.
6. Let the window lapse (small test ETA or temporary trigger edit) → both customer banner and active card flip to overdue copy; no negative numbers anywhere.
7. `npm test` green; `npm run lint` clean; `npm run build` succeeds.

---

## 7. Documentation Housekeeping (part of the PRs, not optional)

- **`CLAUDE.md`** — multiple load-bearing statements become false and must be updated: the status-flow line (*"No cancellation"* → add `pending → cancelled (customer)`); the `/checkout` route note (*"There's no order cancellation in v1"*); the v2-deferred list (remove *order cancellation*); the Database critical-rules section (add `cancel_order` RPC + `eta_minutes`/`accepted_at` snapshot rules + `stamp_order_accept`); the `/orders/:id` route row (ETA banner + cancel). **`GEMINI.md`** mirrors all of it.
- **`src/docs/v2_deferred_issues.md`** — add the new deferrals from §9.
- Migration headers cross-reference this document (already in the SQL above).

---

## 8. Rollout

- Two PRs, independent, either order: `feat/customer-cancel-order` (012 + 013 + customer/owner cancellation UI) and `feat/order-eta` (014 + accept modal + banners). If ETA merges first, renumber its migration to 012 and shift cancellation to 013/014 — numbering follows merge order.
- The Supabase↔GitHub integration applies migrations on each PR's preview branch; remember (per `cloud.md` memory) that **secrets and pg_cron do not carry over to preview branches** — irrelevant here (no new secrets/cron), but the SMS-backstop part of checklist item 1 only proves out against production-like env.
- Apply each migration set and its frontend deploy **together** (§4 stale-client note), outside peak hours (12–2 PM, 7–9:30 PM IST).

---

## 9. Recommendations Adopted & v2 Deferrals

Adopted in this design (beyond the literal request):

1. **Pending-only cancellation with no reason field** — the rule is free for restaurants and trivially explainable to customers.
2. **RPC instead of a customer UPDATE policy** — a direct RLS path would hand customers accept/decline forgery (§2.1.5).
3. **Actor-gated transition trigger** — owners can't disguise a decline as a customer cancellation (§2.1.7).
4. **ETA means door-arrival, not prep** — and is shown as a buffered **range** (under-promise, over-deliver) rather than a false-precision single minute.
5. **Server-stamped `accepted_at`** — the promise anchor never depends on a phone's clock.
6. **Preset chips with a preselected default** — keeps owner friction at effectively one extra tap.
7. **Promise visible on the owner's active card** — accountability for the number they chose.

Deferred to v2 (log in `v2_deferred_issues.md`):

- **"Running late" ETA extension** — owner bumps the promise once, customer sees an explicit *"ETA updated"* state. Needs the immutability rule relaxed deliberately, not accidentally.
- **Post-acceptance cancellation grace window** (e.g. 60 s after accept) — reopens the food-waste question; only worth it with data showing demand.
- **Cancellation abuse controls** — place/cancel cycles still chime the owner each time; add rate limiting or a daily cancellation cap if analytics (`SELECT count(*) FROM orders WHERE status='cancelled' GROUP BY customer_id`) show a problem.
- **Customer SMS on accept** ("your order arrives by 7:45 PM") — new DLT template + per-order SMS cost; the in-app Realtime banner covers the open-tab case free.
- **Per-restaurant default ETA chip / remember-last-choice** — micro-optimisation of the accept modal.
- **Promised-vs-actual delivery analytics** — `accepted_at + eta_minutes` vs `updated_at` of the `completed` transition; both columns were kept raw precisely to enable this.
