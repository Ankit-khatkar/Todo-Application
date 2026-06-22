# Customer UI Revamp — Discovery Home Build Plan

> **Status:** Proposed (not yet implemented)
> **Author:** Ankit
> **Goal:** Replace the static marketing landing as the customer's first screen with a **Zomato/Swiggy-style discovery home** — a top address bar + profile, a 1:1 offers/announcements media tile (image *or* video) from the database, a food-category rail (Thali / Pizza / Chinese …), a featured-restaurants rail, and the existing nearby-restaurants grid — so a visitor lands in *food browsing*, not a brochure.
>
> **Hard constraint (from the brief):** **every UI element must map to a real backend data source.** Where the schema can't back an element today, this plan specifies the exact migration that makes it real — we do **not** ship placeholder/fake content (the current `FeaturedRestaurants` hardcodes four restaurants that don't exist in the DB; see §1.2).

> **One-line summary:**
> - **New "Discovery" page becomes the index route** (`/`), reusing and extending today's `RestaurantList`.
> - **New app top bar:** left = **address picker** (GPS/saved-address driven), right = **profile/avatar** (or *Login* when signed out).
> - **New `promotions` table + `promotion-media` storage bucket** → the 1:1 offers/announcements carousel (image **or** muted-loop video).
> - **New `menu_categories` table** → the "What's on your mind?" cuisine rail; tapping a chip filters via the existing `src/lib/search.ts` matcher.
> - **New `restaurants.is_featured` + `featured_rank`** → a real, admin-curated featured rail (replaces the hardcoded fake list).
> - **Optional but recommended: anonymous browsing** (a new public-read RLS path) so a *logged-out* visitor can browse before being asked to sign in at checkout — the literal "new user lands on the restaurant page" ask.

---

## 1. Why This Change

### 1.1 The first screen is a brochure, not a storefront

A first-time visitor hits [`HomePage`](../pages/home/HomePage.tsx) — `Hero → HowItWorks → FeaturedRestaurants → ValueProps → OwnerCTA → TrustSignals → FAQ → Contact → FooterCTA`. It is a marketing page. The actual ordering surface ([`RestaurantList`](../pages/restaurants/RestaurantList.tsx)) is gated behind `/restaurants` and is only reachable after login. Competing apps (Zomato, Swiggy) put **discovery first**: address, offers, cuisines, restaurants — order intent is captured immediately, account creation is deferred to checkout. That funnel converts better, and it's the experience the brief asks for.

### 1.2 The current "featured restaurants" are fabricated

[`FeaturedRestaurants.tsx`](../pages/home/FeaturedRestaurants.tsx) renders a hardcoded array — *Kaffe D Station, Gudha Delight, OM Restaurant, Famous Fast Food* — with emoji, gradient swatches, and tags like "Popular". **None of these rows exist in `public.restaurants`.** This is exactly what the "UI must match the database" rule forbids. The revamp removes this and drives a featured rail from real rows.

### 1.3 The data the new UI needs mostly doesn't exist yet

A blunt audit against the live schema (`001_schema.sql` + migrations through `015`):

| Desired UI element | Backing data today? |
|---|---|
| Address bar (top-left) | **Partial** — `locationCache` (GPS) + `delivery_addresses` exist; no short "locality label" is stored. |
| Profile icon (top-right) | **Yes** — `public.users` via `AuthContext`. |
| Search | **Yes** — `restaurants` + `menu_items` via `src/lib/search.ts`. |
| Offer strip (discount/free-delivery copy) | **Yes** — `discount_config` via `DiscountConfigContext`. |
| **1:1 offers/announcement tile (image/video)** | **No table. No bucket.** |
| **Food-category rail (Pizza/Burger/Thali)** | **No.** `menu_items` has no category; `restaurants.cuisine_type` is free text. |
| **Featured restaurants rail** | **No `is_featured` flag.** |
| Nearby restaurants grid + cards | **Yes** — existing `RestaurantList` + `RestaurantCardSlideshow` (`image_urls`). |
| Ratings / star reviews | **No — and intentionally so** (v2-deferred). We will **not** fake them. |
| Per-restaurant delivery-time ("30 min") | **No field.** ETA is per *order*, set by the owner at accept time (`orders.eta_minutes`). Cards show **distance**, not an invented time. |

So this is mostly a **backend-then-frontend** job: four schema additions (§4) unlock the four missing elements; the rest is composition + restyle.

### 1.4 The auth + RLS wall blocks "new users see restaurants"

The brief says *"when a new user reaches the website … he should see directly the restaurant page."* A **new** user is **logged out**, and today that's impossible:

- `restaurants_customer_select` ([`002_security.sql:102`](../../supabase/migrations/002_security.sql)) requires `get_user_role() = 'customer'`. For the `anon` role `auth.uid()` is `NULL` → `get_user_role()` is `NULL` → **zero rows**. There is **no anon policy**, and `anon` likely has no table `GRANT` either.
- `ProtectedRoute` bounces any unauthenticated visit to `/restaurants` straight to `/login`.

So "land on the restaurant page" has two readings, and we must pick one (§3.1):
- **(A) Anonymous browsing** — add a public read path (new RLS + grants) so logged-out visitors browse; sign-in is deferred to checkout (Zomato model). *Recommended.*
- **(B) Auth-gated** — keep login-first, but make the discovery page the **post-login** home and redirect authed customers there from `/`. No RLS change; smaller blast radius; but a brand-new visitor still sees a login/marketing wall first.

### 1.5 What this is NOT

- **Not** a rewrite of the geolocation engine. The coarse-first/cache/drift machinery in `RestaurantList` (`location_resilience_plan.md`) stays; we *reuse* its cache for the address bar.
- **Not** a new ordering/menu/checkout flow. `RestaurantMenu`, `Checkout`, `place_order`, the cart, pricing, and ETA are untouched except where noted (anon cart persistence, §4.7).
- **Not** ratings, menu-item categories on the menu page, or per-restaurant prep times — those remain v2.

---

## 2. UI → Data Source Map (the contract)

This table is the spine of the "match the database" rule. Build nothing that isn't in the right-hand column.

| # | UI element | Exact source | New backend? |
|---|---|---|---|
| 1 | Address bar label ("📍 Gudha Gorji · 333515") | `locationCache` coords → `reverseGeocode()` (`geocoding.ts`); authed default from `delivery_addresses` (`is_default`) | **Extend** cache to store a `label` string (§4.6) |
| 2 | Address picker sheet (saved + GPS) | `delivery_addresses` via `addressBook.ts`; `getCurrentPositionOnce()` (`geolocation.ts`) | None (reuse 015) |
| 3 | Profile/avatar menu | `AuthContext.profile` (`users.full_name`, `role`); *Login* when `!session` | None |
| 4 | Search box + results | `restaurants` + `menu_items`, filtered by `src/lib/search.ts` | None |
| 5 | **Promo 1:1 carousel (image/video)** | **`promotions`** table + **`promotion-media`** bucket | **NEW (§4.2)** |
| 6 | **Category rail chips** | **`menu_categories`** table (label, image, `match_keywords[]`) | **NEW (§4.3)** |
| 7 | Category filter result | chip's `match_keywords[]` matched against `cuisine_type` + dish names (reuse `search.ts`) | None (consumes #6) |
| 8 | Offer strip copy | `discount_config` via `DiscountConfigContext` (`isLive`) | None |
| 9 | **Featured rail** | `restaurants WHERE is_featured ORDER BY featured_rank` | **NEW column (§4.4)** |
| 10 | Nearby grid | `restaurants` within `RADIUS_KM` (existing haversine) | None |
| 11 | Restaurant card media | `restaurants.image_urls` → `image_url` → placeholder (`getCardImages`) | None |
| 12 | Card distance chip | haversine(`userCoords`, `restaurant.lat/lng`) | None |
| 13 | Veg/non-veg dish dots | `menu_items.is_veg` | None |
| 14 | Cart bar | `CartContext` (`itemCount`, `pricing`) | None (anon needs persistence, §4.7) |

### 2.1 What we deliberately omit (no backing data)

Stated explicitly so a future contributor doesn't "add it to match Zomato":

- **Star ratings / review counts** — no `ratings` table. Omitted, not faked.
- **"Delivery in 30 min" on cards** — no per-restaurant time field; ETA is per-order, post-accept. Cards show **distance**.
- **"₹200 for two" cost-for-two** — not modeled. Omitted.
- **Closed-but-listed greyed cards** — `restaurants_customer_select` only returns `is_open = true`, so closed kitchens are *invisible*, not greyed. Showing greyed "opens at 6pm" cards would require relaxing that RLS to `is_active` (and a client-side grey-out). **Decision D5 (§3.1).** Default: keep open-only — don't tease food a user can't order.

---

## 3. The Approach

### 3.1 Key Decisions — recommended, confirm before build

| # | Decision | Options | **Recommendation** | Blast radius |
|---|---|---|---|---|
| **D1** | Who sees discovery? | (A) Anonymous browse + auth-at-checkout · (B) Auth-gated, discovery is post-login home | **(A) Anonymous** — it's the literal brief and the better funnel; cost is one careful public-read migration (§4.1) + anon cart persistence (§4.7) | High — sets RLS + routing |
| **D2** | What is the index route `/`? | (A) Discovery for everyone · (B) Keep marketing landing, redirect authed customers to discovery | **(A)** Discovery becomes `/`; marketing content relocates to `/partner-program` + `/about` (owner-acquisition keeps a home) | High — routing |
| **D3** | Category backing | (A) `menu_categories` table with `match_keywords[]` (curated chips, keyword filter) · (B) full `restaurant_categories` join (tag every restaurant) · (C) derive from `cuisine_type` only | **(A)** — real, admin-curated chips; deterministic keyword match; no per-restaurant tagging chore at 5-restaurant scale. Upgrade to (B) in v2 if needed | Medium |
| **D4** | Promo media | (A) image **and** video (mp4) · (B) image only | **(A)** — brief explicitly says "play video or images". Video = muted, looped, `playsinline`, ≤ a few MB | Medium |
| **D5** | Show closed restaurants greyed? | (A) No (open-only, current RLS) · (B) Yes (relax RLS to `is_active`, grey client-side) | **(A)** for v1 | Low–Medium |
| **D6** | Featured curation | (A) Manual `is_featured` + `featured_rank` (admin) · (B) Auto (nearest/newest) | **(A)** — predictable, admin-controlled; falls back to nearest when none flagged | Low |

Everything below assumes the recommended path (A/A/A/A/A/A). §3.7 documents the auth-gated (D1-B) variant so the rest of the doc stays decision-independent — **the components are identical; only routing + RLS differ.**

### 3.2 Information architecture

```
/  (index)  →  DiscoveryPage         ← NEW shell; the storefront
                 ├─ AppTopBar         (address picker · profile/avatar)   §4.5
                 ├─ SearchBar         (existing search.ts logic)          §4.9
                 ├─ PromoCarousel     promotions + promotion-media        §4.2/§4.9
                 ├─ CategoryRail      menu_categories                     §4.3/§4.9
                 ├─ OfferStrip        discount_config (existing)
                 ├─ FeaturedRail      restaurants.is_featured             §4.4/§4.9
                 └─ NearbyGrid        existing card grid + slideshow

/restaurants → redirect to /  (alias; keeps existing links/CTAs working)
/restaurants/:id → RestaurantMenu     (unchanged; light restyle optional)
/checkout, /orders, /profile          (unchanged)
/partner-program, /about              (owner/marketing home moves here)
```

The discovery page is **`RestaurantList` evolved**, not a greenfield component — we lift its geolocation effect, `visible` set, search, cart bar, and empty states, and compose the new rails above the grid. This preserves the hard-won location-resilience behaviour.

### 3.3 Mobile layout (primary — tier-3 users are phone-first)

```
┌───────────────────────────────┐
│ 📍 Home  ▾              ( A )  │  AppTopBar: address picker | avatar/Login
│    Gudha Gorji · 333515       │
├───────────────────────────────┤
│ 🔍  Search food or restaurants│  SearchBar (sticky under bar)
├───────────────────────────────┤
│ ┌───────────────────────────┐ │
│ │                           │ │
│ │     PROMO  (1:1)          │ │  PromoCarousel — image OR muted-loop video
│ │   image / video           │ │  swipe; dots; tap → link_url (optional)
│ │            ● ○ ○          │ │
│ └───────────────────────────┘ │
├───────────────────────────────┤
│ What's on your mind?          │
│  ◯    ◯    ◯    ◯    ◯   →    │  CategoryRail — circular thumbs, h-scroll
│ Thali Pizza Chinese Chaat …   │  (image_url from menu_categories)
├───────────────────────────────┤
│ ✨ Up to 11% OFF on ₹200+     │  OfferStrip (discount_config; hidden if !isLive
│    orders · Free delivery ₹150│  → collapses to free-delivery copy)
├───────────────────────────────┤
│ Featured near you             │
│ ┌─────────┐ ┌─────────┐  →    │  FeaturedRail — h-scroll real cards
│ │[slide]  │ │[slide]  │       │
│ │ Sharma… │ │ Punjab… │       │
│ └─────────┘ └─────────┘       │
├───────────────────────────────┤
│ All restaurants · 5 nearby    │
│ ┌───────────────────────────┐ │
│ │ [slideshow]      1.2 km   │ │  NearbyGrid — existing card (1-col mobile)
│ │ Sharma Bhojnalaya         │ │
│ │ Rajasthani, Thali         │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ …                         │ │
│ └───────────────────────────┘ │
├───────────────────────────────┤
│  🛒 2 items · ₹310   View Cart│  sticky cart bar (existing)
└───────────────────────────────┘
```

### 3.4 Desktop layout (≥1024px)

```
┌──────────────────────────────────────────────────────────────┐
│ RedLotus   📍 Home ▾ · Gudha Gorji        🔍 Search    ( A ) │  AppTopBar (wide)
├──────────────────────────────────────────────────────────────┤
│ ┌───────────────┐   What's on your mind?                      │
│ │   PROMO 1:1   │   ◯ Thali  ◯ Pizza  ◯ Chinese  ◯ Chaat  →   │  promo (left) + categories (right)
│ │ image/video   │                                              │
│ │     ● ○ ○     │   ✨ Up to 11% OFF on ₹200+ orders          │
│ └───────────────┘                                              │
├──────────────────────────────────────────────────────────────┤
│ Featured near you                                        →    │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                  │
│ │ card   │ │ card   │ │ card   │ │ card   │                   │
│ └────────┘ └────────┘ └────────┘ └────────┘                  │
├──────────────────────────────────────────────────────────────┤
│ All restaurants · 5 nearby                                    │
│ ┌────────┐ ┌────────┐ ┌────────┐                              │
│ │ card   │ │ card   │ │ card   │   (3-col grid, existing)      │
│ └────────┘ └────────┘ └────────┘                              │
└──────────────────────────────────────────────────────────────┘
```

Tokens unchanged (`design.md`): `red #D63031`, `charcoal #1A1A1A`, `warmBg #fdf8f6`, DM Serif Display headings, Plus Jakarta Sans body, 8px spacing grid, breakpoints 1024/768/480, `lucide-react` icons, 44×44 min touch target.

### 3.5 The address bar — how the label is derived

The bar is the marquee new affordance, so its data path matters:

1. **Authed with a default saved address** → show `delivery_addresses` row where `is_default` (label "Home/Office/<custom>"), pin = its `lat/lng`. This is the delivery target.
2. **Else (authed or anon) with a `locationCache` fix** → show a short **locality label**. Cache stores only coords today; we **extend it to memo a reverse-geocoded `label`** (§4.6) so we don't hit Nominatim on every render (respecting its 1 req/s policy — reverse-geocode once per fix, cache the string).
3. **No fix yet** → show "Set your location ▾"; tapping opens the picker (GPS button + "Gudha Gorji" override = existing `VILLAGE_CENTRE`).

Tapping the bar opens an **address picker sheet**: saved addresses (authed), a "📍 Use current location" button (`getCurrentPositionOnce` → `reverseGeocode` → `LocationConfirmModal`, all shipped in 015), and the village override. Selecting a target sets `userCoords` for the discovery page's radius filter — i.e. the bar and the grid are wired to the same coords.

> The bar **changes the browse origin**, not the order's delivery address. Checkout still captures/confirms the delivery pin per `delivery_address_capture_plan.md`. They share `delivery_addresses` and the geocoding libs, but stay distinct steps.

### 3.6 Category chip → filter (no fuzzy guessing)

Each `menu_categories` row carries `match_keywords text[]` (admin-set, e.g. Pizza → `{pizza, margherita, farmhouse}`; Thali → `{thali, dal baati, rajasthani}`). Tapping a chip runs the **existing** token matcher (`matchesAllTokens` / `restaurantMatches` / `dishMatches` in `search.ts`) with those keywords against in-radius restaurants' `cuisine_type` and their dishes — i.e. a category is a *pre-canned, admin-curated search*. This keeps matching **deterministic and DB-driven** (the rule), reuses tested code, and needs no per-restaurant tagging. The seed cuisine strings already line up ("Pizza, Fast Food", "Rajasthani, Thali", "Chaat, Street Food", "Indo-Chinese") and dishes carry obvious names ("Margherita Pizza", "Veg Burger", "Rajasthani Thali").

### 3.7 The auth-gated variant (if D1 = B)

If anonymous browsing is rejected: skip §4.1 entirely. `DiscoveryPage` stays behind `ProtectedRoute`. Change the index route so authed customers landing on `/` are redirected to discovery (or render discovery at `/` only when `session && role==='customer'`, else the marketing landing). Anon cart persistence (§4.7) becomes unnecessary. **No other section changes** — the rails, top bar, and migrations §4.2–§4.4 are identical, because they read tables that authenticated customers can already see.

---

## 4. Backend Changes

> Migrations are numbered after `015`. Run order matters. After **each**, regenerate types on the Supabase preview branch: `npx supabase gen types typescript --local > src/types/database.ts` (Windows/BOM caveat: see `supabase-type-gen.md`).
> Suggested grouping: **016** = public browse (RLS), **017** = discovery content (promotions + categories + featured). They can be split further or merged; keep each migration's header comment in the existing house style (see 011/015).

### 4.1 **NEW** `016_public_browse.sql` — anonymous read (Decision D1-A only)

Grant the `anon` role read access to the **catalog** so logged-out discovery works, **excluding sensitive columns**.

```sql
-- Anonymous visitors may browse the catalog (open restaurants + their
-- available menu items) before signing in. Sign-in/phone-verification
-- still gate ORDER PLACEMENT (orders_customer_insert is unchanged).

-- (a) restaurants: anon SELECT of open+active rows, SAFE COLUMNS ONLY.
-- Column-level GRANT excludes restaurants.phone (internal/admin) and
-- owner_id (a user FK) from the anon role — RLS limits rows, GRANT limits
-- columns. The customer client never selects phone/owner_id today, so no
-- breakage. (Consider applying the same column grant to the customer role
-- later for defence-in-depth; out of scope here.)
--
-- CRITICAL: REVOKE first. Supabase commonly ships a default table-level
-- SELECT grant to anon on public.* — and a table-level grant OUT-RANKS a
-- column grant, so without the REVOKE the column list is a no-op and anon
-- could still read phone. Revoke the broad grant, then re-grant the subset.
REVOKE SELECT ON public.restaurants FROM anon;
GRANT SELECT (id, name, cuisine_type, address, image_url, image_urls,
              lat, lng, is_open, is_active, created_at, updated_at)
  ON public.restaurants TO anon;

CREATE POLICY restaurants_anon_select ON public.restaurants
  FOR SELECT TO anon
  USING (is_active = true AND is_open = true);

-- (b) menu_items: anon SELECT of available items from visible restaurants.
-- No sensitive columns here, so a table-level grant is fine.
GRANT SELECT ON public.menu_items TO anon;

CREATE POLICY menu_items_anon_select ON public.menu_items
  FOR SELECT TO anon
  USING (
    is_available = true
    AND EXISTS (
      SELECT 1 FROM public.restaurants r
      WHERE r.id = menu_items.restaurant_id
        AND r.is_active = true AND r.is_open = true
    )
  );
```

> **Security review (§5):** this publishes the open-restaurant catalog + menus + coarse coordinates to the public — appropriate for a delivery marketplace (Zomato does the same) and bounded by `is_active AND is_open`. `phone`/`owner_id` stay private. Orders/users/delivery_addresses are **untouched** — no anon access. `place_order` already requires `phone_verified` via `orders_customer_insert`, so anon browsing cannot place orders.

### 4.2 **NEW** `017a` — `promotions` table + `promotion-media` bucket

Mirrors the `discount_config` config-table pattern (006) and the `restaurant-images` admin-managed-bucket pattern (011).

```sql
CREATE TABLE public.promotions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text        NOT NULL,            -- alt text / aria-label / admin ref
  media_url    text        NOT NULL,            -- 1:1 asset in promotion-media bucket
  media_type   text        NOT NULL CHECK (media_type IN ('image','video')),
  link_url     text,                            -- optional click-through (internal path or URL)
  display_order int        NOT NULL DEFAULT 0,  -- ascending; ties broken by created_at
  active       boolean     NOT NULL DEFAULT true,
  starts_at    timestamptz,                     -- NULL = no start bound
  ends_at      timestamptz,                     -- NULL = no end bound
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

COMMENT ON TABLE public.promotions IS
  'Discovery-home 1:1 media tiles (image or muted-loop video). Admin-managed '
  'via Supabase Dashboard; media in the promotion-media bucket. Window-scheduled '
  'like discount_config.';

CREATE TRIGGER set_promotions_updated_at
  BEFORE UPDATE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();   -- reuse 003 helper

-- Cheap index for the live-window query the home runs on every load.
CREATE INDEX idx_promotions_live ON public.promotions (display_order)
  WHERE active;

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.promotions TO anon, authenticated;

-- Public read of live rows only; window evaluated in-policy so clients
-- can't see scheduled/expired promos. Admin manages all.
CREATE POLICY promotions_public_read ON public.promotions
  FOR SELECT
  USING (
    active = true
    AND (starts_at IS NULL OR now() >= starts_at)
    AND (ends_at   IS NULL OR now() <  ends_at)
  );

CREATE POLICY promotions_admin_all ON public.promotions
  FOR ALL USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- promotion-media bucket: public read, admin-uploaded (service role). Larger
-- than image buckets because it holds short MP4s. Tune the limit to taste.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'promotion-media', 'promotion-media', true,
  5242880,  -- 5 MB; keep promo videos short + muted
  ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/webm']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS promotion_media_public_read ON storage.objects;
CREATE POLICY promotion_media_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'promotion-media');
```

> **Realtime is optional.** Unlike `discount_config` (which the frontend subscribes to), promos are fetched once on home load. If you want Dashboard edits to appear without a refresh, add `public.promotions` to `supabase_realtime` with the same `duplicate_object` swallow used in 006 — but it isn't required.

### 4.3 **NEW** `017b` — `menu_categories` table (+ optional `category-icons` bucket)

```sql
CREATE TABLE public.menu_categories (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        NOT NULL UNIQUE,           -- 'pizza', 'thali'
  label         text        NOT NULL,                  -- 'Pizza', 'Thali'
  image_url     text,                                  -- circular thumb (bucket) or NULL → emoji fallback
  match_keywords text[]     NOT NULL DEFAULT '{}',     -- tokens matched vs cuisine_type + dish names
  display_order int         NOT NULL DEFAULT 0,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.menu_categories IS
  'Discovery "What''s on your mind?" rail. A chip is a curated, admin-controlled '
  'search: match_keywords are run through src/lib/search.ts against in-radius '
  'restaurants'' cuisine_type + dish names. No per-restaurant tagging in v1.';

ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.menu_categories TO anon, authenticated;

CREATE POLICY menu_categories_public_read ON public.menu_categories
  FOR SELECT USING (active = true);

CREATE POLICY menu_categories_admin_all ON public.menu_categories
  FOR ALL USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- Optional: a small public bucket for the circular category thumbnails.
-- Skip if you start with emoji/lucide glyphs (image_url NULL).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('category-icons','category-icons', true, 122880,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS category_icons_public_read ON storage.objects;
CREATE POLICY category_icons_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'category-icons');
```

**Seed** (ships with the migration so the rail isn't empty in fresh/preview envs — mirrors `seed.sql` discipline):

```sql
INSERT INTO public.menu_categories (slug, label, match_keywords, display_order) VALUES
  ('thali',   'Thali',   ARRAY['thali','dal baati','rajasthani','bhojnalaya'], 1),
  ('pizza',   'Pizza',   ARRAY['pizza','margherita','farmhouse'],              2),
  ('chinese', 'Chinese', ARRAY['chinese','noodles','manchurian','chow mein','fried rice'], 3),
  ('chaat',   'Chaat',   ARRAY['chaat','pani puri','tikki','samosa','bhel'],   4),
  ('burger',  'Burger',  ARRAY['burger','fries'],                              5),
  ('punjabi', 'Punjabi', ARRAY['punjabi','butter chicken','dal makhani','naan','biryani'], 6)
ON CONFLICT (slug) DO NOTHING;
```

### 4.4 **NEW** `017c` — `restaurants.is_featured` + `featured_rank`

```sql
ALTER TABLE public.restaurants
  ADD COLUMN is_featured   boolean NOT NULL DEFAULT false,
  ADD COLUMN featured_rank int;     -- nullable; lower = earlier; NULL sorts last

COMMENT ON COLUMN public.restaurants.is_featured IS
  'Admin-curated featured rail on the discovery home. featured_rank orders it.';

-- No RLS change: restaurants_customer_select / restaurants_anon_select grant
-- the whole (permitted) row, so the new columns are covered automatically —
-- same as image_urls in migration 011. Add featured_rank to the anon column
-- grant in 016 if anon needs to read it (it does, for the rail):
GRANT SELECT (is_featured, featured_rank) ON public.restaurants TO anon;
```

The featured query: `... WHERE is_featured ORDER BY featured_rank NULLS LAST, created_at`. When **no** row is flagged, the rail **falls back to the nearest N** in-radius restaurants (so it's never empty), or is hidden if there are < 2 nearby. (Decision D6.)

### 4.5 Types regen + `models.ts`

- Regenerate `database.ts` (picks up `promotions`, `menu_categories`, `restaurants.is_featured/featured_rank`, and the new policies don't affect types).
- `models.ts`: add `is_featured: boolean` + `featured_rank: number | null` to `Restaurant`; add `Promotion` and `MenuCategory` interfaces (mirror the Rows). Keep the `UserProfile`-stays-in-AuthContext rule.

---

## 5. Frontend Implementation

> New files marked **NEW**. Symbols referenced by name (line numbers drift).

### 5.1 Routing (`App.tsx`)

- **Index route** renders `DiscoveryPage` instead of `HomePage`. Under D1-A it is **not** wrapped in `ProtectedRoute` (anon allowed); under D1-B, wrap it and redirect.
- Add `/restaurants` → `<Navigate to="/" replace />` (alias) so existing CTAs, `useLandingCtaTarget("order")`, and deep links keep working. Or point `useLandingCtaTarget` "order" target at `/`.
- Marketing `HomePage` is retired from `/`. Preserve its sections by mounting them at `/about` / `/partner-program` (owner funnel), or delete the now-fake `FeaturedRestaurants`. **Keep `InstallPrompt`** — re-mount it on `DiscoveryPage` (it's a phone-landing conversion play).

### 5.2 **NEW** `src/components/AppTopBar.tsx` (+ `.css`)

The persistent discovery header (replaces `Navbar` on the discovery page; `Navbar` stays on marketing/menu/dashboard pages).

- **Left:** address button → `📍 {label} ▾` from §3.5; opens `AddressPickerSheet`.
- **Right:** if `session` → avatar (initial of `profile.full_name`) → menu (Profile, My Orders, Log out); else → "Log in" link. Cart icon with `itemCount` badge (reuse `Navbar`'s pattern).
- Sticky; collapses to a compact row on scroll (reuse `Navbar` scroll logic).

### 5.3 **NEW** `src/components/AddressPickerSheet.tsx` (+ `.css`)

Bottom sheet (mobile) / popover (desktop). Mirrors existing modal mechanics (focus trap/restore, ESC, backdrop, scroll-lock — see `ConfirmOrderModal`/`DeclineModal`). Contents: saved addresses radio list (`listAddresses()`, authed), "📍 Use current location" (→ `getCurrentPositionOnce` → `reverseGeocode` → `LocationConfirmModal`), "Browse Gudha Gorji" override (`VILLAGE_CENTRE`). On select → set discovery `userCoords` + cache label.

### 5.4 **NEW** `src/pages/discovery/DiscoveryPage.tsx` (+ `.css`)

Orchestrator. Lifts from `RestaurantList`: the geolocation effect, `userCoords`/`locationError`/cache hydration, `visible` memo, search state, cart bar, empty states. Adds: `AppTopBar`, `PromoCarousel`, `CategoryRail`, `FeaturedRail`, then the existing grid. Owns category-filter state (selected chip → applies keywords through `search.ts`, reusing the search results UI).

> Implementation approach: **move** `RestaurantList.tsx` → `src/pages/discovery/` and grow it, rather than fork. Keeps one geolocation code path. The file is large but cohesive; split the rails into the child components below.

### 5.5 **NEW** rail components (under `src/pages/discovery/`)

- **`PromoCarousel.tsx`** — fetches `promotions` (RLS already filters to live), renders a 1:1 swipeable track. `media_type==='video'` → `<video autoplay muted loop playsinline preload="metadata">`; else `<img loading="lazy">`. Honour `prefers-reduced-motion` (pause autoplay/auto-advance) — same doctrine as `RestaurantCardSlideshow`. Optional `link_url` → internal `<Link>` or external `<a>`.
- **`CategoryRail.tsx`** — fetches `menu_categories`, horizontal scroll of circular thumbs (`image_url` or emoji fallback). Selecting toggles the discovery filter.
- **`FeaturedRail.tsx`** — horizontal scroll of **real** restaurant cards (reuse `RestaurantCardSlideshow` + card markup), from the featured query (§4.4) intersected with the in-radius `visible` set so we never feature an out-of-range kitchen.

### 5.6 Data layer (**NEW** `src/lib/discovery.ts`)

Thin fetchers (untyped-client casts as elsewhere): `listLivePromotions()`, `listCategories()`. Featured comes from the existing restaurants fetch (add `is_featured, featured_rank` to the select) — no separate round-trip.

### 5.7 `src/lib/locationCache.ts` — add a label (§3.5/§4.6)

Extend the cached shape with an optional `label?: string`; add `writeCachedLabel(label)` / read it alongside coords. Reverse-geocode **once** per accepted fix (in the discovery effect's `acceptFix`), store the string, and the top bar reads it — no per-render Nominatim calls.

### 5.8 Anon cart persistence (D1-A only) — `CartContext`

Today the cart is in-memory ("No localStorage in v1"). For anon browse→order, the cart must **survive the login redirect**. Add `localStorage` (or `sessionStorage`) persistence to `CartContext` (hydrate on mount, write on change). Without this, an anon user who builds a cart and signs in at checkout loses it. Scope it minimally (single-restaurant cart already). **This is the main non-obvious cost of D1-A.**

---

## 6. Security & Privacy

- **Anon catalog exposure (D1-A):** open-restaurant rows + available menu items + coarse coordinates become public. Acceptable for a marketplace; bounded by `is_active AND is_open`. `restaurants.phone` and `owner_id` are withheld by column-level `GRANT` (§4.1). `users`, `orders`, `order_items`, `delivery_addresses` get **no** anon access. Ordering still requires `phone_verified` (`orders_customer_insert`, unchanged).
- **Promotions / categories** are admin-managed content tables — public read of live rows, admin-only write (no owner/customer write). Same trust model as `discount_config`.
- **Address bar reuses 015 privacy posture:** coordinates are PII; reverse-geocoding sends lat/lng to Nominatim (already disclosed). The bar adds **no new third-party** call beyond the one 015 introduced; we *reduce* calls by caching the label.
- **Media buckets** are public-read, admin-write only (service role via Dashboard) — identical to `restaurant-images`. No owner/customer upload path.
- **Secure-context:** GPS needs HTTPS/localhost; LAN dev silently fails (same caveat as 015/location-resilience). QA on a Vercel preview.

---

## 7. Edge Cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Anon visitor, GPS denied/desktop | Address bar shows "Set location ▾"; user taps "Browse Gudha Gorji" (`VILLAGE_CENTRE`) → grid renders. No dead-end. |
| 2 | No live promotions | `PromoCarousel` renders nothing (section hidden) — no empty box. |
| 3 | Promo video fails / slow | `<video>` poster or first frame; on error fall back to hiding that slide. Never block the page. |
| 4 | Category chip matches nothing in radius | Tapping shows the existing "No results" empty state; chip de-selects on clear. |
| 5 | No featured rows flagged | Rail falls back to nearest N (§4.4) or hides if < 2 nearby. |
| 6 | Featured restaurant out of radius | Excluded — featured query is intersected with `visible`. |
| 7 | Anon builds cart, signs in at checkout | Cart persists via §5.8; restored post-login. (Without §5.8 it's lost — that's why §5.8 is required for D1-A.) |
| 8 | Authed customer with default saved address | Top bar shows the saved label/pin; grid origin = that pin. |
| 9 | Closed kitchens | Invisible (RLS), not greyed (D5-A). "All kitchens closed" empty state already exists in `RestaurantList`. |
| 10 | `prefers-reduced-motion` | Promo carousel + card slideshows static; no autoplay. |
| 11 | Owner/admin lands on `/` | Discovery is a customer surface — add an **explicit role redirect** at the index route / `DiscoveryPage` mount (owner → `/dashboard`, admin → `/`), mirroring the post-`SIGNED_IN` gates in `Login.tsx`/`AuthCallback.tsx`. Don't lean on `useLandingCtaTarget` — it computes CTA *link* targets, not page redirects. |
| 12 | Existing `/restaurants` deep links / PWA shortcuts | Aliased to `/` (§5.1) — no 404. |
| 13 | Stale PWA serving old bundle | `autoUpdate` SW activates on first reload (CLAUDE.md PWA notes) — no two-load lag. |
| 14 | Slow network | Each section loads independently (promos/categories/featured/grid); skeletons per section; grid is the priority. |

---

## 8. Rollout Sequence

One feature, landed as focused commits / a few PRs (mirrors 015's sequencing). **Deploy off-peak** (avoid 12–2 PM, 7–9:30 PM IST). **QA on HTTPS** (geolocation).

1. **Migrations** — `016_public_browse` (if D1-A) + `017_discovery_content` (promotions + categories + featured + seed). Apply on the Supabase preview branch; **regen `database.ts`**; update `models.ts`. No UI change yet. Manually add 1–2 promotions + a few featured flags via Dashboard so the next phases have real data.
2. **Pure/data libs + tests** — `discovery.ts`, `locationCache` label, `Promotion`/`MenuCategory` models; category-keyword matching test (reuse `search.test.ts` patterns). `npm test` green.
3. **App top bar + address picker** — `AppTopBar`, `AddressPickerSheet`; wire to existing geolocation + `addressBook`. Ship on a `/discovery` preview route first to de-risk.
4. **Discovery page** — move/grow `RestaurantList` → `DiscoveryPage`; compose rails (`PromoCarousel`, `CategoryRail`, `FeaturedRail`) above the grid; category filter via `search.ts`.
5. **Flip the index route** — `/` → `DiscoveryPage`; `/restaurants` → alias; relocate/retire marketing `HomePage`; re-mount `InstallPrompt`. (D1-A: also land §5.8 cart persistence **before** this, or anon carts break.)
6. **Anon enablement** (D1-A) — confirm logged-out browse end-to-end (catalog visible, cart persists, checkout prompts login + phone-verify). 
7. **Docs sync** (§9) + polish (card restyle, reduced-motion, a11y pass, Lighthouse).

Each phase is shippable: 1–4 add capability behind the unchanged `/`; only phase 5 changes what visitors land on.

---

## 9. Docs to Sync

- **This file** — the design of record.
- **`CLAUDE.md` + `GEMINI.md`** (lockstep):
  - Routes table: `/` now `DiscoveryPage` (note anon access under D1-A); `/restaurants` aliased; marketing home relocated.
  - Database section: add `promotions`, `menu_categories`, `restaurants.is_featured/featured_rank`; note anon RLS + column grants; the two new public buckets.
  - RLS summary: add `promotions`, `menu_categories` (public-read/admin-write); `restaurants`/`menu_items` anon SELECT.
  - File map: `src/pages/discovery/*`, `AppTopBar`, `AddressPickerSheet`, `src/lib/discovery.ts`; `locationCache` label.
  - Landing-page section: the fake `FeaturedRestaurants` is gone; CTAs/`useLandingCtaTarget` point at `/`.
- **`v2_deferred_issues.md`** — note menu-item categories / ratings / per-restaurant ETA remain deferred and are *intentionally absent* from discovery; the `restaurant_categories` join is the v2 upgrade from keyword matching.
- **`design.md`** — add the discovery layout, the 1:1 promo ratio, and category-thumb spec to §8/§10.
- **Privacy policy** — only if D1-A changes data sharing; it doesn't add a new processor (Nominatim/Maps already disclosed in 015), but note the public catalog is browsable pre-login.

---

## 10. Open Questions (need Ankit's sign-off)

1. **D1 — anonymous browsing?** Recommend **yes (A)**: it's the literal brief and the better funnel. Cost = the `016` public-read migration + cart persistence (§5.8). If you'd rather keep login-first for now, we take D1-B and skip both (§3.7).
2. **D2 — does `/` become discovery for everyone, retiring the marketing landing there?** Recommend **yes**; owner-acquisition content lives on `/partner-program` + `/about`. Confirm you're OK losing the brochure as the literal homepage (it stays reachable, just not at `/`).
3. **D3 — category backing:** keyword-matched `menu_categories` (recommended) vs a full `restaurant_categories` join. Confirm keyword matching is acceptable for launch.
4. **D4 — promo video:** confirm we support MP4 (muted, looped, ≤5 MB) and not image-only. Affects the bucket mime list + `<video>` component.
5. **D5 — show closed restaurants greyed?** Recommend **no** for v1 (RLS already hides them). Flipping later needs an RLS relax + client grey-out.
6. **D6 — featured curation** is manual (`is_featured`) with nearest-N fallback. Confirm, or specify an auto rule.
7. **Who maintains promos/categories/featured?** Assumed **Ankit via Supabase Dashboard** (no admin UI — consistent with the "no `/admin` routes" stance). Confirm; a tiny admin surface is a v2 option.
8. **Address bar = browse origin only** (not the order's delivery address). Confirm that mental model (they share data but are distinct steps).

---

## 11. Summary

The discovery home is **composition over invention**: it reuses the geolocation engine, restaurant cards, search matcher, cart, and offer copy that already exist, and adds a top bar + three rails on top. The work that's genuinely *new* is four small, convention-following backend pieces — **anon read access, a `promotions` media table + bucket, a `menu_categories` chip table, and an `is_featured` flag** — because the brief's "match the database" rule means we make the data real rather than fake the UI (and we delete the fabricated `FeaturedRestaurants` to honour it). The single load-bearing decision is **D1 (anonymous browsing)**; everything else is additive and the components are identical either way.
