# Owner Menu Management — Feature Plan

> **Status:** Planning
> **Type:** New feature (reverses a documented v1 constraint)
> **Route:** `/dashboard/menu` (owner-only)
> **Reference:** `phase2_owner_dashboard_plan.md`, `phase2_owner_dashboard_ux_ui.md`, `v2_deferred_issues.md` §1–§2, `CLAUDE.md`
> **Migrations touched:** new `007_owner_menu_management.sql` + Supabase Storage bucket/policies

---

## 0. Goal & Scope

Let a restaurant owner manage their own menu from inside the app instead of waiting for Ankit to edit rows in the Supabase Dashboard. Concretely the owner can:

1. **Add a new dish** — name, description, price, veg/non-veg, optional image.
2. **Edit** a dish's name, description, or price.
3. **Upload / replace a dish image.**
4. **Mark a dish veg or non-veg.**
5. **Enable / disable a dish** (out-of-stock toggle) — the operational fast-path during service.

### What this changes vs. v1

`CLAUDE.md` and `redlotusfoods_documentation.md` §4.8 currently state: *"Owners cannot edit menu items in v1 (admin-managed via Supabase Dashboard)."* This feature **intentionally lifts that restriction** for the owner's *own* restaurant. The admin-managed path (`menu_items_admin_all`) stays exactly as-is; we only **add** owner write access scoped by RLS.

### Out of scope (deferred)

- **Menu categories / sections** — flat menu stays (v1 rule, `RestaurantMenu.tsx` renders a flat list). Tracked in `v2_deferred_issues.md`.
- **Hard delete of dishes** — see §3.4. The out-of-stock toggle is the v1 "remove from menu" mechanism. Optional soft-delete is specced but recommended off for the first ship.
- **Bulk import / CSV, drag-to-reorder, price scheduling, multi-image galleries.**
- **Realtime menu propagation to live customer tabs** — customers pick up menu changes on their next page load (§7). Acceptable at v1 scale.

---

## 1. Backend Alignment (read this first)

Everything below is already in the deployed schema — we are *not* changing the `menu_items` table shape:

| Column | Type / constraint | Relevance |
|---|---|---|
| `name` | `text NOT NULL` | Required on add. |
| `description` | `text` (nullable) | Optional. |
| `price` | `numeric(10,2) NOT NULL CHECK (price > 0)` | DB rejects ≤ 0 — frontend mirrors. |
| `image_url` | `text` (nullable) | Holds the Storage public URL. Nullable → image is optional. |
| `is_veg` | `boolean NOT NULL` | No default — **must** be supplied on insert. |
| `is_available` | `boolean NOT NULL DEFAULT true` | The enable/disable toggle. |
| `updated_at` | `timestamptz` | Auto-bumped by `set_menu_items_updated_at` trigger (003) on every UPDATE. |
| `restaurant_id` | `uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE` | Ownership anchor for RLS. |

Two existing safeguards make the **disable** action a complete kill-switch with zero new code:

1. **`menu_items_customer_select`** (002) filters `is_available = true` — a disabled dish vanishes from the customer menu on their next fetch.
2. **`validate_order_item`** trigger (003) raises *"Menu item is currently unavailable"* on any `order_items` INSERT for an `is_available = false` item — so even a stale customer cart can't order a just-disabled dish. `place_order` (006) inserts `order_items` inside its transaction, so the raise aborts the whole order.

The **price snapshot model** means editing a price is safe for history: `order_items.unit_price` is frozen at order time (001 + 006), so past orders never change. New orders read the live `menu_items.price` inside `place_order` (006 step b). See §6.2 for the mid-session edge case.

---

## 2. The Core Gap — Owner Write RLS

Today owners have **SELECT only** on `menu_items` (`menu_items_owner_select`, 002:135). There is no INSERT / UPDATE / DELETE policy for the `authenticated` owner role, so every write currently 403s for them. Migration 007 adds three narrowly-scoped policies.

### Decision: RLS-based direct writes, *not* a SECURITY DEFINER RPC

`v2_deferred_issues.md` §1 prefers an RPC for `restaurants` because owners must be blocked from editing *most* columns (only `is_open` is theirs). **Menu items are different — the entire row legitimately belongs to the owner.** There's no column to protect; the only thing to enforce is *"this row's `restaurant_id` is a restaurant you own,"* which a row-scoped RLS policy expresses cleanly. Direct `.from('menu_items').insert/update()` calls are simpler, mirror how the open/close toggle already writes `restaurants` directly, and need no new RPC surface.

The one subtlety RLS must cover: an UPDATE must validate ownership on **both** the old and new row, so an owner can't reassign an item to a restaurant they don't own. That's `USING` (old row) **+** `WITH CHECK` (new row), both present below.

### `007_owner_menu_management.sql` — RLS (reference sketch)

```sql
-- ============================================================
-- 007_owner_menu_management.sql
-- Owner write access to their own restaurant's menu_items.
-- Admin policies (menu_items_admin_all) and the customer/owner
-- SELECT policies from 002 are unchanged.
-- Run after 006_pricing_breakdown.sql.
-- ============================================================

-- INSERT: the new row must belong to a restaurant the caller owns.
CREATE POLICY menu_items_owner_insert ON public.menu_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.id = menu_items.restaurant_id
        AND r.owner_id = auth.uid()
    )
  );

-- UPDATE: caller owns the row now (USING) and still owns it after
-- the change (WITH CHECK) — blocks re-parenting to another restaurant.
CREATE POLICY menu_items_owner_update ON public.menu_items
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.id = menu_items.restaurant_id
        AND r.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.id = menu_items.restaurant_id
        AND r.owner_id = auth.uid()
    )
  );

-- DELETE: optional. See §3.4 — order_items FK is ON DELETE RESTRICT,
-- so this only succeeds for dishes never ordered. Recommended OFF for
-- the first ship; ship the disable toggle instead. Included here for
-- completeness if product wants true delete of typo/never-ordered items.
CREATE POLICY menu_items_owner_delete ON public.menu_items
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.id = menu_items.restaurant_id
        AND r.owner_id = auth.uid()
    )
  );
```

**Note on `is_active`:** these policies let an owner write menu items even while their restaurant is `is_active = false` or `is_open = false`. That's intentional — owners should be able to prep their menu before going live, and edit it while temporarily closed. Visibility to customers is still gated by `menu_items_customer_select` (which checks the restaurant is active+open), so nothing leaks early.

---

## 3. Image Upload — Supabase Storage

There is **no Storage usage anywhere in the project today** (seed images are external `picsum.photos` URLs). This feature introduces the first bucket. It must be set up once per environment.

### 3.1 Bucket

| Setting | Value | Why |
|---|---|---|
| Bucket id | `menu-images` | — |
| Public | **Yes** (public read) | Customer menu (`RestaurantMenu.tsx`) renders `<img src={image_url}>` with no auth context. Public bucket → stable `getPublicUrl` with no signed-URL expiry to manage. |
| Allowed MIME | `image/jpeg`, `image/png`, `image/webp` | Enforce in the bucket config **and** client-side. |
| File size limit | 2 MB | Mobile-first, 4G uploads. Client downsizes before upload (§3.3). |

### 3.2 Path convention

```
menu-images/{restaurant_id}/{menu_item_id}.{ext}
```

- First path segment is the `restaurant_id` — this is what storage RLS keys ownership on.
- Naming the object after `menu_item_id` makes replace idempotent (overwrite same key) and ties the asset to its row. For a brand-new dish where the row doesn't exist yet, use a client-generated `crypto.randomUUID()` filename and reconcile after insert, **or** insert the row first then upload (recommended — see §5.4).

### 3.3 Storage RLS (`storage.objects`)

```sql
-- Public read for every object in the bucket.
CREATE POLICY "menu_images_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'menu-images');

-- Owner may write only inside their own restaurant's folder.
-- (storage.foldername(name))[1] = the first path segment = restaurant_id.
CREATE POLICY "menu_images_owner_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'menu-images'
    AND EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.owner_id = auth.uid()
        AND r.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "menu_images_owner_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'menu-images'
    AND EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.owner_id = auth.uid()
        AND r.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "menu_images_owner_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'menu-images'
    AND EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.owner_id = auth.uid()
        AND r.id::text = (storage.foldername(name))[1]
    )
  );
```

> Storage policies live on `storage.objects`, not in a numbered app migration by default. Either add them to `007` (they're plain SQL) or create the bucket + policies via the Supabase Dashboard once per environment and **document it in the deployment checklist** (§10). Putting them in `007` is preferred for reproducibility — fresh environments otherwise silently lose upload ability.

### 3.4 Replace & delete semantics

- **Replace image:** `upload(path, file, { upsert: true })` overwrites the same key. Because the public URL is stable, append a cache-buster (`?v=${Date.now()}` or use `updated_at`) to `image_url` so the customer's browser refetches. Simpler alternative: upload to a fresh UUID key, update `image_url`, then best-effort delete the old object.
- **Remove image (keep dish):** clear `image_url` to `null` and delete the storage object (best-effort; orphaned objects are harmless and cheap).
- **Hard delete a dish:** blocked by `order_items.menu_item_id ... ON DELETE RESTRICT` (001:93) for any dish that has ever been ordered → Postgres `23503`. **Recommendation: do not expose delete in v1 of this feature.** Use the disable toggle as "remove from menu." If product insists on delete:
  - Catch `23503` and surface *"This dish has past orders, so it can't be deleted. Disable it instead to hide it from customers."*
  - For never-ordered typo dishes the DELETE policy lets it through cleanly.
  - The cleaner long-term answer is a soft-delete column (`is_archived boolean NOT NULL DEFAULT false`) filtered out of both customer and owner menu queries — but that's a schema add; defer unless needed.

---

## 4. TypeScript Types

`MenuItem` already exists in `src/types/models.ts` (lines 29–40) with every field — **no model change needed**. After applying 007, regenerate the generated types for completeness:

```bash
npx supabase gen types typescript --local > src/types/database.ts
```

(`database.ts` is currently enums-only per the comment in `models.ts`; the hand-written `MenuItem` interface is the source of truth the new code imports.)

Define a small write-DTO local to the menu feature rather than reusing the full row:

```ts
// src/pages/dashboard/menu/types.ts
export interface MenuItemDraft {
  name: string;
  description: string;        // '' → store as null
  price: number;              // > 0
  is_veg: boolean;
  is_available: boolean;
  image_url: string | null;
}
export type MenuItemRow = MenuItem; // from types/models
```

---

## 5. Frontend Architecture

### 5.1 Placement decision — separate route, not a dashboard section

The Owner Dashboard (`/dashboard`) is an **operational cockpit** — its design tenets (`phase2_owner_dashboard_ux_ui.md` §0) are "glanceable, real-time, one action per card, refresh is a bug." Menu management is the opposite: an occasional, form-heavy config task. Bolting a CRUD editor onto the orders page violates "Pending must be visible without scrolling/switching views."

**Recommendation:** a dedicated owner-only route **`/dashboard/menu`**, lazy-loaded (consistent with the code-split routes in `App.tsx`), reachable via a **"Manage Menu"** link in `RestaurantHeader` (and/or the owner Navbar state). The orders cockpit stays untouched.

> This is the main open product decision — see §11. The alternative (a collapsible "Menu" section below History on `/dashboard`) is viable but I'd argue against it for the reason above.

### 5.2 Routing & guard

In `src/App.tsx`, add inside the existing `<Suspense>`:

```tsx
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

`<ProtectedRoute role="owner">` (existing component, props `role`, `requirePhoneVerified`) blocks customers/admins at the route layer; RLS is the real enforcement.

### 5.3 File map (mirror the dashboard's component/CSS co-location)

```
src/pages/dashboard/menu/
  MenuManager.tsx          orchestrator: fetch owner restaurant + menu_items, owns state + handlers
  MenuManager.css
  MenuItemRow.tsx          one dish: thumbnail, name/price, veg dot, availability switch, Edit btn
  MenuItemRow.css
  MenuItemEditor.tsx       add/edit modal (mirrors DeclineModal patterns: focus trap, ESC, backdrop)
  MenuItemEditor.css
  ImageUploader.tsx        file input + preview + client downscale + upload-to-storage
  types.ts                 MenuItemDraft + helpers
  menuApi.ts               thin data layer: list / create / update / setAvailability / uploadImage
  menuApi.test.ts          (optional) pure validation helpers
```

Reuse existing primitives: `humaniseSupabaseError` (`src/lib/errors.ts`) for every async failure, the `Toast` component pattern from the dashboard, the veg/non-veg dot styling convention, and the design tokens (no new stylesheet at app level).

### 5.4 Data flows

**List (on mount):**
```ts
const { data, error } = await supabase
  .from("menu_items")
  .select("id, name, description, price, image_url, is_veg, is_available, updated_at")
  .eq("restaurant_id", restaurantId)
  .order("name", { ascending: true });
// owner SELECT policy returns ALL items incl. is_available=false (the editor must show disabled dishes)
```
Resolve `restaurantId` exactly like `OwnerDashboard.tsx` does: `restaurants` `.maybeSingle()` on `owner_id`; null → reuse `OnboardingIncomplete`.

**Add dish (insert row first, then optional image):**
```ts
// 1. Insert the row (no image yet)
const { data: row, error } = await supabase
  .from("menu_items")
  .insert({
    restaurant_id: restaurantId,
    name, description: description || null,
    price, is_veg, is_available: true, image_url: null,
  })
  .select("id, name, description, price, image_url, is_veg, is_available, updated_at")
  .single();

// 2. If a file was chosen, upload to menu-images/{restaurantId}/{row.id}.{ext},
//    then UPDATE the row's image_url with the public URL (+ cache-buster).
```
Inserting first avoids orphan images if the row insert fails, and gives a stable `menu_item_id` filename.

**Edit dish:**
```ts
const { data, error } = await supabase
  .from("menu_items")
  .update({ name, description: description || null, price, is_veg /*, image_url */ })
  .eq("id", itemId)
  .select("...")
  .single();
// updated_at auto-bumps via trigger; no manual timestamp
```

**Enable / disable (the fast path) — optimistic with rollback:**
```ts
// optimistic flip, mirror RestaurantHeader open/close toggle pattern
setItems(prev => prev.map(i => i.id === id ? { ...i, is_available: next } : i));
const { error } = await supabase
  .from("menu_items").update({ is_available: next }).eq("id", id);
if (error) { /* rollback + toast "Couldn't update. Try again." */ }
```

**Image upload helper:**
```ts
const ext = file.name.split(".").pop()!.toLowerCase();
const path = `${restaurantId}/${itemId}.${ext}`;
const { error: upErr } = await supabase.storage
  .from("menu-images")
  .upload(path, file, { upsert: true, contentType: file.type });
const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(path);
const image_url = `${publicUrl}?v=${Date.now()}`; // cache-bust on replace
```

### 5.5 Validation (frontend mirrors DB)

| Field | Rule | DB backstop |
|---|---|---|
| name | required, trim ≥ 1, ≤ ~80 chars | `NOT NULL` |
| description | optional, ≤ ~300 chars | nullable |
| price | number > 0, ≤ 2 decimals | `CHECK (price > 0)` |
| is_veg | required radio (veg / non-veg), no default | `NOT NULL` (no default → insert fails if omitted) |
| image | optional; type ∈ {jpeg,png,webp}; ≤ 2 MB after downscale | bucket MIME/size limit |

Never render raw `error.message`; route all failures through `humaniseSupabaseError`.

---

## 6. Edge Cases & Interactions

### 6.1 Disable propagation
Disabling a dish removes it from the customer menu on their next load (`menu_items_customer_select`) and blocks it at order time (`validate_order_item`). No realtime needed for correctness — the trigger is the hard guarantee.

### 6.2 Price edited mid-customer-session
A customer added the dish at the old price; the cart stores price at add-time. At checkout, `place_order` (006) recomputes the subtotal from **live** `menu_items.price` and raises `PRICING_MISMATCH:` if the client total disagrees by > ₹0.01. `Checkout.tsx` already surfaces this as *"Pricing updated — please review your order."* **This is correct, pre-existing behaviour** — the owner editing a price is exactly the scenario that guard exists for. Document it; don't fight it.

### 6.3 Dish disabled while in a customer's open cart
Customer can still see it in their cart UI, but `place_order` → `order_items` INSERT → `validate_order_item` raises *"Menu item is currently unavailable."* Surface via `humaniseSupabaseError` (short capitalised RPC raises pass through). No client-side pre-check required, though a nicer UX could re-validate availability on the menu page.

### 6.4 Onboarding-incomplete owner
No `restaurants` row → reuse `OnboardingIncomplete`. Same `.maybeSingle()` null-handling as `OwnerDashboard.tsx`.

### 6.5 Concurrent edits / two tabs
Single-owner, low-frequency. Last-write-wins on the row is acceptable; no race guard like the orders flow needs. `updated_at` lets the UI detect a stale view if we ever want optimistic-concurrency later.

### 6.6 Image upload fails after row insert
Row exists with `image_url = null` (dish shows as image-less, which the customer menu already handles gracefully — `RestaurantMenu.tsx` only renders `<img>` when `image_url` is truthy). Toast the upload error; let the owner retry from the editor. No partial-state corruption.

### 6.7 Restaurant inactive/closed
Menu editing works regardless of `is_active`/`is_open` (§2 note). Nothing leaks to customers because their SELECT policy gates on active+open.

---

## 7. Realtime (deferred)

Owner menu edits do **not** need realtime for v1: the owner edits and sees their own optimistic updates; customers pick up changes on next page load. If we later want live customer menus, add `menu_items` to the `supabase_realtime` publication (same `DO $$ ... duplicate_object` pattern as 006:81-100) and subscribe in `RestaurantMenu.tsx`. Listed here so it isn't rediscovered as a "bug."

---

## 8. UX / UI (aligned with Phase 2 tokens)

Inherit all tokens from `phase2_owner_dashboard_ux_ui.md` §5 — no new colours. Mobile-first; the owner manages the menu on a phone.

**MenuManager page**
- Reuse the sticky `RestaurantHeader` look (name + cuisine) but with a **"Manage Menu"** title context and a back link to `/dashboard`.
- Primary CTA: **`+ Add Dish`** (red filled, `#D63031`), top-right of the list / floating on mobile.
- List of `MenuItemRow`s, single column at all breakpoints (consistent with the dashboard's queue rule).

**MenuItemRow**
```
┌───────────────────────────────────────────────┐
│ [img]  🟢 Paneer Tikka              ₹220      │
│        Cottage cheese, tandoor-grilled         │
│                         [ Available ●─ ]  Edit │
└───────────────────────────────────────────────┘
```
- Veg/non-veg dot reuses the customer menu convention (green square / red, FSSAI).
- **Availability switch** mirrors the open/close toggle styling from `RestaurantHeader.css` (red=available/on, grey=disabled). Optimistic flip, 150ms.
- Disabled dish: row at 0.6 opacity + an "Out of stock" chip so it's obviously hidden from customers.
- `Edit` opens `MenuItemEditor`.

**MenuItemEditor (modal)** — mirror `DeclineModal` interaction rules: autofocus first field, ESC + backdrop close, focus restoration on unmount, in-modal error banner, spinner on submit, body scroll lock. Fields: name, description (textarea), price (numeric, ₹ prefix), veg/non-veg radio, ImageUploader (preview + change/remove), Save / Cancel.

**ImageUploader** — tap to pick → preview → client-side downscale (canvas, longest edge ~1200px, re-encode webp/jpeg ~0.8) → on Save, upload. Show progress/spinner; show current image with a "Change" / "Remove" affordance when editing.

**Empty state** — *"No dishes yet. Add your first dish so customers can start ordering."* + the Add Dish CTA.

**Microcopy / toasts** (match Phase 2 voice — direct, imperative):
| Action | Toast |
|---|---|
| Dish added | Dish added. |
| Dish updated | Changes saved. |
| Enabled | Dish is now available. |
| Disabled | Dish marked out of stock. |
| Error | Couldn't update. Try again. |

Accessibility: availability switch is `role="switch"` with `aria-checked` (same as the open/close toggle); veg/non-veg conveyed by shape + label, not colour alone.

---

## 9. Testing

| Layer | What to test |
|---|---|
| RLS (manual, SQL editor) | Owner A cannot INSERT/UPDATE a dish for Owner B's restaurant (403). Owner can CRUD own. UPDATE cannot re-parent `restaurant_id` to another owner (WITH CHECK). Customer cannot write at all. |
| Storage RLS | Owner can upload only under `menu-images/{ownRestaurantId}/...`; upload to another restaurant's folder is denied; anon can read. |
| Triggers | Disable a dish → customer menu fetch omits it; place an order containing it → `validate_order_item` raises. Edit price → past order's `order_items.unit_price` unchanged; new order uses new price. |
| Frontend (Vitest, pure) | `MenuItemDraft` validation (price > 0, name required, ext/size checks), image path builder, cache-buster helper. (Per repo testing scope: pure logic only, no mocked Supabase.) |
| E2E (manual) | Add dish w/ image → appears on customer menu. Disable → disappears for customer within one reload. Edit name/price → reflected. Upload replace → new image shows (cache-buster works). Onboarding-incomplete owner → `OnboardingIncomplete`. |

---

## 10. Deployment Checklist

1. Apply `007_owner_menu_management.sql` (owner menu RLS + optional DELETE policy + storage policies if you put them here).
2. Create the **`menu-images`** Storage bucket (public, MIME allowlist, 2 MB limit) — **once per environment** (dashboard or in 007). Add the `storage.objects` policies from §3.3.
3. `npx supabase gen types typescript --local > src/types/database.ts` (optional; `MenuItem` model already covers it).
4. Deploy frontend (avoid peak hours 12–2 PM / 7–9:30 PM per `CLAUDE.md`).
5. Smoke test with a real seed owner account: add → edit → upload → disable → re-enable; verify the customer side in a second browser.
6. **Update docs on ship** (this reverses a stated v1 rule):
   - `CLAUDE.md` — RLS summary line *"Owners cannot edit menu items in v1"* → owners manage their own menu via `/dashboard/menu`; add the route to the Routes table; note the `menu-images` bucket in the Hosting/env section.
   - `GEMINI.md` — mirror the same changes.
   - `redlotusfoods_documentation.md` §4.8 — owner `menu_items` write policies.
   - `v2_deferred_issues.md` — if soft-delete/categories remain deferred, note them.

---

## 11. Open Decisions (need your call)

1. **Placement:** dedicated `/dashboard/menu` route (recommended) vs. a collapsible section on `/dashboard`.
2. **Delete:** ship disable-only (recommended) vs. include hard-delete with the `23503` "has past orders" guard vs. add a soft-delete `is_archived` column.
3. **Image required or optional:** schema says optional (`image_url` nullable) and the customer menu renders fine without one — recommend keeping it optional so owners aren't blocked on photography.
4. **Storage policies location:** inside `007` (reproducible, recommended) vs. dashboard-only (documented in checklist).

