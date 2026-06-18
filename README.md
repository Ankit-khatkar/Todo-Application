# Delivery Address Capture — Build Plan

> **Status:** Proposed (not yet implemented)
> **Author:** Ankit
> **Goal:** Let a customer drop their delivery address from their **current GPS location** at checkout — reverse-geocoded to editable text, with the **exact pin stored on the order** so the restaurant owner gets a one-tap **navigate link** to the door. Logged-in customers can **save** addresses to a small labelled book (**Home / Office / Other**) and reuse them.
>
> **One-line summary:**
> - **"📍 Use my current location" button** on the checkout address step → one-shot precise GPS fix via a new extracted helper.
> - **Reverse-geocode** the fix with **Nominatim (OpenStreetMap)** — free, no API key — and show the result in a **confirm modal with an editable text box** (village OSM coverage is coarse, so the text is a *hint* the user corrects; the pin is the source of truth).
> - **Store `delivery_lat` / `delivery_lng` on the order** so `PendingOrderCard` / `ActiveOrderCard` render a **Google Maps navigate link** to the precise drop-off.
> - **`delivery_addresses` table** — a per-user labelled address book (one Home, one Office, many Others), saved **opt-in** at checkout, RLS-scoped to the owner customer only.

This feature delivers two items already scoped as v2 in [`location_resilience_plan.md` §8](location_resilience_plan.md) ("Saved address book", "Reverse-geocoded address confirmation") and substantially closes [`v2_deferred_issues.md` §3](v2_deferred_issues.md) (desktop / no-Wi-Fi-database dead-end now has a *preventive* address-capture path, not just the reactive owner-decline net).

---

## 1. Why This Change

### 1.1 The address is typed blind today

[`Checkout.tsx`](../pages/checkout/Checkout.tsx) collects the delivery address with a plain `<textarea>` (`Checkout.tsx:238`) validated only by `address.trim().length > 10` (`Checkout.tsx:59`). In a village, a typed address is often unusable for a rider — *"behind the temple"*, *"Sharma ji ka ghar"* — and there is **no coordinate** attached. The owner sees `📍 {order.delivery_address}` as static text in [`PendingOrderCard.tsx:102`](../pages/dashboard/PendingOrderCard.tsx) and [`ActiveOrderCard.tsx:123`](../pages/dashboard/ActiveOrderCard.tsx) with no way to navigate to it.

### 1.2 We already have the customer's location — we throw it away

`/restaurants` already obtains a GPS fix (the coarse-first sequence in [`RestaurantList.tsx`](../pages/restaurants/RestaurantList.tsx)) and even caches it (`localStorage["redlotus_last_location"]`). But that fix dies on the restaurants page; checkout never reuses it. The customer is standing exactly where they want the food delivered, and we ask them to describe it in prose.

### 1.3 No address reuse

A returning customer re-types the same address every order. There is no `addresses` table, no saved book, and `public.users` has no address column. [`location_resilience_plan.md` §8](location_resilience_plan.md) explicitly deferred the address book to v2; this plan brings the *minimum useful* version forward because it falls out naturally once we're capturing a structured address anyway.

### 1.4 What this is NOT

This is **not** a re-architecture of the `/restaurants` geolocation flow (that stays as-is — see [`location_resilience_plan.md`](location_resilience_plan.md)). It adds a **second, simpler, explicit** geolocation touchpoint at checkout: a deliberate "use my location" button, one-shot and precise, not a silent background fix.

---

## 2. Decisions Locked (from requirements review)

These three forks were confirmed before this plan was written:

| # | Decision | Chosen | Consequence |
|---|---|---|---|
| 1 | **Saved-address model** | **Labelled book + opt-in save** | New `delivery_addresses` table; user keeps multiple labelled addresses, picks one at checkout, and a new address persists *only* when they tick "Save this address" and choose a label. One-off addresses (ordering for a friend) stay out of the book. |
| 2 | **Reverse-geocode provider** | **Nominatim (OSM), fully editable** | Free, no API key. Pre-fills the confirm modal; user edits. Coordinates always go to the owner regardless of text quality. Degrades to manual typing if Nominatim is down/rate-limited. OSM attribution required. |
| 3 | **Owner navigation** | **Store the GPS pin on the order** | `orders` gains nullable `delivery_lat` / `delivery_lng`; `place_order` migration threads them; owner cards render a Google Maps directions link. Typed-only orders fall back to a Maps text search. |

### 2.1 Correction to the original requirements

Requirement #2 referenced *"the existing `useGeolocation.ts` hook"*. **No such hook exists.** Geolocation today is an inline `useEffect` in `RestaurantList.tsx` plus two extracted helpers: [`geo.ts`](../lib/geo.ts) (`haversineKm`, `Coords`) and [`locationCache.ts`](../lib/locationCache.ts). This plan therefore **extracts a small one-shot helper** (`src/lib/geolocation.ts`, §4.3) rather than reusing a hook that isn't there. The `/restaurants` coarse-first/cache/drift machinery is deliberately *not* reused at checkout — that flow optimises for a silent, cache-first background fix; checkout wants a fresh, precise, user-initiated fix.

---

## 3. The Approach

### 3.1 Coordinates are the source of truth; text is an editable annotation

The load-bearing idea. In Gudha Gorji, OSM reverse-geocoding will frequently return only a road or the village name — not a house. That is **fine**, because:

- The **pin** (`delivery_lat/lng`) is what the rider actually navigates to. It is captured from where the customer physically stands when they tap the button.
- The **text** is a human hint the customer edits ("blue gate next to Hanuman temple") and the owner reads alongside the pin.

So a coarse or empty geocode never blocks the flow — the user just types the landmark themselves and the pin carries the precision. This is why **option 2 (Nominatim) and option 3 (store the pin)** combine well: even when the text is weak, delivery still works.

### 3.2 Explicit, one-shot, precise geolocation

The button calls `getCurrentPositionOnce()` (§4.3) with `enableHighAccuracy: true, timeout: 15_000, maximumAge: 0` — i.e. the `PRECISE_OPTIONS` profile from `RestaurantList.tsx`, *not* the coarse profile. Rationale: this is a deliberate "pin my doorstep" action, so we want the best fix available, and the user is actively waiting (a spinner on the button is acceptable; a silent stale cache hit is not). We do **not** read `locationCache` here — a cached fix from browsing restaurants an hour ago is not necessarily where they want delivery now.

`GeolocationPositionError.code` is mapped to friendly copy reusing the same taxonomy as `RestaurantList` (`denied | timeout | unavailable | unsupported`). The button degrades gracefully: on any error, the user keeps the manual textarea — the button is an **enhancement, never a dependency**.

### 3.3 Reverse geocoding via Nominatim — and its rules

Endpoint (single GET, on button confirm only — never per-keystroke):

```
https://nominatim.openstreetmap.org/reverse
  ?format=jsonv2&lat=<lat>&lon=<lng>&zoom=18&addressdetails=1
```

**Nominatim Usage Policy compliance is mandatory** (the public instance is free but enforced):

1. **≤ 1 request/second.** We only call on an explicit button tap (and guard against double-tap with a `locating` flag), so we are structurally far under this. No autocomplete, no per-keystroke calls — ever.
2. **Identify the application.** Browsers forbid setting `User-Agent`, but the `Referer` header is sent automatically from `https://redlotusfoods.in`, which satisfies the "identify yourself" requirement for browser apps. We additionally namespace the call behind one wrapper (§4.4) so a contact param can be added if Nominatim ever asks.
3. **Attribution.** "© OpenStreetMap contributors" **must** be displayed where the result is shown. The confirm modal (§4.5) carries a small attribution line. Non-negotiable for ToS compliance.
4. **Timeout + abort.** The wrapper uses `AbortController` with an ~8 s timeout. A slow/failed reverse-geocode must never strand the user — it falls back to an empty (manually typed) address with the pin still captured.

**Provider-swap seam.** All Nominatim specifics live in `src/lib/geocoding.ts` (§4.4) behind `reverseGeocode(coords): Promise<ReverseGeocodeResult>`. Swapping to a paid provider (Google/Ola Maps) later is a one-file change — the decision recorded in §2 can be revisited without touching Checkout.

**Service Worker / CSP note.** Workbox `runtimeCaching` ([`vite.config.ts`](../../vite.config.ts)) only matches `fonts.googleapis.com` / `fonts.gstatic.com`; the Nominatim call is not precached or intercepted, and `navigateFallback` only affects navigations (not `fetch`). **No SW change needed.** There is no Content-Security-Policy in `index.html` today — but if one is ever added, `connect-src` must include `https://nominatim.openstreetmap.org`. Recorded here so it isn't a silent breakage later.

### 3.4 Confirm modal — editable, mirrors existing modal mechanics

A new `LocationConfirmModal` (§4.5) modeled exactly on [`ConfirmOrderModal.tsx`](../pages/checkout/ConfirmOrderModal.tsx) / [`DeclineModal`](../pages/dashboard/DeclineModal.tsx): focus capture + restore on unmount, `Escape` to close, backdrop-click to close, `document.body` scroll-lock, internal error banner. It shows:

- The detected address in an **editable `<textarea>`** (pre-filled from Nominatim, possibly empty).
- An optional **"Save this address"** checkbox + **Home / Office / Other** label chips (only shown to logged-in users; §3.6).
- **Confirm** (writes address + coords back to Checkout state) and **Cancel** (dismiss, keep prior state).
- The OSM attribution line.

### 3.5 Order state wiring

Today the address lives in Checkout local state (`useState`), not in `CartContext` — and that is the right scope (the cart is restaurant+items; the address is per-checkout). We keep it there and **add coordinates alongside**:

```ts
const [address, setAddress] = useState("");
const [coords, setCoords] = useState<Coords | null>(null);   // ← new
```

`handlePlaceOrder` ([`Checkout.tsx:71`](../pages/checkout/Checkout.tsx)) passes them to the RPC:

```ts
const { data, error: rpcErr } = await supabase.rpc("place_order", {
  p_restaurant_id: cart.restaurant_id,
  p_delivery_address: address.trim(),
  p_delivery_lat: coords?.lat ?? null,   // ← new
  p_delivery_lng: coords?.lng ?? null,   // ← new
  p_special_instructions: notes.trim() ? notes.trim() : null,
  p_items: cart.items.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.quantity })),
  p_subtotal: pricing.subtotal,
  p_discount: pricing.discount,
  p_delivery_fee: pricing.deliveryFee,
});
```

`coords` is `null` when the user typed the address manually without using the button — fully supported (owner gets a text-search link).

### 3.6 Saved address book (opt-in)

`delivery_addresses` (§4.1) is a per-user labelled book:

- **`home` and `office`** are singletons per user — saving again **upserts** (overwrites). Enforced by a partial unique index on `(user_id, label)`.
- **`other`** is unlimited and distinguished by an optional `custom_label` ("Mom's", "Hostel"). Saved by insert; edited by id.

At checkout, logged-in customers see their saved addresses as a radio list above the textarea (default address pre-selected). Picking one fills `address` + `coords` from the row. "Add new address" reveals the blank textarea + the location button. **A new address persists to the book only when the user opts in** (the modal checkbox). Persistence happens **on successful order placement** (see Open Question §9.1) via `upsertDeliveryAddress` in the new data layer (§4.6), so we don't accumulate saved rows for orders the user abandoned.

The book is **never exposed to restaurant owners** — the order carries its own `delivery_address` + `delivery_lat/lng` snapshot (the same snapshot doctrine as `customer_name`/`customer_phone` in migration 004 and `order_items.unit_price`). Editing or deleting a saved address later must not mutate historical orders.

### 3.7 Owner navigate link

A new `mapsLink()` helper (§4.7) builds the URL:

- **Coords present:** `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>` — opens turn-by-turn directions to the exact pin in one tap (best for a rider).
- **Coords absent (typed-only / pre-015 orders):** `https://www.google.com/maps/search/?api=1&query=<encoded address text>` — a best-effort text search.

`PendingOrderCard` and `ActiveOrderCard` render the existing `📍 {delivery_address}` line plus a **"Navigate ▸"** anchor (`target="_blank"`, `rel="noopener noreferrer"`). Google Maps is the target because it is near-universal on Indian owner phones; swapping to an OSM/`geo:` link is a one-line change in the helper (see Open Question §9.6).

---

## 4. Implementation

> Line numbers are fragile — symbols are referenced by name. New files are marked **NEW**.

### 4.1 **NEW** migration `supabase/migrations/015_delivery_addresses.sql`

Three changes in one migration (run after `014_order_eta.sql`):

**(a) `orders` gains the pin.** Nullable — typed-only and pre-015 orders are `NULL`.

```sql
ALTER TABLE public.orders
  ADD COLUMN delivery_lat float8
    CHECK (delivery_lat IS NULL OR delivery_lat BETWEEN -90 AND 90),
  ADD COLUMN delivery_lng float8
    CHECK (delivery_lng IS NULL OR delivery_lng BETWEEN -180 AND 180);
```

We deliberately do **not** constrain to a Gudha Gorji bounding box — the override path and edge geographies must not be rejected at the DB layer (parallels the `RADIUS_KM` check living in the app, not the schema). The owner-visibility of these columns needs **no RLS change**: `orders_owner_select` ([`002_security.sql:165`](../../supabase/migrations/002_security.sql)) already grants the owning restaurant SELECT on the whole row.

**(b) `delivery_addresses` table + RLS.**

```sql
CREATE TABLE public.delivery_addresses (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  label        text        NOT NULL CHECK (label IN ('home','office','other')),
  custom_label text,                       -- names an 'other' address; NULL for home/office
  address_text text        NOT NULL CHECK (length(btrim(address_text)) >= 10),
  lat          float8      CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng          float8      CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One Home and one Office per user (upsert target); 'other' may repeat.
CREATE UNIQUE INDEX delivery_addresses_singleton_label
  ON public.delivery_addresses (user_id, label)
  WHERE label IN ('home','office');

-- At most one default per user.
CREATE UNIQUE INDEX delivery_addresses_one_default
  ON public.delivery_addresses (user_id)
  WHERE is_default;

CREATE INDEX idx_delivery_addresses_user ON public.delivery_addresses (user_id);

-- Reuse set_updated_at() from migration 003 (same pattern as discount_config in 006).
CREATE TRIGGER set_delivery_addresses_updated_at
  BEFORE UPDATE ON public.delivery_addresses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.delivery_addresses ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_addresses TO authenticated;

-- Customer manages ONLY their own rows. No owner access (orders carry the snapshot).
CREATE POLICY delivery_addresses_own_all ON public.delivery_addresses
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY delivery_addresses_admin_all ON public.delivery_addresses
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
```

No Realtime publication membership needed — the book is read on demand at checkout, not subscribed.

**(c) `place_order` v3 — thread the pin.** Same DROP-then-recreate doctrine as migration 006 (§5 there): drop the 7-arg signature so it can't be called, recreate with two appended params **defaulting `NULL`**. Because the new params have defaults and the old signature is dropped, a stale PWA client that still sends the 7 keys resolves to this one function (defaults fill the pin) — **no hard break during rollout**, while all the existing pricing/`PRICING_MISMATCH` checks still run.

```sql
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, jsonb, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.place_order(
  p_restaurant_id        uuid,
  p_delivery_address     text,
  p_special_instructions text,
  p_items                jsonb,
  p_subtotal             numeric,
  p_discount             numeric,
  p_delivery_fee         numeric,
  p_delivery_lat         float8 DEFAULT NULL,   -- ← new, optional
  p_delivery_lng         float8 DEFAULT NULL    -- ← new, optional
) RETURNS uuid AS $$
  -- ... identical body to 006 (contact read, server subtotal/discount/delivery
  --     recompute, ±₹0.01 mismatch checks) ...
  -- the only change is the orders INSERT column list + VALUES:
  --   INSERT INTO public.orders (
  --     customer_id, restaurant_id, customer_name, customer_phone,
  --     total_amount, discount_amount, delivery_fee,
  --     delivery_address, delivery_lat, delivery_lng, special_instructions)
  --   VALUES (auth.uid(), p_restaurant_id, v_full_name, v_phone,
  --     v_server_total, v_server_discount, v_server_delivery_fee,
  --     p_delivery_address, p_delivery_lat, p_delivery_lng, p_special_instructions)
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

> The coordinates are **unvalidated client metadata** (unlike pricing). That is acceptable: they only ever feed a maps link the owner opens, the CHECK constraints bound them to the globe, and a customer spoofing their own delivery pin only hurts their own delivery. No server recompute is possible (we can't independently know where they are).

After applying on the Supabase preview branch, **regenerate types**: `npx supabase gen types typescript --local > src/types/database.ts`.

### 4.2 `src/types/models.ts` + `src/types/database.ts`

- `database.ts` is regenerated (it now contains the real `orders` Row/Insert/Update and the `place_order` Args — verified). The regen picks up `delivery_lat/lng` and the new arg defaults, and adds the `delivery_addresses` table types.
- `models.ts` is the hand-maintained mirror: add `delivery_lat: number | null` and `delivery_lng: number | null` to the `Order` interface, and add a new `DeliveryAddress` interface:

```ts
export interface DeliveryAddress {
  id: string;
  user_id: string;
  label: "home" | "office" | "other";
  custom_label: string | null;
  address_text: string;
  lat: number | null;
  lng: number | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
```

(Per `models.ts` convention — `UserProfile` stays owned by `AuthContext`; everything else is fine here.)

### 4.3 **NEW** `src/lib/geolocation.ts` (+ `geolocation.test.ts`)

A promisified one-shot wrapper + error taxonomy, extracted so checkout (and any future caller) doesn't duplicate `RestaurantList`'s callback soup.

```ts
import type { Coords } from "./geo";

export type GeoErrorKind = "unsupported" | "denied" | "unavailable" | "timeout";

export const PRECISE_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 0,
};

export function mapGeoErrorKind(code: number): GeoErrorKind {
  if (code === 1) return "denied";
  if (code === 3) return "timeout";
  return "unavailable";
}

/** One-shot precise fix. Rejects with a GeoErrorKind-tagged error. */
export function getCurrentPositionOnce(
  options: PositionOptions = PRECISE_OPTIONS,
): Promise<Coords & { accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject({ kind: "unsupported" as GeoErrorKind });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject({ kind: mapGeoErrorKind(err.code) as GeoErrorKind }),
      options,
    );
  });
}
```

An optional thin `useGeolocation()` hook (`{ request, status, coords, error }`) can wrap this for ergonomics, but the promise is the testable core. **Tests** (`geolocation.test.ts`): `mapGeoErrorKind` for codes 1/2/3; `getCurrentPositionOnce` resolves with mocked `navigator.geolocation.getCurrentPosition` success; rejects with `unsupported` when geolocation is absent; rejects with the mapped kind on error callback.

### 4.4 **NEW** `src/lib/geocoding.ts` (+ `geocoding.test.ts`)

Nominatim behind a stable, swappable interface.

```ts
import type { Coords } from "./geo";

export interface ReverseGeocodeResult {
  /** Human-readable address. May be coarse (road/village) in rural India. */
  displayName: string;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const TIMEOUT_MS = 8_000;

/** Reverse-geocode a fix to text. Returns null on any failure — the caller
 *  falls back to manual entry; the pin is captured regardless. */
export async function reverseGeocode(coords: Coords): Promise<ReverseGeocodeResult | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const url =
      `${ENDPOINT}?format=jsonv2&lat=${coords.lat}&lon=${coords.lng}` +
      `&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    if (!data.display_name) return null;
    return { displayName: data.display_name };
  } catch {
    return null; // abort / network / parse — non-fatal
  } finally {
    clearTimeout(t);
  }
}
```

**Tests** (mock `global.fetch`): success → `{ displayName }`; `res.ok === false` → `null`; thrown/aborted fetch → `null`; missing `display_name` → `null`. Pure, no component render — fits the existing pure-logic suite.

### 4.5 **NEW** `src/pages/checkout/LocationConfirmModal.tsx` (+ `.css`)

Mirror `ConfirmOrderModal`'s mechanics (the three `useEffect`s: focus restore, `Escape`, scroll-lock; backdrop stop-propagation). Props sketch:

```ts
interface LocationConfirmModalProps {
  detectedAddress: string;          // pre-filled (may be "")
  canSave: boolean;                 // true only for logged-in users
  busy: boolean;
  error: string | null;             // geocode/permission copy
  onConfirm: (args: { address: string; save: boolean; label: AddressLabel; customLabel?: string }) => void;
  onCancel: () => void;
}
```

Body: editable `<textarea>` (autofocused), the optional save checkbox + label chips, the error banner, **Confirm / Cancel** buttons, and the required attribution line:

```html
<p class="lcmodal__attribution">Address data © OpenStreetMap contributors</p>
```

Default focus is on the textarea (the user usually wants to refine the text immediately), not on a destructive control.

### 4.6 **NEW** `src/lib/addressBook.ts`

Data layer for the saved book (used by Checkout now, and a future Profile manage-screen):

```ts
import { supabase } from "./supabaseClient";
import type { DeliveryAddress } from "../types/models";

export async function listAddresses(): Promise<DeliveryAddress[]> { /* select * where user_id=auth.uid() order by is_default desc, updated_at desc */ }

export async function upsertDeliveryAddress(input: {
  label: "home" | "office" | "other";
  customLabel?: string | null;
  addressText: string;
  lat: number | null;
  lng: number | null;
  makeDefault?: boolean;
}): Promise<void> {
  // home/office → upsert on (user_id,label) conflict target.
  // other       → insert (or update by id when editing an existing row).
}

export async function deleteAddress(id: string): Promise<void> { /* ... */ }
export async function setDefaultAddress(id: string): Promise<void> { /* clear others, set one */ }
```

`user_id` is never sent from the client — RLS `WITH CHECK (user_id = auth.uid())` rejects forgery; the insert payload sets `user_id` via a DB default? No — there is no default; the client sets `user_id: (await supabase.auth.getUser()).data.user!.id`, and RLS enforces it equals `auth.uid()`. (Same trust model as `orders_customer_insert`.)

### 4.7 `src/pages/dashboard/utils.ts` — `mapsLink()`

Add alongside `telHref`:

```ts
export function mapsLink(args: {
  lat: number | null;
  lng: number | null;
  address: string;
}): string {
  if (args.lat != null && args.lng != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${args.lat},${args.lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(args.address)}`;
}
```

Pure → unit-testable (coords path vs text path; encoding).

### 4.8 Dashboard types + selects

- [`types.ts`](../pages/dashboard/types.ts): add `delivery_lat: number | null` and `delivery_lng: number | null` to `PendingOrder` and `ActiveOrder` (not `HistoryOrder` — history is collapsed and shows no address).
- [`utils.ts`](../pages/dashboard/utils.ts): add `delivery_lat, delivery_lng` to `PENDING_ORDER_SELECT` and `ACTIVE_ORDER_SELECT`.

### 4.9 Owner cards — the Navigate link

In `PendingOrderCard.tsx` and `ActiveOrderCard.tsx`, replace the static address `<p>` with the text plus an anchor:

```tsx
<p className="pcard__customer-address">📍 {order.delivery_address}</p>
<a
  className="pcard__navigate"
  href={mapsLink({ lat: order.delivery_lat, lng: order.delivery_lng, address: order.delivery_address })}
  target="_blank"
  rel="noopener noreferrer"
>
  Navigate ▸
</a>
```

(`acard__navigate` for the active card.) The link is **always** present — coords give a precise pin, text-only falls back to search. Most valuable on `ActiveOrderCard` when `out_for_delivery`.

### 4.10 `Checkout.tsx` — the orchestration

- New state: `coords`, `savedAddresses`, `selectedAddressId`, `locating`, `geoError`, `confirmGeoOpen`, `detectedAddress`.
- On mount (logged-in only): `listAddresses()` → render radio list; pre-select the default; fill `address`/`coords` from it.
- "📍 Use my current location" button (in the Delivery Address section): `setLocating(true)` → `getCurrentPositionOnce()` → `reverseGeocode(coords)` → open `LocationConfirmModal` with `detectedAddress = result?.displayName ?? ""` and the captured `coords` held pending confirm. On geo error, map `kind` → copy and surface inline (keep the textarea usable).
- Modal `onConfirm`: set `address` + `coords`; if `save`, remember the save intent for post-placement persistence.
- `handlePlaceOrder`: pass `p_delivery_lat`/`p_delivery_lng` (§3.5); on RPC success and if the user opted to save, call `upsertDeliveryAddress(...)` before `navigate`. A save failure is **non-fatal** — the order already succeeded; surface a soft toast/log, never block the redirect.
- `canPlace` is unchanged (`address.trim().length > 10`); coords are optional.

### 4.11 (Optional, see §9.3) Profile manage-addresses surface

A small list on `/profile` to rename/delete/set-default saved addresses, using `addressBook.ts`. Not required for the checkout flow to work; can ship as a follow-up. Without it, a user can still overwrite Home/Office by re-saving, and `other` rows accumulate (low harm at v1 volume).

---

## 5. Security & Privacy

- **Coordinates are PII.** They are stored in two places: (a) on the order (`delivery_lat/lng`), visible only to the owning restaurant via `orders_owner_select` — necessary for delivery; (b) optionally in the user's own `delivery_addresses` rows, visible only to that user via `delivery_addresses_own_all`. **No cross-user exposure.**
- **Owners never see the address book** — they read the per-order snapshot. Editing/deleting a saved address can't rewrite history (snapshot doctrine, §3.6).
- **Third parties receiving coordinates:** Nominatim receives the lat/lng during reverse-geocode (inherent to the feature; documented in the privacy policy update — §7). Google Maps receives the coordinates only when the **owner clicks** the Navigate link, not before.
- **Consent is explicit twice:** the location button is an opt-in tap; saving is a separate opt-in checkbox. No silent capture, no silent persistence.
- **Spoofing:** a customer can send arbitrary `delivery_lat/lng` (client metadata). Acceptable — it only affects their own delivery, the CHECK bounds it to the globe, and the owner-decline + phone-verified pipeline (per `location_resilience_plan.md` §3.3) remains the backstop.
- **Secure-context requirement:** `getCurrentPosition` only works over HTTPS (prod `redlotusfoods.in` ✓) or `localhost`. LAN dev (`http://192.168.x.x:5173`) silently fails — same QA caveat as `location_resilience_plan.md` §7 (use a Vercel preview or a tunnel).

---

## 6. Edge Cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Permission denied on the button | `geoError = "denied"` copy inline; textarea stays usable; no modal. |
| 2 | GPS timeout (15 s) | `geoError = "timeout"` copy ("move near a window / type it instead"); textarea usable. |
| 3 | Geolocation unsupported (old browser) | Button hidden or disabled with `unsupported` copy; manual entry only. |
| 4 | Fix OK, Nominatim down / 5xx / rate-limited | `reverseGeocode` returns `null` → modal opens with an **empty** editable box; pin still captured; user types the landmark. |
| 5 | Fix OK, Nominatim returns coarse text (village only) | Modal pre-fills the coarse text; user edits to add the house/landmark; pin carries precision. |
| 6 | User edits text to contradict the pin | We keep the pin (it's where they stood). Modal copy frames the box as "add landmark details to your current location" to reduce mismatch. Owner sees both. |
| 7 | User types address manually, never taps the button | `coords = null`; order saved with text only; owner gets a Maps **search** link. |
| 8 | Pre-015 in-flight orders | `delivery_lat/lng IS NULL`; owner card shows the text + search link — unchanged behaviour, no crash. |
| 9 | Logged-in user picks a saved address | `address`/`coords` filled from the row; if that row had `lat/lng`, owner gets a precise link. |
| 10 | Save Home when a Home already exists | Partial unique index → `upsert` overwrites the existing Home row. |
| 11 | Save multiple "Other" addresses | Allowed; distinguished by `custom_label` / `id`. |
| 12 | Save opted-in but order placement fails | Nothing persisted (save runs only on RPC success, §3.6/§4.10). |
| 13 | Order succeeds but the address `upsert` fails | Order is already placed; soft toast/log; redirect proceeds. Save is best-effort. |
| 14 | Double-tap the location button | `locating` flag guards re-entry; one in-flight request at a time (respects Nominatim 1 req/s). |
| 15 | Offline at checkout | `getCurrentPositionOnce` may still resolve (GPS works offline) but `reverseGeocode` returns `null` → empty box + pin. Placing the order needs connectivity anyway (RPC). |
| 16 | Anonymous user (not logged in) | Can't reach `/checkout` (auth+phone gate). N/A — but `canSave=false` defensively hides the save UI. |
| 17 | Sign out | `delivery_addresses` are server-side + RLS-scoped; nothing to clear locally. (Location cache clearing is already handled in `AuthContext.signOut`.) |

---

## 7. Docs to Sync

- **This file** — the design of record.
- **`CLAUDE.md` + `GEMINI.md`** (keep in lockstep):
  - `/checkout` routes-table row: note the location button, reverse-geocode confirm modal, `delivery_lat/lng` on the order, and the saved-address picker.
  - Database section: add the `delivery_addresses` table, the `orders.delivery_lat/lng` columns, and the `place_order` v3 signature (now 9 args, last two optional). Update the "Order placement MUST use `place_order`" note's arg count.
  - File map: add `src/lib/geolocation.ts`, `src/lib/geocoding.ts`, `src/lib/addressBook.ts`, `LocationConfirmModal`, and `mapsLink` in dashboard utils.
  - Testing scope: add `geolocation.ts`, `geocoding.ts`, `mapsLink` (and note `locationCache.ts` is already tested — a pre-existing omission in that list).
- **`v2_deferred_issues.md` §3** — mark the desktop dead-end as further mitigated: address capture is now *preventive* (a pin + editable text), not just the reactive owner-decline net. The remaining v2 gap narrows to "address autocomplete / pincode whitelist for users who can't get any GPS fix at all."
- **`location_resilience_plan.md` §8** — strike "Saved address book" and "Reverse-geocoded address confirmation" from the v2 list (shipped here); leave map-pin-drop and paid autocomplete deferred.
- **Privacy policy** (`src/pages/.../PrivacyPolicy`) — disclose that delivery coordinates are collected with consent, stored on the order and (opt-in) in the address book, and shared with OpenStreetMap (reverse geocoding) and Google Maps (owner navigation).

---

## 8. Rollout Sequence

One PR, landed as focused commits (mirrors `location_resilience_plan.md` §7):

1. **Migration 015** — `orders.delivery_lat/lng` + `delivery_addresses` table/RLS/indexes + `place_order` v3. Apply on the Supabase preview branch; **regen `database.ts`**. No frontend behaviour change yet.
2. **Pure libs + tests** — `geolocation.ts`, `geocoding.ts`, `addressBook.ts`, `mapsLink` in dashboard `utils.ts`; `geolocation.test.ts`, `geocoding.test.ts`, `utils.test.ts` additions. `npm test` green.
3. **Owner Navigate link** — dashboard `types.ts` + `utils.ts` selects, `PendingOrderCard` + `ActiveOrderCard` anchors. Renders harmlessly on existing orders (NULL coords → search link). Ships value even before the customer side lands.
4. **Checkout capture** — location button + `LocationConfirmModal` + coords threaded into `place_order`. Manual entry path unchanged.
5. **Saved address book** — picker, opt-in save, label chips, `upsertDeliveryAddress` on success; (optional) Profile manage UI.
6. **Docs** — §7 sync across `CLAUDE.md` / `GEMINI.md` / `v2_deferred_issues.md` / `location_resilience_plan.md` / privacy policy.

**QA must run on HTTPS** (Vercel preview or tunnel) — geolocation refuses non-secure LAN origins (`location_resilience_plan.md` §7). **Deploy off-peak** (avoid 12–2 PM and 7–9:30 PM IST).

### 8.1 Manual QA matrix

| Device / state | Expected |
|---|---|
| Android Chrome, allow location | Fix ≤ 3 s; modal pre-fills OSM text; confirm → coords on order; owner card "Navigate ▸" opens Google directions to the pin. |
| Android, deny location | `denied` copy; textarea works; order places with text-only search link. |
| iOS Safari, allow | Same as Android; verify modal focus/scroll-lock behaves like `ConfirmOrderModal`. |
| Nominatim throttled/offline | Empty modal box + captured pin; user types landmark; order still carries the precise link. |
| Save Home, then re-save Home with a new pin | Single Home row, overwritten (upsert). |
| Pick saved address with a pin | Owner gets a precise directions link. |
| Typed-only order (no button) | Owner gets a Maps text-search link; no crash. |
| Pre-existing in-flight order | Navigate link = text search; unchanged. |

---

## 9. Open Questions (need Ankit's sign-off)

1. **Save timing — on modal-confirm vs on order-success?** This plan recommends **on order-success** (don't persist addresses for abandoned orders). The alternative saves the moment the user confirms the modal (survives abandonment, but litters the book). 
2. **May typed-only addresses (no pin) be saved to the book?** Recommend **yes** — a saved "Office: 2nd floor, market road" with no pin is still useful; owner just gets a text-search link for it.
3. **Profile manage-addresses UI in this scope or a follow-up?** Recommend **follow-up** (§4.11) — the checkout flow is fully functional without it; re-saving overwrites Home/Office and `other` accumulation is low-harm at v1 volume.
4. **Auto-pre-select the default address at checkout?** Recommend **yes** (most-recently-used or explicit default), with one tap to switch to "Add new".
5. **OSM attribution placement** — a small "Address data © OpenStreetMap contributors" line in the confirm modal is the proposed compliance surface. Confirm this is acceptable copy/placement.
6. **Google Maps as the owner link target** (vs OSM `geo:`/osm.org). Recommend **Google Maps** (ubiquitous on Indian owner phones); trivially swappable in `mapsLink`.
7. **Directions vs pin for the owner link** — recommend **directions** (`/maps/dir/?...&destination=`) for one-tap navigation when coords exist. Alternative is a dropped pin (`/maps/search/?...&query=lat,lng`) the owner then routes from.

---

## 10. Summary

Five moving parts, smallest-to-largest:

1. **Pin on the order** — `orders.delivery_lat/lng` + `place_order` v3 (additive, optional, no hard break). Owner gets a Google Maps **Navigate ▸** link — the headline value for village delivery.
2. **One-shot geolocation helper** — `getCurrentPositionOnce` extracted into `src/lib/geolocation.ts` (the `useGeolocation.ts` the requirements assumed didn't exist).
3. **Reverse geocode** — Nominatim behind `reverseGeocode()`, free + no key, fully editable result, attribution + 1 req/s compliance, degrades to manual entry.
4. **Confirm modal** — editable address, mirrors `ConfirmOrderModal` mechanics.
5. **Saved address book** — `delivery_addresses` (one Home, one Office, many Others), opt-in save, RLS customer-only, never exposed to owners.

No new paid dependency, no API key, one migration, ~3 small libs + 1 modal + targeted edits to Checkout and the two owner cards. Closes two long-standing v2 deferrals and gives riders an actual map pin instead of "behind the temple."
