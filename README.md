# Restaurant Card Image Slideshow — Build Plan

> **Status:** Planned — nothing implemented yet. This document is the agreed design.
> **Duration:** ~1 day (migration + frontend) + ongoing admin time to photograph/upload images per restaurant.
> **Goal:** Each restaurant card on `/restaurants` shows up to **5 images** that auto-advance as a slideshow, instead of today's single static `image_url`. Tapping the card keeps navigating to the menu, exactly as it does now.
> **Prerequisites:**
> - None technical — this is a self-contained schema tweak + frontend feature on the existing `restaurants` table and `RestaurantList.tsx`.
> - Operationally: real photos per restaurant (interior, signature dishes, storefront). The feature degrades gracefully without them (§2.4), so it can ship before all photos exist.

---

## 1. Why This Feature Exists

The restaurant card is the customer's first impression of a restaurant — and right now it carries exactly one image (or a flat gradient placeholder). One photo can't show a storefront *and* the food *and* the seating. Five rotating photos let each restaurant present a richer storefront on the list page, which is where the order funnel starts.

This is a conversion play on the highest-traffic authenticated page in the app, at near-zero ongoing cost (no new services, no Edge Functions, no cron).

---

## 2. Decisions & Constraints

These are settled (discussed and confirmed 2026-06-11). Each is load-bearing on the implementation below.

### 2.1 Interaction — auto-play; tap keeps navigating to the menu

The whole card is currently a single `<Link to={"/restaurants/" + id}>` (`RestaurantList.tsx`). The original idea — *"tap on the slide to start the slide"* — conflicts with that: a tap that starts the slideshow can't also open the menu, and splitting the tap target (image vs. card body) or requiring two taps both add friction right where customers decide to order.

**Decision:** the slideshow **auto-plays** (no tap needed), and **tapping anywhere on the card navigates to the menu, unchanged.** No dead taps, no behaviour change to the funnel, no new tap targets inside a `<Link>`.

- Advance interval: **3.5 s** per slide (single constant, e.g. `SLIDE_INTERVAL_MS = 3500`).
- Loops forever (`(i + 1) % images.length`).
- Desktop hover **pauses** the slideshow (the card already has a hover scale effect; pausing while the user is inspecting the image is the expected behaviour).
- Auto-play runs **only while the card is on-screen and the tab is visible** — see §6.2.

### 2.2 Image management — admin only (Supabase Dashboard), no owner UI

You (Ankit) upload images to Storage and write the URLs into the new column from the Supabase Dashboard — the same way restaurants are onboarded today. **No owner-facing upload UI in this version.** This keeps the scope to one migration + one component; the owner self-service version (reusing the menu-image upload/compression/RLS pattern from `/dashboard/menu`) is logged as a v2 item (§10).

### 2.3 Data model — `restaurants.image_urls text[]`, ordered, max 5

A new column on `restaurants`, not a separate table:

- `image_urls text[] NOT NULL DEFAULT '{}'` — array position **is** the display order; first element is the lead image.
- `CHECK (cardinality(image_urls) <= 5)` — the 5-image cap lives in the DB, not just in UI convention.
- **`image_url` (singular) stays untouched.** `RestaurantMenu.tsx` still reads it for the menu-page header, and it remains the fallback for cards whose `image_urls` is empty (§2.4). No drop, no rename, no backfill required — though backfilling `image_urls = ARRAY[image_url]` for rows that have one is a harmless optional step (§3).

Why not a `restaurant_images` table: per-image metadata (captions, per-image RLS, owner uploads) is exactly the v2 feature set we deferred. For "an ordered list of up to 5 public URLs managed by one admin," an array column is one migration, zero new RLS policies, and one fewer join on the hottest customer query.

### 2.4 Count — *up to* 5; graceful degradation below that

5 is a **cap, not a requirement**. The card derives its image list and picks a rendering mode:

| Images available | Card renders |
|---|---|
| 0 (and no legacy `image_url`) | Gradient placeholder, as today |
| 1 | Static image, as today — **no slideshow chrome, no timer, no dots** |
| 2–5 | Auto-playing slideshow + dot indicators |

Derivation rule (single helper, see §5.1): `image_urls` when non-empty, else `[image_url]` when set, else `[]`. This means the feature ships safely with **zero data work** — every existing restaurant just keeps its current single image until you upload more.

### 2.5 No RLS or security changes

`image_urls` is just another column on `restaurants`; the existing customer SELECT policy (`is_active AND is_open`) already covers it. Writes happen via the Supabase Dashboard (service role / admin), so no new write policy is needed. The storage bucket is public-read like the existing image buckets (§4).

### 2.6 Page-weight budget (village mobile data is the constraint)

Five images per card × a dozen visible cards is the real risk of this feature. Hard rules:

- **Each uploaded image ≤ ~120 KB** (same budget the menu-image pipeline enforces; here it's enforced by you at upload time — compress before uploading, e.g. [squoosh.app](https://squoosh.app), WebP or JPEG, ~800×600 — matching the card's 4:3 aspect ratio).
- **Only the first image loads eagerly-ish** (current `loading="lazy"` behaviour). Images 2–5 load lazily and the slideshow only runs while the card is actually visible (§6.2), so an off-screen card costs nothing extra.
- Worst case fully-browsed page: ~5 restaurants × 5 × 120 KB ≈ 3 MB *only if the user keeps every card on screen long enough to cycle* — acceptable; typical cost is far lower because of visibility gating.

---

## 3. Migration (`011_restaurant_card_images.sql`)

```sql
-- 011_restaurant_card_images.sql
ALTER TABLE public.restaurants
  ADD COLUMN image_urls text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(image_urls) <= 5);

COMMENT ON COLUMN public.restaurants.image_urls IS
  'Ordered card-slideshow images (max 5). Position 1 = lead image. '
  'Admin-managed via Supabase Dashboard. Empty = frontend falls back to image_url.';

-- Optional, harmless backfill: seed the array from the existing single image
UPDATE public.restaurants
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL AND image_urls = '{}';
```

After applying: regenerate types — `npx supabase gen types typescript --local` → `src/types/database.ts`. Also update `supabase/seed.sql` so the 5 seed restaurants carry 2–5 image URLs each (use the existing seed image URLs repeated/varied) — otherwise local dev never exercises the slideshow path.

No trigger, no function, no index — the column rides along on the existing `RestaurantList` select.

---

## 4. Image Sourcing & Storage (admin workflow)

One-time per restaurant, done by you:

1. **Bucket:** create (or reuse) a public bucket `restaurant-images` via the Supabase Dashboard. Public read, no anon/owner write — you upload through the Dashboard, which uses your admin session. (Unlike `menu-images`, this bucket needs **no** RLS policies for writes, because owners never write to it. Creating it via the Dashboard rather than a migration is acceptable for an admin-only bucket, but a one-line `INSERT INTO storage.buckets` in migration 011 keeps preview branches self-sufficient — prefer that.)
2. **Layout:** `restaurant-images/{restaurant_id}/1.webp` … `5.webp`. The numeric names are convention only — order is defined by array position in `image_urls`, not by filename.
3. **Compress before upload** (§2.6): 4:3 crop, ~800×600, ≤120 KB, WebP preferred.
4. **Write the URLs:** in the Dashboard table editor, set `image_urls` to the ordered list of public URLs. Lead with the strongest photo — it's also what users with reduced-motion or a 1-image fallback will see.

Legacy note: existing single images (in the old per-restaurant buckets) keep working untouched — either left in `image_url` as the fallback, or promoted into `image_urls[1]` by the backfill in §3.

---

## 5. Frontend Implementation

All changes live in `src/pages/restaurants/` — no routing, context, or shared-lib changes.

### 5.1 `cardImages.ts` — pure helper (testable)

```ts
export function getCardImages(r: { image_urls: string[]; image_url: string | null }): string[] {
  if (r.image_urls.length > 0) return r.image_urls.slice(0, 5);
  return r.image_url ? [r.image_url] : [];
}
```

Lives next to `RestaurantList.tsx` (or in `src/lib/` if preferred); unit-tested per the v1 "pure logic only" testing rule (§8).

### 5.2 `RestaurantCardSlideshow.tsx` — new component

Replaces the `<img>/<placeholder>` block inside `.rlist__card-image`. Props: `{ images: string[]; alt: string }`.

- **0 images** → renders the existing `.rlist__card-image--placeholder` div.
- **1 image** → renders today's single `<img loading="lazy">`. No timer, no dots, no observers — identical to current behaviour.
- **2–5 images** → crossfade stack:
  - All images absolutely positioned in the 4:3 box, `opacity: 0`, current slide `opacity: 1`, `transition: opacity 0.6s ease`. Crossfade (not a translating strip) because the card is small, the images are unrelated photos, and opacity transitions are cheap and don't fight the existing hover `scale(1.04)`.
  - Non-current images get `loading="lazy"` and are `aria-hidden` (§6.1).
  - `setInterval`-driven index advance at `SLIDE_INTERVAL_MS`, gated by §6.2's run conditions. Cleared on unmount.
  - **Dot indicators** (small, bottom-right of the image area, above the gradient overlay): purely visual progress cue, `aria-hidden`, **not** buttons — they sit inside a `<Link>`, and clickable dots would recreate the tap-target conflict §2.1 resolved. Reuses the brand red for the active dot.
  - Stagger the start of each card's timer by `idx * ~700ms` (the grid already staggers its entrance animation with `idx * 70ms`) so the whole grid doesn't flip in lockstep — synchronized flipping reads as glitchy and maximizes simultaneous image decode.

### 5.3 `RestaurantList.tsx` changes (minimal)

- Add `image_urls` to the select: `"id, name, cuisine_type, address, image_url, image_urls, lat, lng"` and to the `RestaurantRow` `Pick<…>`.
- Swap the image block for `<RestaurantCardSlideshow images={getCardImages(r)} alt={r.name} />`.
- Everything else — overlay gradient, distance pill, name, card body, Link semantics — unchanged.

`RestaurantMenu.tsx` is **not** touched (still renders the singular `image_url` in its header). Optionally point it at `getCardImages(...)[0]` later — v2 (§10).

### 5.4 CSS (`RestaurantList.css`)

- New rules for the stacked slides + dots under the existing `.rlist__card-image` block; keep the 4:3 `aspect-ratio` container as the sizing source of truth.
- Extend the existing `@media (prefers-reduced-motion: reduce)` block: kill the crossfade transition (slides cut instantly *if* they advance at all — see §6.1 for the stronger rule).

---

## 6. Accessibility & Performance

### 6.1 Reduced motion & screen readers

- **`prefers-reduced-motion: reduce` disables auto-play entirely** — the card shows the lead image statically (which is why §4 says lead with the strongest photo). Detect via `window.matchMedia` in the component, not CSS alone — CSS can hide the *transition* but only JS can stop the *content change*, and an auto-rotating image region is precisely what reduced-motion users opted out of.
- The slideshow is **decorative**: one image carries `alt={restaurant name}` semantics; non-current slides and the dots are `aria-hidden`. No live-region announcements on slide change (that would spam screen readers every 3.5 s). The card's accessible name remains the visible `<h2>` restaurant name, as today.

### 6.2 Run conditions — the timer only ticks when the slides can be seen

Auto-play runs only when **all** of these hold; otherwise the interval is stopped (not merely skipped):

1. **Card in viewport** — one `IntersectionObserver` per card (threshold ~0.5). Off-screen cards don't tick, don't fetch slides 2–5, don't decode.
2. **Tab visible** — `document.visibilitychange`; backgrounded tabs stop (also prevents the browser-throttled-timer "catch-up burst" on return).
3. **Not hovered** (desktop pause, §2.1).
4. **Reduced motion not requested** (§6.1).

This is the load-bearing performance guard for low-end phones: at any moment only the handful of on-screen cards animate, and lazy slides are fetched at most one card-screenful at a time.

### 6.3 No layout shift

Slides are absolutely positioned inside the fixed `aspect-ratio: 4/3` container, so the slideshow can never cause CLS regardless of image load order — same guarantee the current single image has.

---

## 7. Build Sequence

1. **Migration 011** (§3) — column + CHECK + comment (+ optional bucket INSERT + backfill). Push on a feature branch; the Supabase↔GitHub integration applies it to the PR's preview branch.
2. **Regen `database.ts`**; update `seed.sql` with multi-image seed data.
3. **Helper + tests** — `getCardImages` (§5.1, §8).
4. **`RestaurantCardSlideshow`** component + CSS (§5.2, §5.4), wired into `RestaurantList` (§5.3).
5. **Manual verification:** 0/1/2/5-image cards render per §2.4 table; tap still navigates; hover pauses; backgrounding the tab stops timers (check via DevTools performance panel); reduced-motion (DevTools rendering emulation) shows a static lead image; throttled "Slow 4G" profile confirms slides 2–5 don't load for off-screen cards.
6. **Production data pass:** create the bucket (if not in 011), upload + compress real photos, fill `image_urls` per restaurant (§4).
7. **Docs:** update `CLAUDE.md` (route table `/restaurants` entry + file map) and mirror to `GEMINI.md`.

Deploy outside the 12–2 PM / 7–9:30 PM peak windows, as always.

---

## 8. Testing (v1 scope: pure logic only)

- `cardImages.test.ts` — `getCardImages`: empty array + null `image_url` → `[]`; empty array + legacy `image_url` → `[that]`; non-empty array wins over `image_url`; >5 entries truncated to 5 (defence in depth above the DB CHECK).
- Timer/observer/visibility behaviour is **not** unit-tested (no mocked Supabase / no mocked browser-API rule of thumb in v1) — covered by the manual checklist in §7 Step 5.

---

## 9. Edge Cases

| Case | Behaviour |
|---|---|
| `image_urls = '{}'`, `image_url` set | Single static image (today's behaviour) — via fallback in `getCardImages` |
| Both empty | Gradient placeholder, no timer |
| One URL in the array 404s | That slide shows the browser broken-image state for its 3.5 s; the cycle continues. Optional hardening (v2): `onError` removes the failed slide from rotation |
| Order placed/accepted etc. | Irrelevant — this feature never touches orders |
| Dashboard edit sets >5 array entries | Rejected by the DB CHECK (`cardinality <= 5`) |
| Realtime | Not subscribed — card images update on next page load. Deliberate: image changes are rare, admin-driven, and not worth a channel |

---

## 10. v2 Deferrals (log in `v2_deferred_issues.md` when shipped)

- **Owner self-service photo upload** — "Restaurant photos" section in `/dashboard`, reusing the `menu-images` compression + `SECURITY DEFINER` RLS pattern (§2.2).
- **Swipe gestures / tappable dots** — manual slide control needs a tap-target model that coexists with the card `<Link>` (§2.1, §5.2).
- **`RestaurantMenu` header uses `image_urls[1]`** (§5.3).
- **`onError` slide pruning** for dead URLs (§9).
- **Per-image metadata** (captions, ordering UI) — would justify the `restaurant_images` table this plan rejected (§2.3).
