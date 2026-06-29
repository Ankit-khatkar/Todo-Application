# Reviews & Ratings (Restaurants + Dishes) — Build Plan

> **Status:** **Design — not started.** This document is the implementation plan; no migrations or code have been written yet. Supersedes the *ratings* line item in the v2-deferred list (CLAUDE.md → "v2-deferred") — ratings are being pulled forward.
> **Duration:** ~2–3 days (one migration + one RPC + two triggers + shared star components + one new customer route + display wiring on three existing surfaces + one new owner route + tests).
> **Goal:**
> 1. **Customers rate what they bought** — after an order is *delivered*, the customer can give the **restaurant** a 1–5★ rating (+ optional comment) and rate **the specific dishes** they ordered (1–5★ + optional comment). Verified-purchase only: no order, no review.
> 2. **Ratings surface to shoppers** — an aggregate ★ rating shows on the discovery cards, the restaurant menu header, and each dish row (the Zomato/Swiggy pattern), so customers can choose with confidence.
> 3. **Owners see their reviews to improve** — a read-only `/dashboard/reviews` surface shows the restaurant's overall rating, the star distribution, recent written reviews, and a **per-dish rating breakdown sorted worst-first**, so an owner can see exactly which dishes are dragging quality down and act on it.
> **Prerequisites:** none external — two new tables + denormalized aggregate columns on existing tables, one RPC, two triggers, and frontend. No new services, no new Edge Functions, no new cron, no new third-party dependency.

---

## 1. Why This Feature Exists

RedLotus today is a one-way street: a customer can order, but the platform has no memory of whether the food was good. New customers browsing the discovery storefront see name, cuisine, distance, and a slideshow — but no social proof, which is the single strongest conversion signal on every food platform they've used (Zomato, Swiggy). And the owner, who is paying a flat subscription precisely to grow, gets **zero structured feedback** — they hear about a bad biryani only if the customer bothers to WhatsApp Ankit. A review system closes both gaps with one schema:

- **For the shopper:** a ★ on the card and on the dish turns "five unknown kitchens" into "the 4.6 thali place vs the 3.9 one." This is the highest-leverage trust signal we can add to the storefront, and it's the thing returning customers will look for first.
- **For the owner:** "your Paneer Tikka is averaging 2.8★ across 14 ratings" is *actionable* in a way no other v1 surface is. The stated goal — *"so owners can see their reviews and improve their quality and performance"* — is served directly by the per-dish breakdown in §10.

The integrity backbone that makes this safe (and makes the ratings trustworthy) is **verified purchase**: a review is always tied to a real `completed` order belonging to the reviewer. This is the same insight that anchored the cancellation feature (`customer_cancellation_and_eta_plan.md` §1) — bind the new customer action to the order it concerns, and most abuse vectors close themselves.

---

## 2. Scope & Product Decisions

Each decision below is deliberate; the rejected alternatives are recorded the way the rest of `src/docs/` records them.

### 2.1 Verified purchase only — a review is tied to a `completed` order

A review references a specific `orders.id`. Eligibility is exactly: **the order belongs to the reviewer (`customer_id = auth.uid()`) and its status is `completed`.** This is the whole integrity story:

- No order → no review (kills drive-by / competitor / bot reviews — the thing that makes anonymous review systems worthless).
- Not delivered → no review (`pending`/`accepted`/`preparing`/`out_for_delivery` can't be rated; nothing was eaten yet). `declined`/`expired`/`cancelled` are never eligible — no food changed hands.
- The order also tells us, server-side, **which dishes** the customer may rate (the `order_items` rows) and **who they are** (`orders.customer_name` snapshot) — so none of that is trusted from the client.

A customer who orders the same dish in two different orders may rate it twice (once per order). That's intended: each delivered order is an independent data point, exactly like Zomato counts each visit.

### 2.2 What gets rated — the restaurant (one per order) + dishes (per item in the order)

Two granularities, mirroring Swiggy's "rate your order" + "rate your items":

- **Restaurant review** — one 1–5★ rating + optional free-text comment, **one per order** (`UNIQUE(order_id)`). This is the primary, required signal.
- **Dish review** — one 1–5★ rating + optional comment per dish that was in the order, **one per `(order_id, menu_item_id)`**. Optional, and a *subset* of the order's items (the customer can rate the dish that stood out and skip the rest).

Both are 1–5 integer stars. Half-stars are display-only (an aggregate of 4.3 renders as four-and-a-bit) — the input is always a whole star, which is what every consumer expects to tap.

### 2.3 Two tables, not one nullable-`menu_item_id` table

**Decision:** `restaurant_reviews` and `dish_reviews` as separate tables.

The unified alternative — one `reviews` table with a nullable `menu_item_id` (NULL = restaurant-level) — was considered and rejected:

- The uniqueness rules genuinely differ (`UNIQUE(order_id)` for the restaurant review vs `UNIQUE(order_id, menu_item_id)` for dish reviews). Expressing both on one table needs two *partial* unique indexes over a nullable column — more surface, less obvious, easy to get subtly wrong.
- The two feed **different denormalization targets** (`restaurants.rating_avg` vs `menu_items.rating_avg`) and **different read surfaces** (card/menu-header vs dish-row). Separate tables keep each trigger and each query trivially scoped.
- They will **diverge in v2**: restaurant reviews grow owner replies, photos, and tags; dish reviews stay lightweight star-first. Splitting now avoids a wide sparse table later.

This matches the codebase's explicit-over-clever ethos — the same reasoning that gave `cancelled` its own enum value instead of overloading `declined` (`customer_cancellation_and_eta_plan.md` §2.1.2).

### 2.4 Restaurant rating required; dish ratings optional

The submission requires the restaurant star (the primary signal we always want) and treats dish ratings as a bonus the customer may add for any subset of the order's items. Comments are optional on both, capped at 1000 chars. This keeps the fast path one tap + submit, while letting a motivated customer leave rich per-dish feedback — the exact Zomato/Swiggy gradient.

### 2.5 Write path — a `submit_order_review` RPC, **not** a direct INSERT policy

Mirrors `place_order` / `cancel_order` exactly. Reviews are written **only** through a `submit_order_review(...)` SECURITY DEFINER RPC; customers get **zero** direct INSERT/UPDATE grants on either review table. Reasons, in order of weight:

1. **Atomic multi-row write.** One "rate your order" submission writes the restaurant review *and* N dish reviews. As separate client `.insert()` calls, a mid-way failure leaks a half-saved review set — the precise orphan problem `place_order` exists to prevent (CLAUDE.md: *"Two separate `.from().insert()` calls leak orphans on partial failure"*). The RPC writes them in one transaction.
2. **Server-derived trust fields.** `restaurant_id`, `customer_id`, and `customer_name` are read from the order **inside** the function — the client can't forge which restaurant it's rating or whose name appears. The verified-purchase checks (`completed` status, and "this dish was actually in this order") live here too.
3. **Idempotent edit for free.** The RPC upserts (`ON CONFLICT … DO UPDATE`), so "edit my rating" is the same call — no separate update path, no separate policy.
4. **Consistency.** It's the established pattern for every non-trivial customer write in this codebase.

A pure-RLS INSERT path *was* technically expressible here (unlike cancellation, the WITH CHECK could encode verified-purchase via `EXISTS` subqueries) — but reasons 1–3 still favor the RPC, and a partial write is a worse failure than a slightly heavier function.

### 2.6 Reviews are public-read; `customer_id` is withheld; names render abbreviated

Ratings must be visible to **anonymous** shoppers (the storefront is anon-first, migration 016), so review SELECT is public — `anon` + `authenticated`, the same trust tier as `promotions`/`menu_categories`.

- **Column grant withholds `customer_id`.** The only sensitive column on a review is the reviewer's user FK. Following the 016 doctrine (withhold `owner_id`/`phone` from anon at the column-GRANT level), anon + authenticated are granted every column **except `customer_id`**. The customer themselves never needs to read `customer_id` client-side (they reach their review via their own `order_id`); admin and the definer RPC retain full access.
- **Display name is a snapshot, rendered abbreviated.** Anon cannot read `public.users`, so to show a reviewer name on a public surface the name must be **denormalized onto the review row** (`customer_name`, snapshot from `orders.customer_name` — same snapshot doctrine as the order itself). The frontend renders it as first name + last initial ("Ankit K.") via a `ratings.ts` helper. Conscious privacy trade-off: a first-name-plus-initial tied to a public review is the Zomato norm and fine for a single-village user base; full names / avatars are explicitly out. (Owners already see the full `customer_name` on order cards, so this adds no new *owner*-facing exposure — only public-facing, abbreviated.)

### 2.7 Aggregates — denormalized counters on `restaurants` + `menu_items`, refreshed by triggers

**Decision:** add `rating_avg numeric(2,1)` + `rating_count int` to **both** `restaurants` and `menu_items`, maintained by `AFTER INSERT/UPDATE/DELETE` triggers on the review tables.

The read path is the hot path here — *every* discovery-card render and *every* menu row wants a rating, and the discovery page is the index route under first-paint pressure. Denormalized columns make those reads a **single flat query with zero extra round-trips**: the storefront just adds two fields to its existing `restaurants` select, exactly as `is_featured`/`featured_rank` rode into the same query in migration 017. The menu page does likewise for dishes.

The rejected alternative — **compute-on-read via a SQL view** (`AVG`/`COUNT` over the review tables) — is simpler on the write side (no trigger, no denormalized state to drift) but forces either a second query + client-side merge on the storefront's hot path or a heavier embedded aggregate. At a read-heavy workload we deliberately pay a little write-side complexity (a trigger that fires only when someone submits a review — rare) to keep reads cheap. The trigger **recomputes from scratch** for the one affected `restaurant_id`/`menu_item_id` (`AVG`,`COUNT` over its reviews) rather than maintaining incremental sums — drift-proof, and trivially cheap at v1 volume.

`rating_avg` is `NULL` and `rating_count` is `0` until the first review lands — the frontend treats `rating_count = 0` as "New" (no stars), never "0.0★".

### 2.8 Editable; one review per order; no moderation in v1

Re-submitting overwrites (the RPC upsert), so a customer can fix or update their rating any time — friendly, and the aggregate trigger keeps totals correct on every edit. No moderation queue, no profanity filter, no owner replies in v1 (all §15 deferrals). The verified-purchase gate already removes the worst abuse class; moderation is only worth building once volume justifies it.

### 2.9 Eligibility has no expiry window

Any `completed` order is reviewable indefinitely (Zomato/Swiggy behavior). A "review within 14 days" window was considered and rejected for v1 — it adds clock logic for no benefit at current scale. Logged as a possible v2 tightening (§15).

### 2.10 No Realtime

Ratings don't need live push. The owner reviews page and all display surfaces fetch on load (the `discount_config`/`promotions` model). Adding `restaurant_reviews` to the Realtime publication is a clean v2 nicety (live "new review" toast on the dashboard) but unnecessary now — keep the surface area small.

### 2.11 Data model at a glance

```
orders (status='completed') ──1:1── restaurant_reviews ──┐
   │                                                       ├─▶ restaurants.rating_avg / rating_count   (trigger)
   └── order_items ──N── dish_reviews ─────────────────────┘
                          │
                          └────────────────────────────────▶ menu_items.rating_avg / rating_count     (trigger)

restaurant_reviews : UNIQUE(order_id)                 — one restaurant rating per delivered order
dish_reviews       : UNIQUE(order_id, menu_item_id)   — one rating per dish per delivered order
both               : customer_id (withheld from anon), restaurant_id + customer_name (snapshot), rating 1–5, comment?
write path         : submit_order_review() RPC only   — verified-purchase, atomic, upsert
read path          : public (anon + authenticated), customer_id withheld at column grant
```

---

## 3. Migration — `019_reviews_and_ratings.sql`

One cohesive migration (no new enum value, so the split rule of `012`/`013` doesn't apply). Sectioned like `017`. Full SQL:

```sql
-- ============================================================
-- 019_reviews_and_ratings.sql
-- Customer reviews & ratings for restaurants and dishes
-- (verified-purchase, tied to a completed order — Zomato/Swiggy style).
--   (1) restaurant_reviews — one 1–5★ (+ optional comment) per
--       completed order. UNIQUE(order_id).
--   (2) dish_reviews — one 1–5★ (+ optional comment) per dish that
--       was actually in the order. UNIQUE(order_id, menu_item_id).
--   (3) denormalized rating_avg / rating_count on restaurants +
--       menu_items, refreshed by AFTER-write triggers, so the hot
--       read paths (discovery cards, menu rows) stay single flat
--       queries (same doctrine as restaurants.is_featured / 017).
--   (4) submit_order_review RPC — the ONLY write path; SECURITY
--       DEFINER, verified-purchase gated, atomic restaurant + dish
--       upsert (mirrors place_order / cancel_order). Customers keep
--       zero direct write grants on the review tables.
--   (5) Public read of reviews (anon + authenticated); customer_id
--       withheld at the column-GRANT level (privacy; mirrors the
--       016 owner_id/phone doctrine). Admin full.
-- See src/docs/reviews_and_ratings_plan.md for the design.
-- Run this NINETEENTH (after 018_owner_policies_authenticated.sql).
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. restaurant_reviews
-- ════════════════════════════════════════════════════════════
CREATE TABLE public.restaurant_reviews (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL UNIQUE REFERENCES public.orders(id)      ON DELETE CASCADE,
  customer_id   uuid        NOT NULL        REFERENCES public.users(id)        ON DELETE CASCADE,
  restaurant_id uuid        NOT NULL        REFERENCES public.restaurants(id)  ON DELETE CASCADE,
  customer_name text        NOT NULL,                       -- snapshot of orders.customer_name; rendered abbreviated client-side
  rating        int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text        CHECK (comment IS NULL OR length(btrim(comment)) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.restaurant_reviews IS
  'One verified-purchase restaurant rating (1-5) + optional comment per '
  'completed order. Written only via submit_order_review(). Public-read; '
  'customer_id withheld from anon/authenticated at the column grant.';

CREATE INDEX idx_restaurant_reviews_restaurant
  ON public.restaurant_reviews (restaurant_id, created_at DESC);

CREATE TRIGGER set_restaurant_reviews_updated_at
  BEFORE UPDATE ON public.restaurant_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();   -- reuse 003

-- ════════════════════════════════════════════════════════════
-- 2. dish_reviews
-- ════════════════════════════════════════════════════════════
CREATE TABLE public.dish_reviews (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL        REFERENCES public.orders(id)       ON DELETE CASCADE,
  customer_id   uuid        NOT NULL        REFERENCES public.users(id)        ON DELETE CASCADE,
  restaurant_id uuid        NOT NULL        REFERENCES public.restaurants(id)  ON DELETE CASCADE,
  menu_item_id  uuid        NOT NULL        REFERENCES public.menu_items(id)   ON DELETE CASCADE,
  customer_name text        NOT NULL,
  rating        int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text        CHECK (comment IS NULL OR length(btrim(comment)) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, menu_item_id)
);

COMMENT ON TABLE public.dish_reviews IS
  'One verified-purchase dish rating (1-5) + optional comment per '
  '(order, menu_item). The dish must have been in the order (enforced in '
  'submit_order_review). restaurant_id is denormalized for owner/menu reads.';

CREATE INDEX idx_dish_reviews_menu_item
  ON public.dish_reviews (menu_item_id, created_at DESC);
CREATE INDEX idx_dish_reviews_restaurant
  ON public.dish_reviews (restaurant_id, created_at DESC);

CREATE TRIGGER set_dish_reviews_updated_at
  BEFORE UPDATE ON public.dish_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ════════════════════════════════════════════════════════════
-- 3. Denormalized aggregate columns (hot read path)
-- ════════════════════════════════════════════════════════════
-- NULL avg + 0 count until the first review. No backfill needed — no
-- reviews exist at deploy time. numeric(2,1) holds 1.0–5.0.
ALTER TABLE public.restaurants
  ADD COLUMN rating_avg   numeric(2,1),
  ADD COLUMN rating_count int NOT NULL DEFAULT 0;

ALTER TABLE public.menu_items
  ADD COLUMN rating_avg   numeric(2,1),
  ADD COLUMN rating_count int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.restaurants.rating_avg IS
  'Denormalized AVG(restaurant_reviews.rating), 1 decimal. NULL = no '
  'ratings yet (frontend renders "New"). Maintained by trigger.';
COMMENT ON COLUMN public.menu_items.rating_avg IS
  'Denormalized AVG(dish_reviews.rating) for this item. NULL = unrated.';

-- ════════════════════════════════════════════════════════════
-- 4. Aggregate-refresh helpers + triggers
-- ════════════════════════════════════════════════════════════
-- Recompute-from-scratch for the one affected parent (drift-proof; cheap
-- at v1 volume). SECURITY DEFINER so aggregate maintenance never depends
-- on the writer's RLS/grants (the writer is the definer RPC, but admin
-- Dashboard edits or a future path must update the cache too).

CREATE OR REPLACE FUNCTION public.refresh_restaurant_rating(p_restaurant_id uuid)
RETURNS void AS $$
  UPDATE public.restaurants r
  SET rating_count = agg.cnt,
      rating_avg   = agg.avg            -- NULL when cnt = 0 (AVG of no rows)
  FROM (
    SELECT COUNT(*) AS cnt, ROUND(AVG(rating), 1) AS avg
    FROM public.restaurant_reviews
    WHERE restaurant_id = p_restaurant_id
  ) agg
  WHERE r.id = p_restaurant_id;
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.refresh_dish_rating(p_menu_item_id uuid)
RETURNS void AS $$
  UPDATE public.menu_items m
  SET rating_count = agg.cnt,
      rating_avg   = agg.avg
  FROM (
    SELECT COUNT(*) AS cnt, ROUND(AVG(rating), 1) AS avg
    FROM public.dish_reviews
    WHERE menu_item_id = p_menu_item_id
  ) agg
  WHERE m.id = p_menu_item_id;
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.on_restaurant_review_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_restaurant_rating(OLD.restaurant_id);
    RETURN OLD;
  END IF;
  PERFORM public.refresh_restaurant_rating(NEW.restaurant_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.on_dish_review_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_dish_rating(OLD.menu_item_id);
    RETURN OLD;
  END IF;
  PERFORM public.refresh_dish_rating(NEW.menu_item_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_restaurant_review_change
  AFTER INSERT OR UPDATE OR DELETE ON public.restaurant_reviews
  FOR EACH ROW EXECUTE FUNCTION public.on_restaurant_review_change();

CREATE TRIGGER trg_dish_review_change
  AFTER INSERT OR UPDATE OR DELETE ON public.dish_reviews
  FOR EACH ROW EXECUTE FUNCTION public.on_dish_review_change();

-- ════════════════════════════════════════════════════════════
-- 5. RLS + grants (public read, customer_id withheld; admin full)
-- ════════════════════════════════════════════════════════════
ALTER TABLE public.restaurant_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_reviews       ENABLE ROW LEVEL SECURITY;

-- Brand-new tables have NO default grants — grant the SAFE subset only.
-- customer_id is deliberately excluded (the one sensitive column).
GRANT SELECT (id, order_id, restaurant_id, customer_name, rating, comment,
              created_at, updated_at)
  ON public.restaurant_reviews TO anon, authenticated;

GRANT SELECT (id, order_id, restaurant_id, menu_item_id, customer_name, rating,
              comment, created_at, updated_at)
  ON public.dish_reviews TO anon, authenticated;

-- Public read of all reviews (the point — social proof for shoppers,
-- incl. anonymous). Writes go exclusively through submit_order_review
-- (SECURITY DEFINER → bypasses RLS); no customer/owner write policy.
CREATE POLICY restaurant_reviews_public_read ON public.restaurant_reviews
  FOR SELECT USING (true);
CREATE POLICY dish_reviews_public_read ON public.dish_reviews
  FOR SELECT USING (true);

CREATE POLICY restaurant_reviews_admin_all ON public.restaurant_reviews
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
CREATE POLICY dish_reviews_admin_all ON public.dish_reviews
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

-- Extend the anon COLUMN grant on restaurants to the two new columns (016
-- replaced the table grant with an explicit column list, so new columns are
-- NOT auto-covered — same step 017 took for is_featured/featured_rank).
GRANT SELECT (rating_avg, rating_count) ON public.restaurants TO anon;
-- menu_items keeps a TABLE-level anon grant (016), so its new columns are
-- already covered — no GRANT needed here (intentional asymmetry).

-- ════════════════════════════════════════════════════════════
-- 6. submit_order_review RPC — the ONLY write path
-- ════════════════════════════════════════════════════════════
-- Verified-purchase: the order must belong to the caller and be completed.
-- restaurant_id / customer_name come from the order snapshot (never the
-- client). Restaurant rating required; dish ratings optional and must each
-- correspond to a dish that was in the order. Upsert => editing is the same
-- call. Stable error prefixes (REVIEW_NOT_ELIGIBLE: / INVALID_RATING:) are a
-- contract the frontend pattern-matches (same idea as PRICING_MISMATCH:).
CREATE OR REPLACE FUNCTION public.submit_order_review(
  p_order_id           uuid,
  p_restaurant_rating  int,
  p_restaurant_comment text  DEFAULT NULL,
  p_dish_reviews       jsonb DEFAULT '[]'::jsonb   -- [{ "menu_item_id": uuid, "rating": int, "comment": text? }]
) RETURNS void AS $$
DECLARE
  v_order        public.orders%ROWTYPE;
  v_dish         jsonb;
  v_menu_item_id uuid;
  v_rating       int;
  v_comment      text;
BEGIN
  -- (a) Authorise: own order + delivered.
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND customer_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_NOT_ELIGIBLE: order not found for this customer';
  END IF;
  IF v_order.status <> 'completed' THEN
    RAISE EXCEPTION 'REVIEW_NOT_ELIGIBLE: only delivered orders can be reviewed';
  END IF;

  -- (b) Restaurant rating (required). Trust fields from the order snapshot.
  IF p_restaurant_rating IS NULL OR p_restaurant_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'INVALID_RATING: restaurant rating must be between 1 and 5';
  END IF;

  INSERT INTO public.restaurant_reviews
    (order_id, customer_id, restaurant_id, customer_name, rating, comment)
  VALUES
    (v_order.id, v_order.customer_id, v_order.restaurant_id, v_order.customer_name,
     p_restaurant_rating, NULLIF(btrim(p_restaurant_comment), ''))
  ON CONFLICT (order_id) DO UPDATE
    SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now();

  -- (c) Dish ratings (optional subset; each must be in the order).
  FOR v_dish IN
    SELECT * FROM jsonb_array_elements(COALESCE(p_dish_reviews, '[]'::jsonb))
  LOOP
    v_menu_item_id := (v_dish->>'menu_item_id')::uuid;
    v_rating       := (v_dish->>'rating')::int;
    v_comment      := NULLIF(btrim(v_dish->>'comment'), '');

    IF v_rating IS NULL OR v_rating NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'INVALID_RATING: dish rating must be between 1 and 5';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.order_items
      WHERE order_id = v_order.id AND menu_item_id = v_menu_item_id
    ) THEN
      RAISE EXCEPTION 'REVIEW_NOT_ELIGIBLE: a rated dish was not in this order';
    END IF;

    INSERT INTO public.dish_reviews
      (order_id, customer_id, restaurant_id, menu_item_id, customer_name, rating, comment)
    VALUES
      (v_order.id, v_order.customer_id, v_order.restaurant_id, v_menu_item_id,
       v_order.customer_name, v_rating, v_comment)
    ON CONFLICT (order_id, menu_item_id) DO UPDATE
      SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

After applying: regenerate `src/types/database.ts` (`npx supabase gen types typescript --local`) so the two new tables + the new `restaurants`/`menu_items` columns appear; add the model types in §7.1. Until regen lands, hand-extend the placeholder (same note as every prior migration).

**RLS reasoning recap (for the CLAUDE.md "RLS summary" update, §14):**
- `restaurant_reviews` / `dish_reviews`: **public read** of all rows (`anon` + `authenticated`), `customer_id` withheld at the column grant; **admin full**; **no customer/owner write policy** — writes go through `submit_order_review` only. Same write doctrine as `orders` + `cancel_order`.
- `restaurants` / `menu_items`: unchanged policies; the two new aggregate columns are covered by existing row grants (and, for anon on `restaurants`, by the explicit column-grant extension above).

---

## 4. Frontend — shared primitives

### 4.1 Types (`src/types/models.ts`)

```ts
export interface RestaurantReview {
  id: string;
  order_id: string;
  restaurant_id: string;
  customer_name: string;      // snapshot; render abbreviated
  rating: number;             // 1–5
  comment: string | null;
  created_at: string;
  updated_at: string;
}                              // note: customer_id is NOT selectable (withheld)

export interface DishReview extends RestaurantReview {
  menu_item_id: string;
}
```

Add `rating_avg: number | null` + `rating_count: number` to the existing `Restaurant` **and** `MenuItem` interfaces (they mirror the new columns, like `is_featured`/`featured_rank` were added in the 017 work).

### 4.2 Pure helpers — `src/lib/ratings.ts` (+ `ratings.test.ts`)

All display math lives here so it's unit-testable (the `geo.ts`/`eta.ts`/`pricing.ts` extraction rationale). No Supabase imports.

```ts
export const STAR_FILLED = "filled", STAR_HALF = "half", STAR_EMPTY = "empty";

/** "4.3" | "New" — what the card/menu badge shows. */
export function formatRatingAverage(avg: number | null, count: number): string;

/** "4.3 (12)" | "12 ratings" | "New" — longer label for headers. */
export function formatRatingLabel(avg: number | null, count: number): string;

/** Map an average to five "filled|half|empty" tokens for <StarRating>. */
export function starTokens(avg: number): ("filled"|"half"|"empty")[];

/** "Ankit K." from "Ankit Khatkar" — public reviewer display. */
export function displayReviewerName(fullName: string): string;

/** { 5: n, 4: n, 3: n, 2: n, 1: n } from a list of ratings — owner distribution bars. */
export function ratingDistribution(ratings: number[]): Record<1|2|3|4|5, number>;
```

### 4.3 Star components — `src/components/StarRating.tsx`, `StarRatingInput.tsx` (+ CSS)

- **`StarRating`** — read-only display. Props `{ avg: number; size?: number }`; renders five glyphs from `starTokens(avg)` (lucide `Star` with a half-fill clip, or two stacked icons). Used on cards, menu header, dish rows, order pages, owner page. Pure, no data fetching.
- **`StarRatingInput`** — interactive picker for the review form. A keyboard-accessible radio group (`role="radiogroup"`, arrow-key + 1–5 number support, `aria-label`), hover/focus preview, controlled `value`/`onChange`. Mirrors the chip-group mechanics already in `AcceptOrderModal`.

New local color token **`starGold #F5A623`** (amber, the universal rating color) — declared per-component per the "tokens defined locally" convention; the FSSAI veg/non-veg greens/reds are untouched.

### 4.4 Data layer — `src/lib/reviews.ts`

Mirrors `addressBook.ts` (typed wrappers over `supabase`, throw on error, untyped-client casts until `database.ts` is regenerated):

```ts
submitOrderReview(input: {
  orderId: string;
  restaurantRating: number;
  restaurantComment?: string | null;
  dishReviews: { menuItemId: string; rating: number; comment?: string | null }[];
}): Promise<void>                       // → supabase.rpc('submit_order_review', …)

getOrderReview(orderId: string): Promise<{
  restaurant: RestaurantReview | null;
  dishes: DishReview[];
}>                                       // prefill the edit form (two selects by order_id)

listRestaurantReviews(restaurantId: string, limit = 20): Promise<RestaurantReview[]>
listRestaurantDishReviews(restaurantId: string, limit = 50): Promise<DishReview[]>   // owner page
```

`submitOrderReview` maps the RPC's stable prefixes to friendly copy at the call site: `REVIEW_NOT_ELIGIBLE:` → *"This order can't be reviewed."*, `INVALID_RATING:` → *"Please pick 1–5 stars."*, anything else → `humaniseSupabaseError`.

---

## 5. Customer review capture — `/orders/:id/review`

A dedicated lazy route (`OrderReview`), not a modal: an order can carry many dishes, and a roomy page beats a cramped modal — while still code-split so non-reviewers never download it (the bundle invariant).

**Route** (`App.tsx`): `/orders/:id/review` → `<ProtectedRoute requirePhoneVerified>` wrapping lazy `OrderReview` (same guard tier as `/orders/:id`).

**`OrderReview.tsx`** (`src/pages/orders/`):
1. Fetch the order with its items (the existing `OrderStatus` select shape) **and** the existing review via `getOrderReview(id)`.
2. Guard: if `status !== 'completed'`, render *"You can review this order once it's delivered."* + a link back — the page never assumes eligibility (the RPC is the real gate, this is just UX).
3. Render **restaurant** `StarRatingInput` (required) + optional comment textarea; then a list of the order's **dishes**, each with its own `StarRatingInput` (optional) + optional comment. Prefill every control from the fetched existing review (edit mode).
4. Submit → `submitOrderReview(...)` (only dishes the customer actually starred are sent). On success, navigate to `/orders/:id` with a success flag; on error, render the mapped message inline (no reopen needed — the `ConfirmOrderModal` error-in-place rule).

**Entry points:**
- **`OrderStatus.tsx`** — when `status === 'completed'`, add a primary **"Rate your order"** CTA in the status card (or a "★ You rated this order — Edit" row once a review exists; fetch the order's review alongside the order). Reuses the file's existing `completed` branch.
- **`OrderHistory.tsx`** — on each `completed` row, a small "Rate" affordance linking to `/orders/:id/review` (and "★ 4" once rated). The history query adds nothing heavy — it can show the rated state by selecting the embedded `restaurant_reviews(rating)` for the user's own orders, or simply always link to the review page and let that page show current state. Prefer the embed to avoid a "Rate" prompt on already-rated orders.

---

## 6. Display surface — discovery storefront (`DiscoveryPage.tsx`)

- **Query:** extend the restaurants `select(...)` (currently `id, name, …, is_featured, featured_rank`) with `rating_avg, rating_count`; add both to the `RestaurantCard` `Pick<Restaurant, …>`.
- **Card badge:** in `renderCard`, when `rating_count > 0`, render a rating chip over the image (`<StarRating>`-free compact form: a single `Star` — already imported — + `formatRatingAverage(rating_avg, rating_count)` + count). When `rating_count === 0`, render a subtle **"New"** chip instead of a fake "0.0". This is the Zomato card-corner rating; it sits alongside the existing distance + Featured chips.
- Anon already gets the columns (column-grant extension in §3). Zero new round-trips — it rides the existing single restaurants query.

---

## 7. Display surface — restaurant menu (`RestaurantMenu.tsx`)

- **Header:** add `rating_avg, rating_count` to the restaurant `select`; render `<StarRating avg>` + `formatRatingLabel(...)` under the title next to cuisine/address. "New" when unrated.
- **Dish rows:** add `rating_avg, rating_count` to the `menu_items` select + the `MenuRow` `Pick`; render a compact `★ 4.2 (8)` next to each dish's price/Add control when `rating_count > 0` (the Swiggy per-item rating). Unrated dishes show nothing (no clutter).
- **Reviews section:** below the menu list, a **"Ratings & Reviews"** section fetching `listRestaurantReviews(id, 20)` — overall `<StarRating>` + `formatRatingLabel`, then recent reviews (abbreviated name via `displayReviewerName`, stars, comment, IST date via the existing `formatTimeIST`). `loading | error | data` triplet + `humaniseSupabaseError`, the standard pattern. Empty state: *"No reviews yet — be the first after you order."* Pagination ("load more") is a v2 nicety (§15); 20 most-recent is plenty at launch.

---

## 8. Display + insight surface — owner dashboard (`/dashboard/reviews`)

The feature's payoff for the owner — read-only in v1, directly serving *"see their reviews and improve quality and performance."*

**Route:** `/dashboard/reviews` → owner-only lazy `ReviewsManager` (its own chunk — customers never download it, preserving the code-split invariant). Add a **"Reviews"** nav entry next to the existing "Menu" link in the dashboard header / `RestaurantHeader`.

**`ReviewsManager.tsx`** (`src/pages/dashboard/reviews/`) — resolves the owner's restaurant via `.maybeSingle()` on `owner_id` (null → reuse `OnboardingIncomplete`, like `MenuManager`), then renders:

1. **Overall** — big `rating_avg` + `<StarRating>` + `rating_count` (read straight off the owner's `restaurants` row — already fetched for the dashboard).
2. **Distribution** — five bars (5★…1★) from `ratingDistribution()` over the fetched restaurant reviews. The at-a-glance "are my problems isolated or systemic?" view.
3. **Per-dish breakdown — the actionable core.** A table of the restaurant's dishes (join `menu_items.rating_avg/rating_count` with `listRestaurantDishReviews`) **sorted worst-average-first** (unrated dishes last), each row showing the dish, its ★ average, count, and an expandable list of that dish's comments. This is the "your Paneer Tikka is 2.8★ across 14 ratings — fix it" surface.
4. **Recent reviews** — reverse-chron restaurant reviews (abbreviated name, stars, comment, date).

All read-only, fetch-on-load (`loading | error | data`), no Realtime. Owner replies, "respond to review," and review-trend-over-time are §15 v2 items.

---

## 9. File-Touch Summary

| Area | File | Change |
|---|---|---|
| DB | `supabase/migrations/019_reviews_and_ratings.sql` | new — tables, denormalized columns, triggers, RLS/grants, `submit_order_review` RPC |
| Types | `src/types/database.ts` | regen (2 tables + 4 columns) |
| Types | `src/types/models.ts` | `RestaurantReview`, `DishReview`; `rating_avg`/`rating_count` on `Restaurant` + `MenuItem` |
| Lib | `src/lib/ratings.ts` (+ `ratings.test.ts`) | new — pure display/format/distribution helpers |
| Lib | `src/lib/reviews.ts` | new — data layer (`submitOrderReview`, `getOrderReview`, `listRestaurantReviews`, `listRestaurantDishReviews`) |
| Shared | `src/components/StarRating.tsx` (+ `.css`) | new — read-only star display |
| Shared | `src/components/StarRatingInput.tsx` (+ `.css`) | new — accessible interactive picker |
| Customer | `src/pages/orders/OrderReview.tsx` (+ `.css`) | new — review capture/edit page |
| Customer | `src/App.tsx` | new lazy route `/orders/:id/review` (phone-verified guard) |
| Customer | `src/pages/orders/OrderStatus.tsx` (+ `.css`) | "Rate your order" / "You rated — Edit" on `completed`; fetch existing review |
| Customer | `src/pages/orders/OrderHistory.tsx` (+ `.css`) | per-row "Rate"/"★ n" on `completed` rows |
| Customer | `src/pages/discovery/DiscoveryPage.tsx` | card rating badge; `rating_avg/rating_count` in query + `RestaurantCard` Pick |
| Customer | `src/pages/restaurants/RestaurantMenu.tsx` (+ `.css`) | header rating, per-dish rating, "Ratings & Reviews" section |
| Owner | `src/pages/dashboard/reviews/ReviewsManager.tsx` (+ `.css`) | new — overall + distribution + per-dish breakdown + recent reviews |
| Owner | `src/App.tsx` | new lazy owner route `/dashboard/reviews` |
| Owner | `src/pages/dashboard/RestaurantHeader.tsx` (or dashboard header) | "Reviews" nav link |
| Docs | `CLAUDE.md`, `GEMINI.md` | §14 |
| Docs | `src/docs/v2_deferred_issues.md` | new "Reviews & Ratings — v1 simplifications" entry |

---

## 10. Testing

Stays inside the v1 philosophy (high-risk pure logic only, no mocked Supabase):

- **`src/lib/ratings.test.ts`** — `formatRatingAverage`/`formatRatingLabel` (incl. `count = 0 → "New"`), `starTokens` (e.g. 4.3 → `[filled,filled,filled,filled,half]`; rounding boundaries at .24/.25/.74/.75), `displayReviewerName` ("Ankit Khatkar" → "Ankit K.", single-word names, empty/whitespace), `ratingDistribution` (counts, empty input).
- **DB behavior** — verified-purchase gating (wrong customer / non-`completed` → `REVIEW_NOT_ELIGIBLE`), dish-not-in-order rejection, rating-range checks, upsert/edit, and the aggregate triggers (avg/count after insert, edit, and delete) — covered by the **manual checklist** below now, and folded into the deferred real-Supabase integration suite (`phase4_stabilisation_plan.md` §3.2). Same stance the cancellation/ETA plan took for its trigger/RPC behavior.

### Manual verification checklist

1. Place → owner completes an order. `/orders/:id` shows **"Rate your order"**; the review page lists exactly that order's dishes. Submit 4★ restaurant + two dish ratings → redirect shows "★ You rated this order — Edit".
2. Discovery card for that restaurant shows **★ 4.0 (1)**; menu header shows the same; the two rated dishes show their ★ on their rows; the unrated dishes show nothing.
3. Re-open the review page → controls are prefilled; change restaurant to 5★ → card/menu/owner all reflect **5.0** (trigger recompute on UPDATE).
4. Owner `/dashboard/reviews` → overall 5.0 (1), distribution bar on 5★, per-dish table sorted worst-first, recent-reviews list shows the comment with the abbreviated name.
5. SQL editor as a *different* customer: `submit_order_review(<someone-else's-order>, 5, …)` → `REVIEW_NOT_ELIGIBLE`. On a non-`completed` own order → `REVIEW_NOT_ELIGIBLE`. With a `menu_item_id` not in the order → `REVIEW_NOT_ELIGIBLE`. Rating `0` or `6` → `INVALID_RATING`.
6. Anon (logged-out) storefront + menu show ratings and the reviews list (public read) but no "Rate" CTA anywhere.
7. Delete a review in the Supabase Dashboard → the parent `rating_avg`/`rating_count` recompute (trigger on DELETE); a restaurant with its last review removed returns to **"New"**.
8. `npm test` green; `npm run lint` clean; `npm run build` succeeds.

---

## 11. Rollout

- Single PR `feat/reviews-and-ratings` (the feature is cohesive; the migration + frontend must land together, per the stale-client note below). If it feels large, split into two stacked PRs: **(A)** migration + `reviews.ts`/`ratings.ts` + shared star components + the customer capture page + display badges; **(B)** the owner `/dashboard/reviews` surface. (A) is shippable alone (owners just don't have the dedicated view yet, but the data accrues from day one).
- The Supabase↔GitHub integration runs `019` on each PR's preview branch automatically. No new secrets and no `pg_cron`, so the preview-branch caveat (secrets/cron don't carry over — `cloud.md` memory) doesn't bite here.
- **Stale-client safety:** the changes are additive. An old client simply lacks the badges and the "Rate" CTA (harmless); the PWA's `skipWaiting`/`clientsClaim` means one reload picks up the new bundle. Apply `019` together with the frontend deploy, outside peak hours (12–2 PM, 7–9:30 PM IST).
- After deploy, regenerate `database.ts` from production (or the linked project) so the committed types match the live schema.

---

## 12. Documentation Housekeeping (part of the PR, not optional)

- **`CLAUDE.md`** (and mirror in **`GEMINI.md`**):
  - *Tables* line → add `restaurant_reviews`, `dish_reviews`.
  - *Database → Critical rules* → add the `submit_order_review` RPC rule (verified-purchase, RPC-only write path, atomic upsert) and the `restaurants.rating_avg/rating_count` + `menu_items.rating_avg/rating_count` denormalization-via-trigger note.
  - *RLS summary* → add the two review tables (public read, `customer_id` withheld at column grant, admin full, no customer/owner write policy).
  - *Routes table* → add `/orders/:id/review` and `/dashboard/reviews`; note the "Rate your order" entry on `/orders/:id` + `/orders`.
  - *File map* → `src/lib/ratings.ts`, `src/lib/reviews.ts`, `src/components/StarRating*`, `src/pages/orders/OrderReview.tsx`, `src/pages/dashboard/reviews/`.
  - *v2-deferred* → **remove "ratings."**
  - *Testing* scope → add `src/lib/ratings.ts`.
- **`src/docs/v2_deferred_issues.md`** → new section "Reviews & Ratings — v1 simplifications" with the §13 deferrals.
- The migration header already cross-references this document.

---

## 13. Recommendations Adopted & v2 Deferrals

Adopted in this design (beyond the literal request):

1. **Verified-purchase, order-bound reviews** — the integrity backbone; trustworthy ratings, abuse-resistant by construction.
2. **RPC write path, not a direct INSERT policy** — atomic restaurant+dish write, server-derived trust fields, free idempotent edit (mirrors `place_order`/`cancel_order`).
3. **Denormalized aggregates via trigger** — keeps the storefront's hot read path a single flat query (the `is_featured` doctrine).
4. **Public read with `customer_id` withheld + abbreviated names** — social proof for anon shoppers without leaking the user FK or full identities.
5. **Per-dish, worst-first owner breakdown** — turns reviews into an action list, directly serving the "improve quality" goal.
6. **"New" instead of "0.0"** for unrated entities — never punish a kitchen for being new.

Deferred to v2 (log in `v2_deferred_issues.md`):

- **Owner replies to reviews** — needs a `review_replies` shape + a public display slot + the owner write path; the highest-value next step.
- **Moderation** — report/flag, profanity filter, hide-pending-review. Verified-purchase covers the worst abuse for now; revisit if a bad-faith review actually lands.
- **Review photos** — a `review-media` bucket (the `promotion-media`/`restaurant-images` admin-bucket pattern, but customer-writable — new RLS surface).
- **Realtime "new review" toast** on the owner dashboard — add `restaurant_reviews` to the publication; trivial once wanted.
- **Helpfulness / "was this useful" votes**, **sort/filter reviews** (most recent / highest / lowest), **pagination ("load more")** on the menu + owner lists.
- **Review-eligibility window** (e.g. 14 days post-delivery) and **edit-lock** after a period — clock logic deferred until volume justifies it (§2.9).
- **Rating trend over time** for owners (this month vs last) — both timestamps are already stored, so it's a pure read.
- **Aggregate strategy upgrade** — if review volume ever makes the recompute-on-write trigger or the per-load fetches a bottleneck, revisit the compute-on-read view vs incremental-counter trade-off (§2.7). Not a v1 concern at Gudha Gorji scale.
- **Low-rating owner alert** — SMS/notification when a dish or the restaurant drops below a threshold (rides the existing MSG91 plumbing).
```
