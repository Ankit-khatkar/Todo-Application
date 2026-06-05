# Owner Menu Management — Feature Plan

> **Status:** Planning
> **Type:** New feature (reverses a documented v1 constraint)
> **Route:** `/dashboard/menu` (owner-only)
> **Reference:** `phase2_owner_dashboard_plan.md`, `phase2_owner_dashboard_ux_ui.md`, `v2_deferred_issues.md` §1–§2, `CLAUDE.md`
> **Migrations touched:** new `007_owner_menu_management.sql` (menu_items owner RLS + `storage.objects` folder-scoped policies). One shared `menu-images` bucket created once.

---

## 0. Goal & Scope

Let a restaurant owner manage their own menu from inside the app instead of waiting for Ankit to edit rows / upload images via the Supabase Dashboard. Concretely the owner can:

1. **Add a new dish** — name, description, price, veg/non-veg, optional image.
2. **Edit** a dish's name, description, or price.
3. **Upload / replace a dish image.**
4. **Mark a dish veg or non-veg.**
5. **Enable / disable a dish** (out-of-stock toggle) — the operational fast-path during service.

A core requirement that shaped the storage design: **when a new restaurant joins, its owner must be able to add dishes and upload images with zero admin intervention.** See §3 — this is why we consolidate to one shared bucket with per-restaurant folders.

### What this changes vs. v1

`CLAUDE.md` and `redlotusfoods_documentation.md` §4.8 currently state: *"Owners cannot edit menu items in v1 (admin-managed via Supabase Dashboard)."* This feature **intentionally lifts that restriction** for the owner's *own* restaurant. The admin-managed path (`menu_items_admin_all`) stays exactly as-is; we only **add** owner write access scoped by RLS.

### Out of scope (deferred)

- **Menu categories / sections** — flat menu stays (v1 rule; `RestaurantMenu.tsx` renders a flat list).
- **Hard delete of dishes** — see §2.2. The out-of-stock toggle is the v1 "remove from menu" mechanism.
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
| `restaurant_id` | `uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE` | Ownership anchor for RLS **and** the image folder name. |

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

## 3. Image Upload — Single Shared Bucket + Per-Restaurant Folders

### 3.0 Why this model (and what we're moving away from)

Storage is **already in production**, but not in the shape this feature wants. Today each restaurant has its **own** bucket, named after the restaurant (e.g. `Gudha Delight Menu`), images at the bucket root, public read, 120 KB limit, 8 buckets, **all admin-created via the Dashboard** (config is Dashboard-managed per `supabase/config.toml`; the `picsum.photos` URLs in `seed.sql` are placeholder seed data, not live data).

That model **cannot be self-serve for new restaurants**: bucket creation is a privileged (`service_role`) operation, and the human bucket names aren't machine-derivable — so every new restaurant would need an admin to create and name a bucket. (Full rationale in §11.)

**Decision: consolidate to one shared, public bucket `menu-images`, with one folder per restaurant keyed by `restaurant_id`.** Supabase "folders" are just object-key prefixes — they are **not created**, they spring into existence on first upload. So a brand-new restaurant's owner can upload immediately with **no admin step, no `service_role`, no per-restaurant provisioning**. This directly satisfies the self-serve requirement in §0.

### 3.1 Bucket

| Setting | Value | Why |
|---|---|---|
| Bucket id | `menu-images` | Single shared bucket, created **once** for the whole platform. |
| Public | **Yes** (public read) | Customer menu (`RestaurantMenu.tsx`) renders `<img src={image_url}>` with no auth context. |
| Allowed MIME | `image/jpeg`, `image/png`, `image/webp` | Enforce in bucket config + client-side. |
| File size limit | **120 KB** | Matches the existing constraint; client compresses to fit (§3.4). |

### 3.2 Path convention

```
menu-images/{restaurant_id}/{menu_item_id}.{ext}
            └── folder ───┘ └──── object ─────┘
```

- **First path segment is the `restaurant_id`** — this is what folder-scoped RLS keys ownership on, and it's machine-derivable (no human naming, no mapping column).
- Naming the object after `menu_item_id` makes replace idempotent (overwrite the same key) and collision-proof.
- The stored `menu_items.image_url` is the full public URL (+ cache-buster, §3.5).

> **No `restaurants.image_bucket` column** — the bucket is the constant `'menu-images'` and the folder is `restaurant_id`. Both are known from the row the page already has, so there's nothing to store or map.

### 3.3 Storage RLS (`storage.objects`)

```sql
-- Public read for the whole menu bucket.
CREATE POLICY "menu_images_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'menu-images');

-- Owner may write only inside their own restaurant's folder.
-- (storage.foldername(name))[1] = first path segment = restaurant_id.
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

CREATE POLICY "menu_images_owner_update" ON storage.objects    -- replace/upsert
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'menu-images'
    AND EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.owner_id = auth.uid()
        AND r.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "menu_images_owner_delete" ON storage.objects    -- remove image
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

> Put these in `007` for reproducibility. A new restaurant needs **nothing** here — the policies already cover any `restaurant_id` folder the moment that restaurant row exists.

### 3.4 Migrating the existing 8 (hybrid — zero-downtime, no rush)

`menu_items.image_url` stores **full URLs**, and the old per-restaurant buckets remain public — so existing images keep rendering with no change. We do **not** have to migrate before shipping.

- **Default (hybrid):** Leave the 8 old buckets in place. All **new** owner uploads/replaces go to `menu-images/{restaurant_id}/…`; the row's `image_url` is rewritten to the new URL. When an owner **replaces** a pre-consolidation image, the new image lands in the shared bucket and `image_url` is repointed — but the old object stays as an **orphan** in the per-restaurant bucket. Owners **cannot delete it themselves** (the §3.3 delete policy only covers `menu-images`; they have no delete grant on the old buckets), so these orphans are harmless storage that only the cleanup script (below) can remove. *Don't describe this as auto-deletion — it isn't.*
- **Optional cleanup (later):** A one-off **idempotent** script (Node + `service_role`) walks `menu_items`, and **for rows whose `image_url` does NOT already point at `menu-images`**, copies the old object into `menu-images/{restaurant_id}/{menu_item_id}.{ext}`, rewrites `image_url`, then deletes the old buckets. Skipping already-migrated rows is what makes it safe to re-run and safe to run after owners have already replaced some images themselves. Pure SQL can't move objects across buckets — it needs the Storage API. Not required for launch.

### 3.5 Compression (mandatory — 120 KB) & replace/remove

120 KB is small; a raw phone photo (2–5 MB) is rejected by the bucket limit. `ImageUploader` **must** compress before upload:

1. Downscale to a max longest edge (~800–1000 px is plenty for a menu thumbnail).
2. Re-encode to **WebP** (best ratio; JPEG fallback on old Safari) via `<canvas>`.
3. **Iterate quality down** until the blob is **< ~115 KB** (headroom under 120 KB). If it can't get under even at minimum quality, reject: *"Couldn't compress this image under 120 KB — try a simpler or smaller photo."*

- **Replace (same shared-bucket key):** `upload(path, blob, { upsert: true })` overwrites `{menu_item_id}.{ext}`. **Cache-bust with a *fresh* `?v=${Date.now()}`** — *not* the row's existing `updated_at`. The base public URL is unchanged on a same-key overwrite, so reusing a stale timestamp yields an identical `image_url` and the CDN keeps serving the old image. A fresh value forces the refetch.
- **Replace (ext changed, e.g. jpg→webp) or first move off an old bucket:** the new key differs from the old, so after a successful upload, **best-effort delete the previous object only if it lived in the shared bucket** (`menu-images`). Old per-restaurant-bucket objects are left for the cleanup script (§3.4) — the owner has no delete rights there. See the helper in §5.4.
- **Remove (keep dish):** `image_url = null` + best-effort `remove([sharedKey])` if the current image is in `menu-images` (orphans are harmless if delete fails).

---

## 4. TypeScript Types

`MenuItem` already exists in `src/types/models.ts` (29–40) with every field — **no model change of any kind** (no `image_bucket`, since the bucket is a constant). Local write-DTO:

```ts
// src/pages/dashboard/menu/types.ts
export const MENU_BUCKET = "menu-images";

export interface MenuItemDraft {
  name: string;
  description: string;   // '' → store as null
  price: number;         // > 0
  is_veg: boolean;
  is_available: boolean;
}
export type MenuItemRow = MenuItem; // from types/models
```

Optionally regen generated types after 007: `npx supabase gen types typescript --local > src/types/database.ts`.

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
  MenuManager.tsx     orchestrator: fetch owner restaurant + menu_items; owns state + handlers
  MenuManager.css
  MenuItemRow.tsx     one dish: thumbnail, name/price, veg dot, availability switch, Edit btn
  MenuItemRow.css
  MenuItemEditor.tsx  add/edit modal (mirrors DeclineModal: focus trap, ESC, backdrop, in-modal error, scroll lock)
  MenuItemEditor.css
  ImageUploader.tsx   file input + preview + canvas compression (<115 KB) + upload to menu-images/{restaurant_id}/
  types.ts            MENU_BUCKET + MenuItemDraft + helpers
  menuApi.ts          thin data layer: list / create / update / setAvailability / uploadImage / removeImage
  menuApi.test.ts     (optional) pure validation + compression-target helpers
```

Reuse: `humaniseSupabaseError` (`src/lib/errors.ts`), the dashboard `Toast` pattern, the veg/non-veg dot styling, and the Phase 2 design tokens (no new app-level stylesheet).

### 5.4 Data flows

**Resolve restaurant on mount** — same `.maybeSingle()` on `owner_id` as `OwnerDashboard.tsx`; null → reuse `OnboardingIncomplete`:

```ts
const { data: restaurant } = await supabase
  .from("restaurants")
  .select("id, name, cuisine_type")
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
const { data: row } = await supabase
  .from("menu_items")
  .insert({
    restaurant_id: restaurant.id,
    name, description: description || null,
    price, is_veg, is_available: true, image_url: null,
  })
  .select("id, name, description, price, image_url, is_veg, is_available, updated_at")
  .single();
// then, if a file was chosen → uploadImage(restaurant.id, row.id, file, null)  // new dish: no prior image
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

**Image upload (compress → upload to the restaurant's folder → save URL):**

```ts
import { MENU_BUCKET } from "./types";

const SHARED_PREFIX = "/storage/v1/object/public/menu-images/";

// In-bucket key (e.g. "{rid}/{iid}.jpg") IF the URL points at the shared
// bucket; null for an old per-restaurant-bucket URL (owner can't delete there).
function sharedKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  const i = url.indexOf(SHARED_PREFIX);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + SHARED_PREFIX.length).split("?")[0]);
}

// prevImageUrl = the dish's current image_url (null for a new dish).
async function uploadImage(
  restaurantId: string, itemId: string, file: File, prevImageUrl: string | null,
) {
  const blob = await compressUnder(file, 115_000, 1000); // canvas downscale + quality loop
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const path = `${restaurantId}/${itemId}.${ext}`;        // per-restaurant folder, item-id object

  const { error: upErr } = await supabase.storage
    .from(MENU_BUCKET)
    .upload(path, blob, { upsert: true, contentType: blob.type });
  if (upErr) throw upErr;

  // Best-effort delete the PREVIOUS object only if it was in the shared bucket
  // under a different key (ext change). Old per-restaurant-bucket images can't
  // be deleted here (no RLS grant) — the §3.4 cleanup script retires those.
  const prevKey = sharedKeyFromUrl(prevImageUrl);
  if (prevKey && prevKey !== path) {
    await supabase.storage.from(MENU_BUCKET).remove([prevKey]).catch(() => {});
  }

  const { data: { publicUrl } } = supabase.storage.from(MENU_BUCKET).getPublicUrl(path);
  const image_url = `${publicUrl}?v=${Date.now()}`;       // FRESH — busts CDN on same-key replace
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
- **6.2 Price edited mid-customer-session** — `place_order` (006) recomputes the subtotal from live `menu_items.price` and raises `PRICING_MISMATCH:` on >₹0.01 disagreement; `Checkout.tsx` surfaces *"Pricing updated — please review your order."* Correct, pre-existing behaviour — exactly the scenario that guard exists for.
- **6.3 Dish disabled while in an open cart** — `place_order` → `order_items` INSERT → `validate_order_item` raises *"Menu item is currently unavailable."* Surfaced via `humaniseSupabaseError`.
- **6.4 Onboarding-incomplete owner** — no `restaurants` row → reuse `OnboardingIncomplete`.
- **6.5 New restaurant, first dish + image** — works with **zero admin setup**: the row insert gives a `restaurant_id`/`menu_item_id`, and the first upload creates the `menu-images/{restaurant_id}/` prefix implicitly. This is the requirement that drove the shared-bucket design (§0, §3).
- **6.6 Image upload fails after row insert** — row persists with `image_url = null` (customer menu renders fine without an image — `RestaurantMenu.tsx` only emits `<img>` when `image_url` is truthy). Toast + retry; no corruption.
- **6.7 Two tabs / concurrent edits** — single-owner, low-frequency; last-write-wins on the row is acceptable. No order-style race guard needed.
- **6.8 Restaurant inactive/closed** — editing works regardless; customer SELECT gates visibility, so nothing leaks.
- **6.9 Replacing a pre-consolidation image** — a dish whose `image_url` still points at an old per-restaurant bucket renders fine (those buckets stay public). Replacing it writes the new image to `menu-images/{restaurant_id}/`, rewrites `image_url`, and busts the cache with `?v=Date.now()` — seamless for the customer. The old object is **orphaned** in the per-restaurant bucket (owner has no delete grant there); the §3.4 cleanup script removes it later. This is expected, not a leak to fix per-replace.

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

**ImageUploader** — tap to pick → preview → **compress to < ~115 KB** (canvas) with a "Compressing…" state → upload on Save. Show current image with Change / Remove affordances when editing.

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
| Storage RLS (folder) | Owner can upload only under `menu-images/{ownRestaurantId}/…`; upload to another restaurant's folder denied; anon can read; **a brand-new restaurant's owner can upload with no setup** (proves self-serve). |
| Triggers | Disable → customer fetch omits it; order containing it → `validate_order_item` raises. Edit price → past `order_items.unit_price` unchanged; new order uses new price. |
| Frontend (Vitest, pure) | `MenuItemDraft` validation; compression target/ext helper; path builder. (Repo scope: pure logic only, no mocked Supabase.) |
| Compression (manual) | A 4 MB phone photo compresses under 120 KB and uploads; a pathological image that can't is rejected with the friendly message. |
| E2E (manual) | Add dish w/ image → shows on customer menu. Disable → gone for customer next reload. Edit name/price → reflected. Replace image → new shows (cache-bust). Pre-consolidation old image still renders; replacing it moves it to the shared bucket. Onboarding-incomplete owner → `OnboardingIncomplete`. |

---

## 10. Deployment Checklist

1. **Create the shared `menu-images` bucket once** (public, MIME allowlist, 120 KB limit) — Dashboard or in a setup step. This is the only storage provisioning, ever; new restaurants need nothing.
2. Apply `007_owner_menu_management.sql`: `menu_items` owner INSERT/UPDATE policies + `storage.objects` folder-scoped policies. Verify they don't conflict with policies already set on the old buckets in the Dashboard.
3. Deploy frontend (avoid peak hours 12–2 PM / 7–9:30 PM per `CLAUDE.md`).
4. Smoke test with a real seed owner: add → edit → upload (large photo, confirm <120 KB) → disable → re-enable; verify the customer side in a second browser. Also test a restaurant that has **no** prior images (proves the self-serve first-upload path).
5. **(Optional, later)** Run the migration script to move the existing 8 restaurants' images into `menu-images/{restaurant_id}/` and retire the old per-restaurant buckets (§3.4). Not required for launch.
6. **Update docs on ship** (this reverses a stated v1 rule):
   - `CLAUDE.md` — RLS summary *"Owners cannot edit menu items in v1"* → owners manage their own menu via `/dashboard/menu`; add the route to the Routes table; document the shared `menu-images` bucket + `menu-images/{restaurant_id}/{menu_item_id}` convention in the Hosting/env section.
   - `GEMINI.md` — mirror.
   - `redlotusfoods_documentation.md` §4.8 — owner `menu_items` write policies + storage model.

---

## 11. Decisions

| # | Decision | Status |
|---|---|---|
| 1 | **New-restaurant storage provisioning** | **Resolved: single shared `menu-images` bucket + per-restaurant folders.** Folders are implicit (created on first upload), so a new restaurant is fully self-serve — no admin, no `service_role`, no per-restaurant bucket/column. This was chosen specifically to answer "does a new owner need admin to set up storage?" → **no.** |
| 2 | **Existing 8 buckets** | Hybrid: leave as-is (old image_urls still render); new uploads go to the shared bucket. Optional one-off migration later (§3.4). |
| 3 | **Placement** | Recommended: dedicated `/dashboard/menu` route (vs. a section on `/dashboard`). Confirm. |
| 4 | **Delete** | Recommended: disable-only (FK RESTRICT). Hard-delete or soft-delete deferred (§2.2). Confirm. |
| 5 | **Image required?** | Recommended: optional (schema allows null; customer menu renders fine without one). Confirm. |
| 6 | **Compression format** | Recommended: WebP primary, JPEG fallback. Confirm. |
