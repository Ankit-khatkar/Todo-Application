# Owner Menu Management — Feature Plan

> **Status:** Planning
> **Type:** New feature (reverses a documented v1 constraint)
> **Route:** `/dashboard/menu` (owner-only)
> **Reference:** `phase2_owner_dashboard_plan.md`, `phase2_owner_dashboard_ux_ui.md`, `v2_deferred_issues.md` §1–§2, `CLAUDE.md`
> **Migrations touched:** new `007_owner_menu_management.sql` (menu_items owner RLS + `restaurants.image_bucket` column + `storage.objects` policies)

---

## 0. Goal & Scope

Let a restaurant owner manage their own menu from inside the app instead of waiting for Ankit to edit rows / upload images via the Supabase Dashboard. Concretely the owner can:

1. **Add a new dish** — name, description, price, veg/non-veg, optional image.
2. **Edit** a dish's name, description, or price.
3. **Upload / replace a dish image.**
4. **Mark a dish veg or non-veg.**
5. **Enable / disable a dish** (out-of-stock toggle) — the operational fast-path during service.

### What this changes vs. v1

`CLAUDE.md` and `redlotusfoods_documentation.md` §4.8 currently state: *"Owners cannot edit menu items in v1 (admin-managed via Supabase Dashboard)."* This feature **intentionally lifts that restriction** for the owner's *own* restaurant. The admin-managed path (`menu_items_admin_all`) stays exactly as-is; we only **add** owner write access scoped by RLS.

### Out of scope (deferred)

- **Menu categories / sections** — flat menu stays (v1 rule; `RestaurantMenu.tsx` renders a flat list).
- **Hard delete of dishes** — see §2.2. The out-of-stock toggle is the v1 "remove from menu" mechanism.
- **Storage re-architecture** — the existing one-bucket-per-restaurant layout is kept as-is (see §3). Consolidating into a single shared bucket with per-restaurant folders is a possible v2 cleanup, noted in §11.
- **Bulk import / CSV, drag-to-reorder, price scheduling, multi-image galleries.**
- **Realtime menu propagation to live customer tabs** — customers pick up menu changes on their next page load (§7).

---

## 1. Backend Alignment — `menu_items` (no table change)

Everything the feature needs already exists on `menu_items` (migration 001):

| Column | Type / constraint | Relevance |
|---|---|---|
| `name` | `text NOT NULL` | Required on add. |
| `description` | `text` (nullable) | Optional. |
| `price` | `numeric(10,2) NOT NULL CHECK (price > 0)` | DB rejects ≤ 0 — frontend mirrors. |
| `image_url` | `text` (nullable) | Holds the full Storage public URL. Nullable → image optional. |
| `is_veg` | `boolean NOT NULL` | No default — **must** be supplied on insert. |
| `is_available` | `boolean NOT NULL DEFAULT true` | The enable/disable toggle. |
| `updated_at` | `timestamptz` | Auto-bumped by `set_menu_items_updated_at` trigger (003) on every UPDATE. |
| `restaurant_id` | `uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE` | Ownership anchor for RLS. |

Two existing safeguards make the **disable** action a complete kill-switch with zero new code:

1. **`menu_items_customer_select`** (002) filters `is_available = true` — a disabled dish vanishes from the customer menu on their next fetch.
2. **`validate_order_item`** trigger (003) raises *"Menu item is currently unavailable"* on any `order_items` INSERT for an `is_available = false` item — so even a stale customer cart can't order a just-disabled dish. `place_order` (006) inserts `order_items` inside its transaction, so the raise aborts the whole order.

The **price snapshot model** keeps edits safe for history: `order_items.unit_price` is frozen at order time (001 + 006), so past orders never change. New orders read the live `menu_items.price` inside `place_order`. See §6.2 for the mid-session edge case.

---

## 2. Owner Write RLS for `menu_items`

Today owners have **SELECT only** on `menu_items` (`menu_items_owner_select`, 002:135). No INSERT/UPDATE/DELETE policy exists for the authenticated owner role, so every write 403s. Migration 007 adds narrowly-scoped policies.

### 2.1 Decision: RLS-based direct writes, not a SECURITY DEFINER RPC

`v2_deferred_issues.md` §1 prefers an RPC for `restaurants` because owners must be blocked from editing *most* columns (only `is_open` is theirs). **Menu items are different — the entire row legitimately belongs to the owner.** There's no column to protect; the only thing to enforce is *"this row's `restaurant_id` is a restaurant you own,"* which a row-scoped RLS policy expresses cleanly. Direct `.from('menu_items').insert/update()` calls are simpler and mirror how the open/close toggle already writes `restaurants` directly.

The one subtlety: an UPDATE must validate ownership on **both** the old and new row, so an owner can't re-parent an item to a restaurant they don't own — that's `USING` (old row) **+** `WITH CHECK` (new row).

```sql
-- ── menu_items: owner write access (007) ─────────────────────
CREATE POLICY menu_items_owner_insert ON public.menu_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.id = menu_items.restaurant_id AND r.owner_id = auth.uid())
  );

CREATE POLICY menu_items_owner_update ON public.menu_items
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.id = menu_items.restaurant_id AND r.owner_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.id = menu_items.restaurant_id AND r.owner_id = auth.uid())
  );
```

**`is_active` note:** these policies let an owner edit menu items even while their restaurant is `is_active = false` or `is_open = false` — intentional, so owners can prep/edit before going live. Customer visibility is still gated by `menu_items_customer_select` (active+open), so nothing leaks early.

### 2.2 Delete — keep it disabled in v1

`order_items.menu_item_id ... ON DELETE RESTRICT` (001:93) blocks deleting any dish that has ever been ordered → Postgres `23503`. **Recommendation: do not add a DELETE policy or expose delete in this feature.** The out-of-stock toggle is the "remove from menu" mechanism. If product later insists on delete:

- Add `menu_items_owner_delete` (same `USING` predicate) **and** catch `23503` in the UI: *"This dish has past orders, so it can't be deleted. Disable it instead to hide it from customers."*
- The cleaner long-term answer is a soft-delete column (`is_archived boolean NOT NULL DEFAULT false`) filtered out of customer + owner menu queries — a schema add; defer unless needed.

---

## 3. Image Upload — Supabase Storage (one bucket per restaurant)

### 3.0 Current setup (confirmed with Ankit)

Storage is **already in production** — my earlier "no storage exists" assumption was wrong (the `picsum.photos` URLs in `seed.sql` are placeholder seed data, not the live onboarded data). The real layout:

- **One public bucket per restaurant**, named after the restaurant — e.g. `Gudha Delight Menu` (human name, **contains spaces**).
- Images live at the **bucket root**, e.g. `specialcrispycorn.jpg`. No subfolders.
- **Public read** (any visitor can view any menu image — the customer menu `<img>` needs this).
- **120 KB** size limit per image.
- 8 restaurants → 8 buckets, all **admin-created at onboarding** via the Dashboard.
- Example URL: `https://umsqskeqmwbmvrfvyrbl.supabase.co/storage/v1/object/public/Gudha%20Delight%20Menu/specialcrispycorn.jpg`

Config is Dashboard-managed (`supabase/config.toml` says so) — none of it is in the repo, which is why the bucket name/limit aren't discoverable from code.

**Decision:** keep this model. Leave existing images untouched. New owner uploads go into the *same* per-restaurant bucket. (One-bucket-per-restaurant has scaling quirks — bucket-count limits, a new bucket per onboarding — but re-architecting it is out of scope; see §11.)

### 3.1 The RLS problem this model creates → `restaurants.image_bucket`

Owner-write isolation must enforce *"owner X may write only to **their** restaurant's bucket."* But the bucket is identified by a human string (`Gudha Delight Menu`) that RLS cannot derive from `auth.uid()`, and there's no convention linking it to `restaurant_id`. We need an explicit mapping.

**Add `restaurants.image_bucket text` and backfill the 8 existing rows** (007):

```sql
-- ── restaurants: map each restaurant to its image bucket (007) ─
ALTER TABLE public.restaurants ADD COLUMN image_bucket text;

-- Backfill the 8 existing restaurants with their actual bucket ids.
-- Bucket names are arbitrary human strings, so do this per row, e.g.:
-- UPDATE public.restaurants SET image_bucket = 'Gudha Delight Menu'
--   WHERE id = '<gudha-delight-restaurant-id>';
-- ... repeat for the other 7.
```

Going forward, onboarding sets `image_bucket` whenever Ankit creates the restaurant's bucket. The frontend fetches it with the restaurant row and uses it as the upload target (§5.4).

> **In a Supabase bucket created via the Dashboard, the bucket `id` equals its `name`** — so `image_bucket` stores `'Gudha Delight Menu'` and storage RLS matches it against `storage.objects.bucket_id` directly.

### 3.2 Buckets are admin-created — owners only upload

Creating a bucket needs `service_role` (Dashboard). **Owners never create buckets** — they upload into the bucket Ankit created at onboarding. The self-serve flow therefore assumes `restaurants.image_bucket` is already set. If it's `null`, the editor **disables image upload** and shows *"Image upload isn't set up yet — please contact admin."* (same human-fix philosophy as `OnboardingIncomplete`). The dish can still be added/edited text-only.

### 3.3 Storage RLS (`storage.objects`)

Public read (matches today's "anyone can view"); owner write only to their mapped bucket.

```sql
-- Public read for any menu bucket. (Public buckets already serve objects
-- over the public URL without RLS; this SELECT policy only governs the
-- authenticated list/download API — keep it permissive to match today.)
CREATE POLICY "menu_images_public_read" ON storage.objects
  FOR SELECT USING (
    bucket_id IN (SELECT image_bucket FROM public.restaurants
                  WHERE image_bucket IS NOT NULL)
  );

-- Owner may write only inside the bucket mapped to a restaurant they own.
CREATE POLICY "menu_images_owner_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.owner_id = auth.uid()
              AND r.image_bucket = storage.objects.bucket_id)
  );

CREATE POLICY "menu_images_owner_update" ON storage.objects   -- replace/upsert
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.owner_id = auth.uid()
              AND r.image_bucket = storage.objects.bucket_id)
  );

CREATE POLICY "menu_images_owner_delete" ON storage.objects   -- remove image
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.restaurants r
            WHERE r.owner_id = auth.uid()
              AND r.image_bucket = storage.objects.bucket_id)
  );
```

> These policies live on `storage.objects`. Put them in `007` for reproducibility (fresh environments otherwise silently lose owner upload ability), **and** verify against what's already configured in the Dashboard so you don't create conflicting policies on a bucket that already has some.

### 3.4 Path / file naming for NEW uploads

Existing files are arbitrary names at the bucket root (`specialcrispycorn.jpg`) — left as-is. For **new** owner uploads, name the object by `menu_item_id` so replace is idempotent and collisions are impossible:

```
{image_bucket}/{menu_item_id}.{ext}      e.g.  Gudha Delight Menu/3f9c1a....webp
```

The bucket name has spaces — the JS client encodes them; `supabase.storage.from("Gudha Delight Menu")` works directly. The stored `image_url` is the full public URL (+ cache-buster, §3.6), consistent with how existing rows store full URLs.

### 3.5 120 KB limit → client-side compression is mandatory

120 KB is small; a raw phone photo (2–5 MB) is rejected outright by the bucket limit. `ImageUploader` **must** compress before upload:

1. Downscale to a max longest edge (~800–1000 px is plenty for a menu thumbnail).
2. Re-encode to **WebP** (best ratio; falls back to JPEG on old Safari) via a `<canvas>`.
3. **Iterate quality down** until the blob is **< ~115 KB** (headroom under 120 KB). If it can't get under even at minimum quality, reject: *"Couldn't compress this image under 120 KB — try a simpler or smaller photo."*

Sketch in §5.4. This keeps the owner from hitting an opaque storage 413 and matches the constraint the bucket already enforces.

### 3.6 Replace & remove

- **Replace image:** `upload(path, blob, { upsert: true })` overwrites the same `{menu_item_id}.{ext}` key. Public URL is stable, so cache-bust `image_url` with `?v=${Date.parse(updated_at)}` (or `Date.now()`) so customers' browsers refetch.
- **Remove image (keep dish):** set `image_url = null` and best-effort `remove([path])` the object (orphans are harmless/cheap if the delete fails).

---

## 4. TypeScript Types

`MenuItem` already exists in `src/types/models.ts` (29–40) with every field — **no menu model change**. Add the new column to the `Restaurant` interface:

```ts
// src/types/models.ts — Restaurant
image_bucket: string | null;   // per-restaurant Storage bucket id; null = upload not set up
```

After applying 007, optionally regenerate generated types:

```bash
npx supabase gen types typescript --local > src/types/database.ts
```

Local write-DTO for the menu feature:

```ts
// src/pages/dashboard/menu/types.ts
export interface MenuItemDraft {
  name: string;
  description: string;   // '' → store as null
  price: number;         // > 0
  is_veg: boolean;
  is_available: boolean;
}
export type MenuItemRow = MenuItem; // from types/models
```

---

## 5. Frontend Architecture

### 5.1 Placement — dedicated route, not a dashboard section

The Owner Dashboard (`/dashboard`) is an **operational cockpit** (`phase2_owner_dashboard_ux_ui.md` §0: glanceable, real-time, one action per card, refresh-is-a-bug). Menu management is the opposite — occasional, form-heavy config. Bolting a CRUD editor onto the orders page violates "Pending must be visible without switching views."

**Recommendation:** a dedicated owner-only route **`/dashboard/menu`**, lazy-loaded (consistent with the code-split routes in `App.tsx`), reachable via a **"Manage Menu"** link in `RestaurantHeader` (and/or the owner Navbar state). Orders cockpit stays untouched. (Open decision — §11.)

### 5.2 Routing & guard

```tsx
// src/App.tsx — inside the existing <Suspense>
const MenuManager = lazy(() => import("./pages/dashboard/menu/MenuManager"));
// ...
<Route
  path="/dashboard/menu"
  element={
    <ProtectedRoute role="owner">
      <MenuManager />
    </ProtectedRoute>
  }
/>
```

### 5.3 File map (mirror the dashboard's component/CSS co-location)

```
src/pages/dashboard/menu/
  MenuManager.tsx     orchestrator: fetch owner restaurant (incl. image_bucket) + menu_items; owns state + handlers
  MenuManager.css
  MenuItemRow.tsx     one dish: thumbnail, name/price, veg dot, availability switch, Edit btn
  MenuItemRow.css
  MenuItemEditor.tsx  add/edit modal (mirrors DeclineModal: focus trap, ESC, backdrop, in-modal error, scroll lock)
  MenuItemEditor.css
  ImageUploader.tsx   file input + preview + canvas compression (<115 KB) + upload to restaurant.image_bucket
  types.ts            MenuItemDraft + helpers
  menuApi.ts          thin data layer: list / create / update / setAvailability / uploadImage / removeImage
  menuApi.test.ts     (optional) pure validation + compression-target helpers
```

Reuse: `humaniseSupabaseError` (`src/lib/errors.ts`), the dashboard `Toast` pattern, the veg/non-veg dot styling, and the Phase 2 design tokens (no new app-level stylesheet).

### 5.4 Data flows

**Resolve restaurant (incl. bucket) on mount** — same `.maybeSingle()` on `owner_id` as `OwnerDashboard.tsx`; null → reuse `OnboardingIncomplete`:

```ts
const { data: restaurant } = await supabase
  .from("restaurants")
  .select("id, name, cuisine_type, image_bucket")
  .eq("owner_id", user.id)
  .maybeSingle();
```

**List dishes** (owner SELECT returns disabled items too — the editor must show them):

```ts
await supabase
  .from("menu_items")
  .select("id, name, description, price, image_url, is_veg, is_available, updated_at")
  .eq("restaurant_id", restaurant.id)
  .order("name", { ascending: true });
```

**Add dish (insert row first, then optional image):**

```ts
const { data: row, error } = await supabase
  .from("menu_items")
  .insert({
    restaurant_id: restaurant.id,
    name, description: description || null,
    price, is_veg, is_available: true, image_url: null,
  })
  .select("id, name, description, price, image_url, is_veg, is_available, updated_at")
  .single();
// then, if a file was chosen and restaurant.image_bucket is set → uploadImage(row.id, file)
```

Insert-first avoids orphan images on a failed insert and yields a stable `{menu_item_id}` filename.

**Edit dish:**

```ts
await supabase
  .from("menu_items")
  .update({ name, description: description || null, price, is_veg })
  .eq("id", itemId)
  .select("...").single();   // updated_at auto-bumps via trigger
```

**Enable / disable (fast path, optimistic + rollback — mirrors the open/close toggle):**

```ts
setItems(prev => prev.map(i => i.id === id ? { ...i, is_available: next } : i));
const { error } = await supabase.from("menu_items")
  .update({ is_available: next }).eq("id", id);
if (error) { /* rollback + toast "Couldn't update. Try again." */ }
```

**Image upload (compress → upload to the restaurant's bucket → save URL):**

```ts
async function uploadImage(bucket: string, itemId: string, file: File, updatedAt: string) {
  const blob = await compressUnder(file, 115_000, 1000); // canvas downscale + quality loop
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const path = `${itemId}.${ext}`;                       // bucket root, named by item id
  const { error: upErr } = await supabase.storage
    .from(bucket)
    .upload(path, blob, { upsert: true, contentType: blob.type });
  if (upErr) throw upErr;
  const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(path);
  const image_url = `${publicUrl}?v=${Date.parse(updatedAt) || Date.now()}`;
  await supabase.from("menu_items").update({ image_url }).eq("id", itemId);
  return image_url;
}
// compressUnder: draw to <canvas> at scaled dims, canvas.toBlob('image/webp', q),
// step q from ~0.85 down until blob.size < target; reject if still over at min q.
```

### 5.5 Validation (frontend mirrors DB)

| Field | Rule | DB backstop |
|---|---|---|
| name | required, trim ≥ 1, ≤ ~80 chars | `NOT NULL` |
| description | optional, ≤ ~300 chars | nullable |
| price | number > 0, ≤ 2 decimals | `CHECK (price > 0)` |
| is_veg | required radio (veg / non-veg), no default | `NOT NULL` (insert fails if omitted) |
| image | optional; jpeg/png/webp in, compressed to < ~115 KB out | 120 KB bucket limit |

Never render raw `error.message` — route every failure through `humaniseSupabaseError`.

---

## 6. Edge Cases & Interactions

- **6.1 Disable propagation** — removes the dish from the customer menu next load (`menu_items_customer_select`) and blocks it at order time (`validate_order_item`). The trigger is the hard guarantee; no realtime needed.
- **6.2 Price edited mid-customer-session** — `place_order` (006) recomputes the subtotal from live `menu_items.price` and raises `PRICING_MISMATCH:` on >₹0.01 disagreement; `Checkout.tsx` surfaces *"Pricing updated — please review your order."* This is correct, pre-existing behaviour — exactly the scenario that guard exists for. Document, don't fight.
- **6.3 Dish disabled while in an open cart** — `place_order` → `order_items` INSERT → `validate_order_item` raises *"Menu item is currently unavailable."* Surfaced via `humaniseSupabaseError`.
- **6.4 Onboarding-incomplete owner** — no `restaurants` row → reuse `OnboardingIncomplete`.
- **6.5 `image_bucket` is null** — disable image upload with the contact-admin hint (§3.2); text-only add/edit still works.
- **6.6 Image upload fails after row insert** — row persists with `image_url = null` (customer menu renders fine without an image — `RestaurantMenu.tsx` only emits `<img>` when `image_url` is truthy). Toast + retry from the editor; no corruption.
- **6.7 Two tabs / concurrent edits** — single-owner, low-frequency; last-write-wins on the row is acceptable. No order-style race guard needed.
- **6.8 Restaurant inactive/closed** — editing works regardless; customer SELECT gates visibility, so nothing leaks.

---

## 7. Realtime (deferred)

Owner edits don't need realtime: the owner sees their own optimistic updates; customers pick up changes on next page load. If we later want live customer menus, add `menu_items` to the `supabase_realtime` publication (same `DO $$ … duplicate_object` pattern as 006:81-100) and subscribe in `RestaurantMenu.tsx`. Noted so it isn't rediscovered as a "bug."

---

## 8. UX / UI (aligned with Phase 2 tokens)

Inherit all tokens from `phase2_owner_dashboard_ux_ui.md` §5 — no new colours. Mobile-first.

**MenuManager page** — reuse the sticky header look (name + cuisine) with a "Manage Menu" context + back link to `/dashboard`. Primary CTA **`+ Add Dish`** (red `#D63031`). Single-column list of `MenuItemRow`s at all breakpoints.

**MenuItemRow**
```
┌───────────────────────────────────────────────┐
│ [img]  🟢 Paneer Tikka              ₹220      │
│        Cottage cheese, tandoor-grilled         │
│                         [ Available ●─ ]  Edit │
└───────────────────────────────────────────────┘
```
- Veg/non-veg dot reuses the customer convention (green square / red, FSSAI).
- **Availability switch** mirrors the open/close toggle (`RestaurantHeader.css`): red=available, grey=disabled. Optimistic 150 ms flip.
- Disabled dish: 0.6 opacity + "Out of stock" chip.
- `Edit` opens `MenuItemEditor`.

**MenuItemEditor (modal)** — mirror `DeclineModal` interaction rules: autofocus first field, ESC + backdrop close, focus restoration, in-modal error banner, submit spinner, body scroll lock. Fields: name, description (textarea), price (₹-prefixed numeric), veg/non-veg radio, `ImageUploader`, Save / Cancel.

**ImageUploader** — tap to pick → preview → **compress to < ~115 KB** (canvas) with a "Compressing…" state → upload on Save. When `image_bucket` is null, render disabled with the contact-admin hint. Show current image with Change / Remove affordances when editing.

**Empty state** — *"No dishes yet. Add your first dish so customers can start ordering."* + Add Dish CTA.

**Microcopy / toasts** (Phase 2 voice — direct, imperative):
| Action | Toast |
|---|---|
| Dish added | Dish added. |
| Dish updated | Changes saved. |
| Enabled | Dish is now available. |
| Disabled | Dish marked out of stock. |
| Image too large | Couldn't compress under 120 KB — try a simpler photo. |
| Error | Couldn't update. Try again. |

Accessibility: availability switch is `role="switch"` + `aria-checked` (same as open/close toggle); veg/non-veg via shape + label, not colour alone.

---

## 9. Testing

| Layer | What to test |
|---|---|
| menu_items RLS (manual SQL) | Owner A cannot INSERT/UPDATE a dish for B's restaurant (403). Owner CRUDs own. UPDATE can't re-parent `restaurant_id` (WITH CHECK). Customer can't write. |
| Storage RLS (per bucket) | Owner can upload only to *their* `image_bucket`; upload to another restaurant's bucket denied; anon can read any menu image; owner with null `image_bucket` can't upload. |
| Triggers | Disable → customer fetch omits it; order containing it → `validate_order_item` raises. Edit price → past `order_items.unit_price` unchanged; new order uses new price. |
| Frontend (Vitest, pure) | `MenuItemDraft` validation; compression target/ext helper; cache-buster builder. (Repo scope: pure logic only, no mocked Supabase.) |
| Compression (manual) | A 4 MB phone photo compresses under 120 KB and uploads; a pathological image that can't is rejected with the friendly message. |
| E2E (manual) | Add dish w/ image → shows on customer menu. Disable → gone for customer next reload. Edit name/price → reflected. Replace image → new image shows (cache-bust works). Null-bucket restaurant → upload disabled, text add works. Onboarding-incomplete owner → `OnboardingIncomplete`. |

---

## 10. Deployment Checklist

1. Apply `007_owner_menu_management.sql`: menu_items owner INSERT/UPDATE policies + `restaurants.image_bucket` column + the **per-row backfill** of the 8 existing buckets + `storage.objects` policies.
2. **Reconcile storage policies with the Dashboard** — the buckets already exist; confirm the new `storage.objects` policies don't conflict with any policy you set earlier. Confirm each bucket's 120 KB limit + public-read are intact.
3. Add `image_bucket` to the `Restaurant` interface in `src/types/models.ts`; optionally regen `database.ts`.
4. Deploy frontend (avoid peak hours 12–2 PM / 7–9:30 PM per `CLAUDE.md`).
5. **Onboarding runbook update:** when creating a new restaurant, Ankit also (a) creates its bucket, (b) sets `restaurants.image_bucket` to that bucket id. Without (b), owner image upload stays disabled.
6. Smoke test with a real seed owner: add → edit → upload (large photo) → disable → re-enable; verify the customer side in a second browser.
7. **Update docs on ship** (this reverses a stated v1 rule):
   - `CLAUDE.md` — RLS summary *"Owners cannot edit menu items in v1"* → owners manage their own menu via `/dashboard/menu`; add the route to the Routes table; document the per-restaurant `menu` buckets + `restaurants.image_bucket` in the Hosting/env section.
   - `GEMINI.md` — mirror.
   - `redlotusfoods_documentation.md` §4.8 — owner `menu_items` write policies + `image_bucket`.

---

## 11. Open Decisions (need your call)

1. **Placement:** dedicated `/dashboard/menu` route (recommended) vs. a collapsible section on `/dashboard`.
2. **Delete:** ship disable-only (recommended) vs. hard-delete with the `23503` guard vs. soft-delete `is_archived` column.
3. **Image required or optional:** recommend **optional** (schema allows null; customer menu renders fine without one) so owners aren't blocked on photography.
4. **Storage model long-term:** keep one-bucket-per-restaurant (current; this plan) vs. v2 consolidation to a single shared bucket with per-restaurant *folders* (simpler RLS via `(storage.foldername(name))[1] = restaurant_id`, no per-restaurant bucket sprawl, but requires migrating the existing 8). Out of scope now — flag for v2 if bucket count or onboarding friction grows.
5. **Compression target format:** WebP primary with JPEG fallback (recommended) vs. JPEG-only (simpler, slightly larger files under the 120 KB cap).
