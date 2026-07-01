# RedLotus — Native Mobile Apps (iOS + Android) via Capacitor

**Implementation-ready planning document**
Author/owner: Ankit (solo founder-developer)
Status: Planning — not yet started (Capacitor not initialised)
Last updated: 2026-06-29

> **How to read this doc.** Sections are numbered to match the brief. §0 lists assumptions and
> "verify-before-you-rely" items — read it first. Code blocks are copy-paste starting points with
> `TODO:` markers, not finished code. Anything marked **⚠ VERIFY** changes often (store policy,
> SDK versions, pricing) — confirm against the official source on the day you implement it.

---

## 0. Assumptions & things to verify

### 0.1 Assumptions (stated here; re-stated at point of use)

| # | Assumption | Why it matters / what to do if wrong |
|---|---|---|
| A1 | **You do not own a Mac.** | iOS builds *require* macOS + Xcode. §3.4 and §8 give a Mac-less path (cloud CI). If you have a Mac, skip the cloud-iOS workarounds and build locally. |
| A2 | **Google Play account is an *individual* account created after 13 Nov 2023.** | Triggers Google's **mandatory 12-tester / 14-day closed test** before production (§3.2, §11). This is the single biggest schedule driver. If your account predates that or is an *organisation* account, the rule may not apply — **⚠ VERIFY** in Play Console. |
| A3 | **One binary serves both customers and owners** (same as the web app — owners are redirected to `/dashboard`). | Store listing is positioned for customers; owner SMS backstop stays. No separate owner app. |
| A4 | **Launch native COD-first; Razorpay is bundled-but-dark-launched.** | The Razorpay *native plugin* is native code (can't be added later via OTA), so we compile it into v1 even if payments stay off, then enable via OTA/config later (§7.4). |
| A5 | **Single production Supabase project** (Vercel↔Supabase integration creates per-PR preview branches). | Push secrets / FCM config live on the production project; preview branches won't have them (known gotcha — see your `cloud.md` memory). |
| A6 | **Push audience is primarily customers** (order status, delivery, promos). Owners may also receive a "new order" push, but SMS remains their reliable backstop. | Shapes the `device_tokens` design and the channel matrix (§4.7). |
| A7 | **App identifier = `in.redlotusfoods.app`** (reverse-DNS of `redlotusfoods.in`). | Used everywhere (bundle id, package name, deep-link scheme). Pick now — **changing it after store submission means a brand-new app listing.** |

### 0.2 ⚠ VERIFY before relying (fast-moving items)

- **Capacitor major version.** This doc targets **Capacitor 7** (current as of the knowledge cutoff). Check `npm view @capacitor/core version` — if 8.x is stable, read its migration notes; APIs below are stable across 6/7 but native-tooling minimums change.
- **Store fees in INR** (forex + any GST) — §14 uses ~₹84/USD.
- **Google Play target API level** — Play raises the required `targetSdkVersion` every year (deadline ~Aug/Nov). Capacitor's template usually tracks it; confirm at submission.
- **Google's new-account testing requirement** (12 testers / 14 days) — exact thresholds have changed before.
- **Capgo pricing / tiers** and **Ionic Appflow's status** (§5.1).
- **FCM legacy API is dead** (shut down mid-2024) — you *must* use **HTTP v1**. Any tutorial using a "server key" is obsolete.
- **Apple guideline numbers** (4.2, 3.1.3(e), 5.1.1(v), 2.5.2) — wording shifts; the principles are stable.

---

## 1. Executive summary & objectives

### 1.1 What we are building

Wrap the **existing** React + TypeScript + Vite PWA (unchanged app logic, Supabase backend, Vercel
hosting) in a **Capacitor** native shell and ship it as:

- an **iOS app** on the Apple App Store, and
- an **Android app** on Google Play.

The same `dist/` web build runs inside a native WebView on both platforms. We add a thin layer of
**native capabilities** (push, geolocation, secure storage, deep links, splash/status bar, native
payment) so the app is genuinely "native enough" to pass review and feel polished — *not* a thin
website wrapper (the #1 rejection risk; see §10).

Three operational capabilities are first-class requirements:

1. **Push notifications** (order status, delivery, promotions) — FCM + APNs via a Supabase Edge Function (§4).
2. **OTA live updates** — push JS/HTML/CSS to the installed app without a store re-review for most changes, via **Capgo** (§5).
3. **CI/CD** — automated builds + (where allowed) releases from the repo via **GitHub Actions + Fastlane**, with **Codemagic** as the budget iOS fallback (§8).

Plus the net-new product work that this effort pulls in: **Razorpay payments** (web checkout + correct in-WebView behaviour) and a store-mandated **in-app account-deletion** flow.

### 1.2 Why Capacitor (given your stack)

- Reuses the **entire existing Vite build** — no rewrite, no second codebase. The web PWA and the native apps share one React codebase.
- Native plugins are JS-bridged, so you stay in TypeScript for 95% of the work.
- OTA-friendly: because the app is web assets in a WebView, a code-push tool (Capgo) can swap the JS bundle. (A pure-native React Native app can't do CSS-level hot updates the same way.)
- One person can realistically operate it.

### 1.3 Success criteria

| Criterion | Target |
|---|---|
| Both apps live on stores | iOS + Android, public track |
| Passes review first or second attempt | No 4.2 "just a website" rejection |
| Push delivered end-to-end | Order `pending→accepted` triggers a push that deep-links to `/orders/:id` |
| OTA proven | A CSS/JS fix reaches installed devices within minutes, no store review |
| CI green | Tagging a release produces signed iOS + Android artifacts unattended |
| Payments | Razorpay checkout works in-WebView/native on real devices (when enabled) |
| Compliance | Apple Privacy labels + Google Data Safety filled and accurate; account deletion shipped; DPDP-aligned |
| Cost | Recurring cloud spend under ~₹1,500/mo beyond existing infra |

### 1.4 Scope boundaries

**In scope:** Capacitor init/config, native capability layer, push, OTA, CI/CD, Razorpay integration, store listings, compliance, testing, launch.
**Out of scope (keep on web/Supabase as-is):** the React app's product logic, RLS, Edge Functions for OTP/SMS, Vercel hosting of the web PWA (it stays — the web app continues to exist alongside the native apps and remains the OTA source).

---

## 2. Architecture & approach

### 2.1 The big picture

```
                        ┌─────────────────────────────────────────────┐
                        │         ONE React + Vite codebase            │
                        │  (src/ — unchanged product logic)            │
                        └───────────────┬──────────────┬───────────────┘
                                        │              │
                       vite build (web) │              │ vite build (capacitor mode)
                       PWA SW ON         │              │ PWA SW OFF  → dist/ → copied into native
                                        ▼              ▼
                            ┌────────────────┐   ┌───────────────────────────────┐
                            │ Vercel (web)   │   │ Capacitor native shells        │
                            │ redlotusfoods  │   │  ios/  (Xcode)  android/ (Gradle)│
                            │ .in (PWA)      │   │  WKWebView      WebView          │
                            └───────┬────────┘   └───────┬───────────────┬────────┘
                                    │                    │               │
                       (OTA source) │     Capgo OTA  ◄───┘   native plugins (push,
                                    └────────────────►       geo, storage, razorpay…)
                                       JS/CSS bundle
                                        to devices

   Backend (unchanged): Supabase — Auth, Postgres+RLS, Storage, Edge Functions, Realtime
   New backend bits:    device_tokens table (mig 019), send-push Edge Function, FCM project
```

**What runs as web vs native:**

| Concern | Runs as | Notes |
|---|---|---|
| All UI, routing, cart, checkout, dashboard | **Web** (React in WebView) | Zero change |
| Supabase queries, RLS, Realtime, RPC (`place_order`, `cancel_order`) | **Web** (JS SDK over HTTPS/WSS) | WebSockets work in WebView |
| Auth session persistence | **Native-assisted** | Custom storage adapter → secure storage (§6) |
| Google OAuth | **Native** (system browser + deep link) | Webview OAuth is blocked by Google (§6.3) |
| Geolocation | **Native plugin** (`@capacitor/geolocation`) | Replaces `navigator.geolocation` for reliable permissions |
| Push notifications | **Native plugin** | §4 |
| Razorpay checkout | **Native plugin** on device, **web checkout.js** on PWA | Branch on `Capacitor.isNativePlatform()` (§7) |
| Splash, status bar, back button, safe areas | **Native plugins / CSS** | §6 |
| OTA bundle swap | **Native plugin** (Capgo) | §5 |

### 2.2 Folder & config layout after `npx cap init`

```
landing/
├─ src/                      # unchanged React app
├─ dist/                     # vite build output → Capacitor webDir
├─ capacitor.config.ts       # NEW — native config (below)
├─ ios/                      # NEW — generated Xcode project (commit it)
│  └─ App/App/Info.plist     #   permission strings, URL schemes, associated domains
├─ android/                  # NEW — generated Gradle project (commit it)
│  └─ app/src/main/AndroidManifest.xml
│  └─ app/src/main/assets/   #   capacitor assets
├─ resources/                # NEW — icon.png + splash.png source for @capacitor/assets
├─ fastlane/                 # NEW — Fastfile, Appfile, Matchfile (§8)
├─ .github/workflows/        # NEW — mobile-build.yml (§8)
└─ vite.config.ts            # MODIFIED — disable PWA in capacitor mode (§2.4)
```

> **Commit `ios/` and `android/`.** They contain real config you'll hand-edit (Info.plist,
> entitlements, manifest). The alternative — regenerating from scratch — loses that. Add only
> build artifacts (`ios/App/Pods/`, `android/.gradle/`, `*/build/`) to `.gitignore`.

### 2.3 `capacitor.config.ts` (starting point)

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.redlotusfoods.app',          // A7 — reverse-DNS, immutable after store submit
  appName: 'RedLotus',
  webDir: 'dist',                          // matches vite outDir
  // No `server.url` in production — we ship the bundled web assets (required for OTA + offline shell).
  // For dev live-reload only, run `npx cap run ios -l --external` (sets server.url to your LAN IP).
  ios: {
    contentInset: 'always',
  },
  android: {
    // Allow http only for local dev if ever needed; keep false for prod.
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'], // foreground display on iOS
    },
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#fdf8f6',          // your warmBg token
      showSpinner: false,
    },
    CapacitorUpdater: {                     // Capgo (§5)
      autoUpdate: true,
      // appReadyTimeout / responseTimeout etc. tuned in §5
    },
  },
};

export default config;
```

### 2.4 The service-worker conflict (must-fix, stack-specific)

Your `vite.config.ts` registers a Workbox service worker (`registerType: 'autoUpdate'`,
`skipWaiting`, `clientsClaim`). **Inside a Capacitor WebView a service worker is actively
harmful:**

- Capacitor serves the app from `capacitor://localhost` (iOS) / `https://localhost` (Android). A SW registered there caches assets and can serve a **stale bundle that fights Capgo's OTA swap** — the exact two-bundles-disagree problem you already hit on web ("kept users on the old bundle after the accuracy fix").
- `navigateFallback` and runtime caching add a second, redundant caching layer the native runtime doesn't need (Capacitor already serves the shell from local files — offline shell is free).

**Fix: build a Capacitor-specific bundle with the PWA plugin disabled.** Keep the PWA for the
*web* build (web users still get installable PWA + offline). Gate `VitePWA(...)` on a mode/flag:

```ts
// vite.config.ts (modified excerpt)
export default defineConfig(({ mode }) => {
  const isCapacitor = mode === 'capacitor' || process.env.CAP_BUILD === '1';
  // ...existing env loading...
  return {
    // ...define, etc...
    plugins: [
      react(),
      // Web build: PWA on. Capacitor build: PWA off (no service worker).
      ...(isCapacitor ? [] : [VitePWA({ /* ...existing config... */ })]),
    ],
  };
});
```

Add scripts:

```jsonc
// package.json
"scripts": {
  "build": "tsc -b && vite build",                         // web (PWA on) — unchanged, Vercel uses this
  "build:cap": "tsc -b && vite build --mode capacitor && npx cap sync",
  "cap:ios": "npm run build:cap && npx cap open ios",
  "cap:android": "npm run build:cap && npx cap open android"
}
```

> If you ever prefer to keep one build, the alternative is `selfDestroying: true` in VitePWA for
> the native bundle — but a clean "no SW at all" native build is simpler and less surprising.

### 2.5 Capacitor plugins — what and why

| Plugin | Why it's needed | Notes |
|---|---|---|
| `@capacitor/core`, `/cli`, `/ios`, `/android` | The runtime + native projects | Base install |
| `@capacitor/push-notifications` | FCM/APNs registration + receive (§4) | Core requirement |
| `@capacitor/app` | Deep-link `appUrlOpen`, Android **back button**, app state (resume → refresh) | Core requirement |
| `@capacitor/splash-screen` | Branded launch; hide when React is ready | Anti-4.2 polish |
| `@capacitor/status-bar` | Status-bar colour/style; with safe-area CSS | iOS notch / Android |
| `@capacitor/geolocation` | Replaces `navigator.geolocation` for reliable native permission prompts + accuracy | You already use geo heavily |
| `@capacitor/preferences` | Simple native key-value (non-secret) | Migrate `localStorage` caches (location cache, dismissed-prompt flags) optionally |
| **Secure storage** (`capacitor-secure-storage-plugin` or `@aparajita/capacitor-secure-storage`) | Keychain/Keystore-backed token store for the Supabase session (§6.1) | Security + durability |
| `@capacitor/browser` | System browser for Google OAuth (§6.3) | OAuth correctness |
| `@capacitor/network` | Detect offline; show banner (no SW caching now) | Offline UX |
| `@capacitor/keyboard` | Resize/scroll behaviour for inputs (checkout, login) | Form UX |
| `@capacitor/haptics` *(optional)* | Tactile feedback on add-to-cart / place-order | Polish |
| `@capacitor/share` *(optional)* | Share a restaurant/dish | Native feel |
| `@capgo/capacitor-updater` | **OTA** (§5) | Core requirement |
| `@sentry/capacitor` + `@sentry/react` | Crash + JS error reporting (§12) | Ops |
| Razorpay plugin (`capacitor-razorpay` community / native SDK) | Native payment sheet, correct UPI app-switch + OTP (§7) | Bundle in v1 (A4) |
| `@capacitor/assets` *(dev dep)* | Generate icons + splash from one source image | Build-time only |

---

## 3. Prerequisites & accounts

### 3.1 Apple Developer Program (iOS)

| Item | Detail |
|---|---|
| Cost | **$99/yr** (≈ ₹8,300–8,900 incl. forex; **⚠ VERIFY**). |
| Account type | **Individual** is fine for a solo founder. Apps list the seller name; an individual account shows *your legal name* publicly. An **Organisation** account (needs a D-U-N-S number, free to obtain, ~1–2 weeks) shows the business name — nicer for a brand but slower. **Recommendation: start Individual, migrate later if needed.** |
| India specifics | Enrolment now usually requires identity verification in the **Apple Developer app** (government ID). Payment via card; an Indian card works. Plan for 1–3 days. |
| Certificates & signing | You need a **Distribution certificate** (`.p12`) + an **App Store provisioning profile** for `in.redlotusfoods.app`. Easiest path: let **Xcode "Automatically manage signing"** create them, *then* export for CI. For CI, prefer **Fastlane Match** (stores certs in a private git repo, encrypted) — §8. |
| APNs key | Create **one APNs Auth Key (`.p8`)** in the Developer portal (Keys → +). Note the **Key ID** + your **Team ID**. You upload this `.p8` to **Firebase** so FCM can relay to APNs (§4.1). One key covers all your apps. |
| App record | Create the app in **App Store Connect** (apps.apple.com) with the bundle id and SKU. |

### 3.2 Google Play Console (Android)

| Item | Detail |
|---|---|
| Cost | **$25 one-time** (≈ ₹2,100; **⚠ VERIFY**). |
| Account type | Individual or Organisation. Individual requires **identity + (sometimes) address verification**; plan 1–3 days, occasionally longer. |
| **⚠ Closed-testing gate (A2)** | Personal accounts created after **13 Nov 2023** must run a **closed test with ≥12 testers who stay opted-in for ≥14 continuous days** before you can apply for production access. **This dominates the timeline (§13).** Start recruiting 12 testers *now* (friends, family, the Gudha Gorji restaurant owners, an MCA cohort). **⚠ VERIFY** the exact count/days in Console — Google has changed it. |
| App signing | Use **Play App Signing** (default, strongly recommended). You upload an **upload key**; Google holds the real **app signing key**. Benefit: if you lose your upload key, Google can reset it — you are *not* permanently locked out (the classic keystore-loss catastrophe). You still must **back up your upload keystore** (§3.3). |
| Upload keystore | Generate once (below). Store the file + passwords in a password manager **and** an offline backup. |
| Data Safety + content rating | Required forms before publishing (§9.5, §9.6). |

```bash
# Generate the Android UPLOAD keystore (run once; back up the .jks + passwords forever)
keytool -genkey -v -keystore redlotus-upload.jks -keyalg RSA -keysize 2048 \
  -validity 9125 -alias redlotus-upload
# Store: keystore file, store password, key password, alias — in a password manager + offline.
```

### 3.3 Signing secrets inventory (you'll need these for CI — §8)

| Secret | Platform | Where used |
|---|---|---|
| Distribution cert `.p12` + password | iOS | Fastlane Match / Xcode export |
| App Store Connect API key (`.p8` + Key ID + Issuer ID) | iOS | Fastlane upload to TestFlight |
| APNs Auth Key `.p8` (Key ID, Team ID) | iOS push | Uploaded to Firebase (not CI) |
| Upload keystore `.jks` + storePassword + keyPassword + alias | Android | Gradle signing in CI |
| Google Play service account JSON | Android | Fastlane `supply` upload |
| `google-services.json` (Android) + `GoogleService-Info.plist` (iOS) | Both | FCM config (from Firebase) |
| FCM service account JSON | Backend | `send-push` Edge Function secret (§4) |
| Capgo API key | OTA | CI deploy step (§5/§8) |

### 3.4 Mac requirement (A1)

iOS *must* be built on macOS. Options, cheapest-first:

| Option | Cost | Fit |
|---|---|---|
| **Codemagic** free tier | Free 500 macOS-M min/mo | Best Mac-less start; Capacitor-aware; handles signing. **Recommended if no Mac.** |
| **GitHub Actions** macOS runner | Free tier ~limited; private-repo macOS minutes billed 10× | Fine but watch minutes (§8/§14) |
| Cloud Mac rental (MacinCloud/MacStadium) | ~$20–30/mo | If you want an interactive Mac for debugging |
| Buy a Mac mini (M-series) | ~₹60,000 one-time | Best long-term DX if budget allows |

Android builds run on Linux/Windows (you can build locally on your current machine).

---

## 4. Push notifications

### 4.1 Setup: FCM (Android **and** iOS)

**Key simplification for a solo founder: use FCM for *both* platforms.** FCM relays to APNs for
iOS, so you integrate **one** send API (FCM HTTP v1) instead of FCM *and* raw APNs.

1. Create a **Firebase project** (free Spark plan is enough).
2. Add an **Android app** (package `in.redlotusfoods.app`) → download `google-services.json` → place in `android/app/`.
3. Add an **iOS app** (bundle `in.redlotusfoods.app`) → download `GoogleService-Info.plist` → place in `ios/App/App/`.
4. **Cloud Messaging → Apple app config → upload your APNs Auth Key `.p8`** (Key ID + Team ID from §3.1). This is what lets FCM deliver to iOS.
5. In Xcode: enable **Push Notifications** + **Background Modes → Remote notifications** capabilities.
6. Install plugin: `npm i @capacitor/push-notifications && npx cap sync`.

> **⚠ VERIFY:** FCM **legacy server keys are gone**. Use **HTTP v1** with a service-account
> OAuth token (§4.3). Ignore any guide referencing `fcm.googleapis.com/fcm/send` or a "Server key".

### 4.2 Where device tokens live — `device_tokens` table (migration 019)

Mirrors your existing RLS conventions (`GRANT … TO authenticated`, `FOR ALL USING/WITH CHECK`,
`get_user_role()` admin policy, `set_updated_at()` trigger). The send function uses the
**service role** (bypasses RLS), so no broad read grant is needed.

```sql
-- ============================================================
-- 019_device_tokens.sql
-- Push notification device registry.
--   One row per (device token). A token is globally unique; if a
--   device changes hands (logout → another login) we UPSERT on the
--   token and re-point user_id. Tokens are deleted on sign-out and
--   pruned when FCM reports them stale (UNREGISTERED) from send-push.
-- RLS: the owning user manages only their own rows. The send-push
--   Edge Function reads via service_role (bypasses RLS).
-- Run NINETEENTH (after 018_owner_policies_authenticated.sql).
-- ============================================================

CREATE TABLE public.device_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token       text        NOT NULL,
  platform    text        NOT NULL CHECK (platform IN ('ios','android','web')),
  app_version text,                                  -- e.g. '1.2.0' for debugging deliverability
  last_seen_at timestamptz NOT NULL DEFAULT now(),   -- refreshed each app open
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A token is unique to a device install; UPSERT target.
CREATE UNIQUE INDEX device_tokens_token_key ON public.device_tokens (token);
CREATE INDEX idx_device_tokens_user ON public.device_tokens (user_id);

CREATE TRIGGER set_device_tokens_updated_at
  BEFORE UPDATE ON public.device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_tokens TO authenticated;

-- Owning user only. Service role (send-push) bypasses RLS, so no extra read policy.
CREATE POLICY device_tokens_own_all ON public.device_tokens
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY device_tokens_admin_all ON public.device_tokens
  FOR ALL USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
```

Client registration (call after `SIGNED_IN`; a natural home is `AuthContext` or a `<NativeBridge>`
mounted inside the Router). Upsert on the unique `token`:

```ts
// src/lib/push.ts (native only)
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from './supabaseClient';

export async function registerPush(userId: string) {
  if (!Capacitor.isNativePlatform()) return;            // web uses PWA / nothing
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return;               // respect the user's choice

  await PushNotifications.register();                    // → 'registration' event with the token

  PushNotifications.addListener('registration', async ({ value: token }) => {
    await supabase.from('device_tokens').upsert(
      { user_id: userId, token, platform: Capacitor.getPlatform(),
        app_version: APP_VERSION, last_seen_at: new Date().toISOString() },
      { onConflict: 'token' },                           // re-point token to current user
    );
  });
  PushNotifications.addListener('registrationError', (e) => console.error('[push] reg error', e));
}
```

On sign-out, delete this device's token (extend `AuthContext.signOut`, which already clears the
location cache):

```ts
// inside signOut(), before/after supabase.auth.signOut()
if (Capacitor.isNativePlatform()) {
  // token captured at registration time, kept in a module ref
  if (lastToken) await supabase.from('device_tokens').delete().eq('token', lastToken);
}
```

### 4.3 Sending — Supabase Edge Function → FCM HTTP v1

**Recommendation: a custom `send-push` Edge Function (not OneSignal).** Reasoning in §4.4.

It mirrors your `notify-pending-orders` style (Deno.serve, service-role client, secret-gated,
`json()` helper). FCM HTTP v1 needs a short-lived OAuth token minted from the **FCM service
account** private key (RS256 JWT → Google token endpoint), then a POST per token.

```ts
// supabase/functions/send-push/index.ts  (outline — mirrors notify-pending-orders patterns)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// FCM service account JSON, stored as a single secret:
//   supabase secrets set FCM_SERVICE_ACCOUNT="$(cat service-account.json)"
const FCM_SA = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!);
const PROJECT_ID = FCM_SA.project_id;

Deno.serve(async (req) => {
  // 1. Auth — same shared-secret gate as your cron functions
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET"))
    return json({ error: "unauthorized" }, 401);

  // 2. Payload — { user_id, title, body, data: { url, type, order_id } }
  //    (When wired to a DB webhook on orders, derive these from record/old_record.)
  const { user_id, title, body, data } = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 3. Look up this user's device tokens
  const { data: rows } = await supabase
    .from("device_tokens").select("token, platform").eq("user_id", user_id);
  if (!rows?.length) return json({ sent: 0, reason: "no_tokens" });

  // 4. Mint an OAuth2 access token from the service account (RS256 JWT)
  const accessToken = await getAccessToken(FCM_SA);   // helper below

  // 5. Send one message per token; prune stale tokens on UNREGISTERED/NOT_FOUND
  let sent = 0;
  for (const { token } of rows) {
    const resp = await fetch(
      `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
      { method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])),
            android: { priority: "high", notification: { channel_id: "orders" } },
            apns: { payload: { aps: { sound: "default", "content-available": 1 } } },
          },
        }),
      });
    if (resp.ok) sent++;
    else {
      const err = await resp.json().catch(() => ({}));
      const code = err?.error?.details?.[0]?.errorCode;
      if (code === "UNREGISTERED" || resp.status === 404)
        await supabase.from("device_tokens").delete().eq("token", token); // prune
    }
  }
  return json({ sent });
});

// --- OAuth2 token from service account using Web Crypto (RS256). ---
async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
                  aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claim)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(unsigned)));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...sig)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  return (await r.json()).access_token as string;
}
function pemToArrayBuffer(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}
```

> To cut the crypto boilerplate you may import a small helper (e.g. a Deno-compatible
> `google-auth-library` build via esm.sh, or a community `firebase-admin`-lite). Keep the manual
> version if you want zero extra deps — it's stable. **⚠ VERIFY** the FCM v1 request shape and
> error `errorCode` names against current docs.

**Firing the push from order events (no extra app code).** Use a **Supabase Database Webhook**
(Dashboard → Database → Webhooks) on `orders` **UPDATE** → calls `send-push`. The webhook payload
includes `record` + `old_record`, so the function sends only on meaningful transitions:

```
old_record.status='pending'   & record.status='accepted'   → "Order accepted! Arriving soon."
old_record.status='accepted'  & record.status='preparing'  → "Your food is being prepared."
... 'out_for_delivery'        → "Out for delivery 🛵"
... 'completed'               → "Delivered. Enjoy your meal!"
... 'declined' / 'cancelled'  → status-appropriate copy
```
Each carries `data: { type: 'order_status', order_id: record.id, url: '/orders/' + record.id }`.
(Alternatively, replicate your `pg_cron` → `net.http_post` pattern from `notify-pending-orders`
with a trigger — the webhook is just the managed version of that.)

### 4.4 Custom Edge Function vs OneSignal — recommendation

| Dimension | Custom (Supabase EF → FCM) | OneSignal |
|---|---|---|
| Setup effort | Higher (this doc removes most of it) | Lower (dashboard + SDK) |
| Monthly cost | **Free** (FCM free; EF in your plan) | Free tier generous; paid as you grow |
| Data ownership / DPDP | **Stays in your stack**; no new processor | Adds a third-party data processor → another DPDP disclosure + privacy-label entry |
| Fit with your data | **Excellent** — order state already lives in Supabase; push fires where status changes | You'd push order events *out* to OneSignal or call its API from an EF anyway |
| Segmentation/scheduling/dashboard | DIY (insert a row / call EF) | Built-in (nice for promo blasts) |
| Vendor lock-in | None | Some |

**Recommendation: custom `send-push` Edge Function.** Your notifications are mostly
**transactional** and triggered by DB state you already own — firing them from Supabase (where the
order changes) is simpler end-to-end than shipping events to a marketing tool. You also avoid a
new data processor (cleaner DPDP story) and stay at ₹0. The one thing OneSignal makes easier —
promo campaigns — you can cover by inserting a "broadcast" row that fans out to tokens, and you
rarely send promos in early days. **Fallback rule:** if you later need rich campaign tooling
(A/B, scheduling, geo-segments) and it's eating your time, adopt OneSignal *then* — the
`device_tokens` table and registration code port over.

### 4.5 Permissions & notification UX

- **Don't prompt on launch.** Ask for push permission **contextually** — e.g. right after the
  first successful order ("Get live updates on your order?") with a short pre-prompt explaining
  value, *then* call `requestPermissions()`. iOS gives you exactly one system prompt; a pre-prompt
  protects it.
- **Android 13+ (API 33+)** requires the runtime `POST_NOTIFICATIONS` permission — the plugin
  handles it, but it must be in the manifest (Capacitor adds it).
- **Android channels:** create an `orders` channel (high importance, sound) and a `promos`
  channel (default). Users can mute promos without losing order alerts — good citizenship + fewer
  uninstalls.

### 4.6 Deep-linking from a notification into the right screen

Register listeners in a `<NativeBridge>` component mounted **inside** the Router so it can use
`useNavigate()`:

```tsx
// src/components/NativeBridge.tsx (rendered inside <BrowserRouter> in App)
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { App as CapApp } from '@capacitor/app';

export default function NativeBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Tapped a notification → go to its screen (e.g. /orders/:id)
    const tap = PushNotifications.addListener('pushNotificationActionPerformed', (e) => {
      const url = e.notification.data?.url;            // '/orders/<id>'
      if (url) navigate(url);
    });

    // Universal/App Link or OAuth redirect → route within the app
    const deep = CapApp.addListener('appUrlOpen', ({ url }) => {
      // e.g. https://redlotusfoods.in/orders/123  → navigate('/orders/123')
      const path = new URL(url).pathname + new URL(url).search;
      if (path) navigate(path);
    });

    return () => { tap.then(h => h.remove()); deep.then(h => h.remove()); };
  }, [navigate]);
  return null;
}
```

> Edge case: the app launched **cold** from a notification. The listener still fires after the
> WebView boots; just ensure `<NativeBridge>` mounts early. Foreground notifications use
> `pushNotificationReceived` if you want an in-app toast instead of the system banner.

### 4.7 Coexistence with existing MSG91 SMS — channel matrix

Push and SMS serve **different** purposes; design avoids double-notifying.

| Event | Audience | Channel | Rationale |
|---|---|---|---|
| Login OTP | Customer | **SMS (MSG91)** — unchanged | OTP must reach users with no app yet |
| Order status (accepted→…→delivered) | Customer | **Push** (new) | Free, rich, deep-links; SMS not currently sent for these |
| Owner missed a pending order (≥1 min) | Owner | **SMS backstop (MSG91)** — unchanged; *optionally also push* | Owner may not have the app / push unlocked; SMS is the reliable escalation. If you add owner push, keep SMS as the ≥1-min backstop. |
| Promotions | Customer | **Push** (new) | Replaces costly promo SMS → **saves money** |

Rule: **never send both push and SMS for the same event.** OTP and owner-escalation stay on SMS;
customer order-status and promos move to push. This also trims MSG91 spend over time.

---

## 5. OTA / live updates

### 5.1 Capgo vs the official option — recommendation

| | **Capgo** (`@capgo/capacitor-updater`) | Ionic Appflow Live Updates (`@capacitor/live-updates`) |
|---|---|---|
| Nature | Open-source plugin + cloud (or self-host) | Proprietary, part of Ionic/OutSystems |
| Cost (solo) | ~$12–14/mo cloud tier; **free if self-hosted**; open-source core | Historically **enterprise-priced**; uncertain roadmap after acquisition |
| Capacitor community adoption | De-facto standard for code-push | Declining |
| Channels, staged rollout, rollback | Yes | Yes |
| Fit for budget solo founder | **Excellent** | Poor (cost) |

**Recommendation: Capgo.** It's purpose-built, affordable, open-source, and the community
standard for Capacitor OTA. **⚠ VERIFY** current Capgo pricing/tiers and the status of Appflow
(its future has been uncertain post-acquisition) before committing.

Setup:
```bash
npm i @capgo/capacitor-updater
npx cap sync
npx @capgo/cli init           # logs in, links app id in.redlotusfoods.app, sets API key
```
Add the plugin config (already shown in §2.3). In app bootstrap, call `notifyAppReady()` once the
React app has mounted so Capgo knows the new bundle is healthy (otherwise it auto-rolls-back):

```ts
import { CapacitorUpdater } from '@capgo/capacitor-updater';
// after first successful render / route resolved:
CapacitorUpdater.notifyAppReady();
```

Deploy a bundle (also wired into CI, §8):
```bash
npm run build:cap                       # produces dist/ (PWA off)
npx @capgo/cli bundle upload --channel production --path dist
```

### 5.2 What can and cannot be OTA-updated

| ✅ OTA-able (no store review) | ❌ Needs a full store build + review |
|---|---|
| React/TypeScript logic, components, hooks | Capacitor core or plugin **version** bumps |
| HTML, CSS, design tokens, copy | **Adding/removing a native plugin** |
| New screens/routes (JS only) | Native permissions (Info.plist / AndroidManifest changes) |
| Bug fixes in JS, pricing-display tweaks, search logic | App icon / splash / native `capacitor.config.ts` native keys |
| Supabase query changes, new RPC calls (server already supports) | Targeting a new OS API level; Capacitor upgrade |
| Feature **flags** flipping JS behaviour (e.g. enabling the already-bundled Razorpay path — A4) | Enabling a feature that needs a *new* native capability |

**Mental model:** if it lives in `dist/` after `vite build`, it's OTA-able. If it lives in `ios/`
or `android/` native code, it needs a store submission.

### 5.3 Channel strategy, staged rollout, rollback

- **Channels:** `production` (live users) and `staging` (your test devices / TestFlight-style
  internal). Optionally a `beta` channel mapped to a small opt-in cohort.
- **Staged rollout:** Capgo supports percentage rollout — release a bundle to, say, 10% of
  `production`, watch Sentry (§12) for a spike, then ramp to 100%.
- **Rollback:** because `notifyAppReady()` gates health, a bundle that crashes before "ready"
  **auto-reverts** to the last good bundle. You can also manually re-point a channel to a previous
  bundle from the Capgo dashboard/CLI. Keep the last 2–3 good bundles.

### 5.4 Store policy compliance for code-push (the boundaries)

Both stores allow OTA of **interpreted code (JS/HTML/CSS)** for **bug fixes and improvements that
do not change the app's core purpose or behaviour**, *provided the running code stays consistent
with the reviewed app and the store guidelines.*

- **Apple Guideline 3.3.2 / 2.5.2:** you may download and run script/code via the system WebView
  (JavaScript), but it **must not materially change the app's intended/advertised purpose**, add
  features that would change its content rating, or be used to circumvent review. Food-ordering
  app shipping a CSS fix or a new menu screen = fine. Turning it into a different product via OTA =
  violation.
- **Google Play:** similar — interpreted-language updates are allowed; you must not use them to
  violate policy (e.g. introduce payments-for-digital-goods that bypass review, change permissions
  behaviour, or ship deceptive behaviour).

**Safe-harbour rules for RedLotus OTA:**
1. Never use OTA to add a feature that would need a **new permission** or **new native plugin** (do that via a store build).
2. Never use OTA to change what the app fundamentally is (still a food-ordering app).
3. Keep the OTA'd code's behaviour consistent with your store description and privacy labels.
4. Don't OTA anything that changes **payment** flows in a way that conflicts with store rules (your Razorpay-for-physical-goods is fine either way — §7).

---

## 6. Essential native capabilities checklist

Each item below is a copy-paste task. Items marked ★ are also **anti-4.2** (make the app feel
native — §10).

### 6.1 Secure token storage ★

Default Supabase JS uses `localStorage`. In WKWebView, `localStorage` can be **evicted under
storage pressure** and isn't secure storage. Provide a **custom storage adapter** backed by
Keychain (iOS) / Keystore (Android), and enable **PKCE** (needed for the native OAuth flow, §6.3):

```ts
// src/lib/supabaseClient.ts (native-aware)
import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'; // or @aparajita/capacitor-secure-storage

const native = Capacitor.isNativePlatform();
const secureStorage = {
  getItem: async (k: string) => (await SecureStoragePlugin.get({ key: k }).catch(() => null))?.value ?? null,
  setItem: async (k: string, v: string) => { await SecureStoragePlugin.set({ key: k, value: v }); },
  removeItem: async (k: string) => { await SecureStoragePlugin.remove({ key: k }).catch(() => {}); },
};

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: 'pkce',                          // required for the native OAuth deep-link flow
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: !native,               // native handles the redirect manually (§6.3)
      ...(native ? { storage: secureStorage } : {}),
    },
  },
);
```

> Test this carefully: the storage adapter is async; Supabase JS supports async storage. Verify
> session survives a cold app kill + relaunch on a real device.

### 6.2 App icon & splash screen ★

Generate from one source with `@capacitor/assets`:
```bash
npm i -D @capacitor/assets
# place resources/icon.png (1024×1024) and resources/splash.png (2732×2732, centered logo on #fdf8f6)
npx capacitor-assets generate
```
Reuse your brand red `#D63031` / warmBg `#fdf8f6` and the soup glyph from `public/pwa-icon.svg`.
Hide the splash once React is ready (or rely on the `launchShowDuration`).

### 6.3 Google OAuth via system browser ★ (must-fix)

Google **blocks OAuth inside embedded WebViews** (`403 disallowed_useragent`). Email/password and
phone-OTP (MSG91) work fine in the WebView; **only Google sign-in needs this flow:**

1. In Supabase → Auth → URL Configuration, add redirect URLs:
   `in.redlotusfoods.app://auth/callback` **and** `https://redlotusfoods.in/auth/callback`.
2. Register the custom scheme natively (Info.plist `CFBundleURLTypes`; AndroidManifest intent-filter).
3. Native sign-in:

```ts
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { supabase } from './supabaseClient';

export async function signInWithGoogle() {
  if (!Capacitor.isNativePlatform()) {
    return supabase.auth.signInWithOAuth({ provider: 'google',
      options: { redirectTo: `${import.meta.env.VITE_SITE_URL}/auth/callback` } });
  }
  const { data } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'in.redlotusfoods.app://auth/callback', skipBrowserRedirect: true },
  });
  if (data?.url) await Browser.open({ url: data.url });   // system browser
}
// In <NativeBridge> appUrlOpen handler: if url starts with the custom scheme, extract ?code= and:
//   await supabase.auth.exchangeCodeForSession(code); await Browser.close();
```

> This is the most common Capacitor + Supabase pain point — budget half a day to get it solid on
> both platforms.

### 6.4 Status bar & safe areas ★

```html
<!-- index.html -->
<meta name="viewport" content="viewport-fit=cover, width=device-width, initial-scale=1" />
```
```css
/* global CSS — pad fixed top/bottom bars for notch / home indicator / gesture nav */
.app-top-bar { padding-top: env(safe-area-inset-top); }
.cart-bar    { padding-bottom: env(safe-area-inset-bottom); }
```
Set status-bar style on launch (`@capacitor/status-bar`): dark text on your light `#fdf8f6`, or
overlay style on the brand-red header — match `AppTopBar`.

### 6.5 Android hardware back button ★

```ts
// in <NativeBridge>
import { App as CapApp } from '@capacitor/app';
CapApp.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) window.history.back();
  else CapApp.exitApp();          // or show a "press back again to exit" toast on the home route
});
```
Decide per-route: on `/` (storefront) back should confirm-exit; inside flows it should navigate
back. Without this, Android's back button does nothing or exits abruptly — an instant "feels
broken" signal.

### 6.6 Geolocation (already used) ★

Swap `navigator.geolocation` for `@capacitor/geolocation` on native for reliable permission
prompts + accuracy. Your coarse-first/escalation logic (`location_resilience_plan.md`) stays —
only the position source changes. Add usage strings:

```xml
<!-- ios/App/App/Info.plist -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>RedLotus uses your location to show nearby restaurants and set your delivery address.</string>
```
```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```
**Foreground (when-in-use) only — no background location.** This keeps you out of Google's
background-location review and Apple's "Always" justification. Add a **prominent disclosure**
screen before the prompt (§10.2).

### 6.7 Network / offline handling

With the SW removed from the native build, Capacitor serves the **shell** from local files
(always loads), but data needs network. Use `@capacitor/network` to detect offline and show a
banner / disable "Place order". This matches the live-ordering nature of the app (offline browsing
of stale data is undesirable for food delivery anyway).

### 6.8 Universal Links (iOS) / App Links (Android)

Lets `https://redlotusfoods.in/orders/123` open the app, and is the cleanest target for OAuth
callbacks + push deep links. Serve the association files from Vercel (`public/.well-known/`):

```jsonc
// public/.well-known/apple-app-site-association   (served with Content-Type: application/json, no extension)
{ "applinks": { "apps": [], "details": [
  { "appID": "TEAMID.in.redlotusfoods.app", "paths": ["/orders/*", "/restaurants/*", "/auth/*"] } ] } }
```
```jsonc
// public/.well-known/assetlinks.json
[{ "relation": ["delegate_permission/common.handle_all_urls"],
   "target": { "namespace": "android_app", "package_name": "in.redlotusfoods.app",
               "sha256_cert_fingerprints": ["<PLAY APP SIGNING SHA-256>"] } }]
```
Add the **Associated Domains** entitlement (iOS: `applinks:redlotusfoods.in`) and the autoVerify
intent-filter (Android). **⚠** Use the **Play App Signing** cert fingerprint (from Play Console),
not your upload key. Vercel may need a rewrite so `.well-known/*` is served verbatim with the
right content type — **⚠ VERIFY** after deploy with Apple's/Google's validators.

### 6.9 Razorpay in the WebView — see §7 (call-outs there).

### 6.10 Capability checklist (tick before first submission)

- [ ] App icon + adaptive icon (Android) + splash generated and look right on a notch device
- [ ] Status bar styled; safe-area insets applied to top/bottom bars
- [ ] Android back button wired (navigate vs exit-confirm)
- [ ] Geolocation via native plugin; usage strings present; prominent disclosure screen
- [ ] Secure token storage; session survives cold relaunch
- [ ] Google OAuth via system browser + deep link works on both OSes
- [ ] Universal Links / App Links verified (validators pass)
- [ ] Network offline banner
- [ ] Push permission contextual prompt + channels (orders/promos)
- [ ] Notification tap deep-links to `/orders/:id`
- [ ] Service worker disabled in the native bundle (§2.4)
- [ ] **In-app account deletion** flow (store requirement, §10.3)
- [ ] Razorpay native plugin compiled in (even if dark-launched, A4)

---

## 7. Payments & store policy nuance

### 7.1 The policy question (and the reassuring answer)

RedLotus sells **physical food with real-world delivery**. Both stores **exempt physical
goods/real-world services from in-app purchase (IAP)** and explicitly **allow external payment
processors** for them:

- **Apple Guideline 3.1.3(e) / 3.1.5(a):** apps selling **physical goods or services** consumed
  outside the app **must use a payment method other than IAP** — IAP is for *digital* goods only.
  Food delivery = physical → **Razorpay is required-correct, not just allowed.**
- **Google Play Payments policy:** purchases of **physical goods** (food, groceries) are **exempt**
  from Play Billing; you **must** use an alternative method (Razorpay) for them.

So Razorpay is the *right* choice and carries **no 30% store commission** for your use case. (You
do **not** add Apple/Google IAP at all.) **⚠ VERIFY** wording at submission, but this exemption is
long-standing and stable.

> Keep your store description focused on food ordering & delivery. Do **not** sell anything digital
> (e.g. "premium membership unlocking app features") via Razorpay — *that* would trip IAP rules. A
> subscription billed to **restaurants** (your B2B revenue, handled off-app via invoice) is outside
> the consumer app and fine.

### 7.2 How Razorpay behaves inside a Capacitor WebView (the pitfalls)

Razorpay's **web `checkout.js`** can *mostly* run in a WebView, but in practice it breaks on
mobile because:

- **UPI app intents** (`upi://`, `intent://`) need to launch GPay/PhonePe/Paytm — a plain WebView
  often won't hand off to those apps, leaving users stuck.
- **Bank 3-D-Secure / OTP pages** sometimes open new windows or use redirects the WebView mishandles.
- Pop-ups / `window.open` behave inconsistently across iOS/Android WebViews.

### 7.3 Recommended approach: native SDK on device, web checkout on PWA

Branch on platform. Use the **Razorpay native SDK via a Capacitor plugin** on device (handles UPI
app-switching, OTP autofill, the polished bottom sheet); keep **web `checkout.js`** for the PWA.

```ts
// src/lib/payments.ts
import { Capacitor } from '@capacitor/core';

export async function payWithRazorpay(order: { amount: number; currency: 'INR'; razorpayOrderId: string;
  name: string; description: string; prefill: { name: string; contact: string; email?: string } }) {
  if (Capacitor.isNativePlatform()) {
    const { Checkout } = await import('capacitor-razorpay');      // native sheet
    return Checkout.open({ key: import.meta.env.VITE_RAZORPAY_KEY_ID,
      amount: order.amount * 100, currency: order.currency, order_id: order.razorpayOrderId,
      name: order.name, description: order.description, prefill: order.prefill });
  }
  // Web/PWA: load checkout.js and open the web modal (existing approach for desktop/PWA users)
  // ...
}
```

> **⚠ VERIFY** the exact community plugin (`capacitor-razorpay` is the common one; confirm it's
> maintained for Capacitor 7) — if not, a thin custom plugin wrapping Razorpay's native Android/iOS
> SDK is a day of work. This is why we **bundle the plugin in v1 even with payments off (A4)** —
> adding it later needs a store build, but *enabling* it (the JS branch above) is then OTA-able.

### 7.4 Server side (Supabase) — order creation & verification

Razorpay needs a server to (1) create a Razorpay **order** and (2) **verify the payment signature**
(never trust the client). Two new Edge Functions, mirroring your patterns:

- `razorpay-create-order` — JWT-authed; creates a Razorpay order for the cart amount (recomputed
  server-side, same doctrine as `place_order`'s `PRICING_MISMATCH`), returns `razorpayOrderId`.
- `razorpay-verify` — verifies `razorpay_signature` (HMAC-SHA256 with key secret), then flips the
  `orders` row to paid / proceeds with `place_order`. Store `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`
  as Edge Function secrets (secret **never** in the client; only `VITE_RAZORPAY_KEY_ID` is public).

Sequencing note: since payments are net-new and *not* required for parity with the current web app
(COD), you can **launch native COD-first** and turn Razorpay on via OTA + config once the Edge
Functions and native plugin are proven (A4). This de-risks the first store review.

---

## 8. CI/CD pipeline

### 8.1 Strategy for a solo founder

**Phase the automation.** Don't build full CI before your first manual build works.

1. **Manual first:** build/sign/upload from Xcode + Android Studio for v1. Proves the pipeline by hand.
2. **Automate OTA early** (Capgo deploy on push to `main`) — it's cheap, high-value, and Linux-only.
3. **Automate store builds later** with GitHub Actions (Android on Linux; iOS on macOS) + Fastlane.
   If iOS macOS minutes hurt, use **Codemagic** for the iOS lane (free 500 min/mo).

### 8.2 Versioning strategy

- **Marketing version (semver):** `package.json` `version` → drives `CFBundleShortVersionString`
  (iOS) and `versionName` (Android). Bump `minor` for features, `patch` for fixes.
- **Build number (monotonic):** `github.run_number` → `CFBundleVersion` (iOS) and `versionCode`
  (Android, integer). Always increasing; stores reject re-used build numbers.
- **OTA bundles:** versioned independently by Capgo (channel + bundle id). Keep an OTA bundle's
  "compatible native version" in mind — only OTA JS that matches the native plugins shipped.
- A tiny script syncs `package.json` version + run number into native projects before build
  (`npx cap sync` + a `set-version` step, or Fastlane `increment_version_number`/`_build_number`).

### 8.3 GitHub Actions skeleton

```yaml
# .github/workflows/mobile.yml
name: Mobile build & OTA
on:
  push:
    branches: [main]          # OTA on every main push
    tags: ['v*']              # store builds on version tags

jobs:
  ota:                         # Capgo live update — Linux, cheap, runs on every main push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build:cap            # vite build --mode capacitor (PWA off)
      - run: npx @capgo/cli bundle upload --channel production --path dist
        env: { CAPGO_TOKEN: ${{ secrets.CAPGO_TOKEN }} }

  android:                     # store artifact — only on tags
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21 }
      - run: npm ci && npm run build:cap
      - name: Decode keystore
        run: echo "${{ secrets.ANDROID_KEYSTORE_B64 }}" | base64 -d > android/app/upload.jks
      - name: Build AAB
        run: cd android && ./gradlew bundleRelease
        env:
          KEYSTORE_PASSWORD: ${{ secrets.ANDROID_STORE_PASSWORD }}
          KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
      # Optional: Fastlane supply → upload to Play internal track
      - run: bundle exec fastlane android beta
        env: { PLAY_JSON_KEY: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }} }

  ios:                         # store artifact — macOS runner (or move to Codemagic)
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build:cap
      - name: Fastlane match + build + TestFlight
        run: bundle exec fastlane ios beta
        env:
          MATCH_PASSWORD: ${{ secrets.MATCH_PASSWORD }}
          MATCH_GIT_URL: ${{ secrets.MATCH_GIT_URL }}
          APP_STORE_CONNECT_API_KEY: ${{ secrets.ASC_API_KEY_JSON }}
```

### 8.4 Fastlane lanes (minimal)

```ruby
# fastlane/Fastfile
platform :ios do
  lane :beta do
    match(type: "appstore", readonly: true)      # pulls signing from your private match repo
    build_app(project: "ios/App/App.xcodeproj", scheme: "App")
    upload_to_testflight(skip_waiting_for_build_processing: true)
  end
end

platform :android do
  lane :beta do
    upload_to_play_store(track: "internal", aab: "android/app/build/outputs/bundle/release/app-release.aab")
  end
end
```

### 8.5 Secrets management

- Store everything from §3.3 in **GitHub Actions secrets** (base64 binaries where needed).
- **Never** commit keystores, `.p8`/`.p12`, service-account JSON, or `RAZORPAY_KEY_SECRET`.
- iOS signing: **Fastlane Match** in a *private* git repo (encrypted) is the cleanest way to share
  certs/profiles between your machine and CI.
- Supabase/Edge secrets stay in `supabase secrets` (not GitHub). FCM service-account JSON →
  `supabase secrets set FCM_SERVICE_ACCOUNT=...`.

### 8.6 Cost-control note (macOS minutes)

GitHub-hosted **macOS** minutes bill ~10× Linux on private repos. With iOS builds only on
**tags** (not every push) and OTA carrying day-to-day changes, you'll build iOS rarely (a few times
a month). If even that hurts, move the iOS lane to **Codemagic** (free tier) and keep GitHub
Actions for Android + Capgo. See §14.

---

## 9. Store listings

### 9.1 Names, IDs, category

| Field | Value |
|---|---|
| App name (Apple, 30 char) | `RedLotus: Food Delivery` |
| App name (Google, 30 char) | `RedLotus — Food Delivery` |
| Subtitle (Apple, 30) | `Local food, fast delivery` |
| Bundle id / package | `in.redlotusfoods.app` |
| Primary category | **Food & Drink** |
| Secondary (Google) | Shopping / Lifestyle |
| Default language | English (India) — `en-IN` |
| Support URL | `https://redlotusfoods.in` (+ a support/contact page) |
| Marketing URL | `https://redlotusfoods.in/welcome` |
| Privacy policy URL | your existing DPDP policy page (`/privacy-policy`) |

### 9.2 Description & keywords

- **Short description (Google, 80 char):** "Order delicious local food in Gudha Gorji. Fast
  delivery, no hidden fees."
- **Full description:** lead with the hyperlocal value (real local restaurants, low/no commission,
  fast delivery, COD + UPI), then features (live order tracking, saved addresses, push updates).
  Avoid superlatives Apple dislikes ("best", "#1"). Don't mention "website".
- **Apple keywords (100 char, comma-separated, no spaces):**
  `food,delivery,restaurant,order,gudha,rajasthan,local,tiffin,thali,cod,upi,online food`
  (tune to real search terms; don't repeat the app name or category — wasted characters).

### 9.3 Screenshots (required sizes)

Generate from real screens (storefront, restaurant menu, cart/checkout, order tracking, profile).
Use a device frame + 1-line captions. **⚠ VERIFY** exact pixel sizes at upload (Apple changes them).

| Platform / device | Sizes (typical) | Required? |
|---|---|---|
| iPhone 6.7"/6.9" (Pro Max) | 1290×2796 (or current) | **Yes** (Apple uses this as the base) |
| iPhone 6.5" | 1242×2688 | Often still requested |
| iPad 12.9" (if you support iPad) | 2048×2732 | Only if iPad-enabled |
| Android phone | min 1080px on short side; 16:9 / 9:16 | **Yes** (2–8 images) |
| Android 7" + 10" tablet | up to 1920+ | Recommended (tablet quality signal) |
| **Android feature graphic** | **1024×500** | **Yes** (required by Play) |

> **Decision:** keep it **iPhone-only at launch** (no iPad-optimised layout) to cut screenshot +
> QA work; you can add iPad later. On Android, phone screenshots + feature graphic are mandatory;
> tablet optional.

### 9.4 Content rating

- **Apple:** 4+ (no objectionable content). Complete the age-rating questionnaire honestly (no
  violence, gambling, etc.).
- **Google (IARC):** complete the questionnaire → expect **Everyone / 3+**. Food delivery has no
  mature content. If you ever add user reviews/chat, revisit.

### 9.5 Apple App Privacy labels (map to *your* data)

| Data type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Name | Yes | Yes | No | App functionality (orders) |
| Phone number | Yes | Yes | No | App functionality, account, OTP |
| Email | Yes | Yes | No | Account |
| Precise location | Yes | Yes | No | App functionality (nearby restaurants, delivery) |
| Coarse location | Yes | Yes | No | App functionality |
| Physical address (delivery) | Yes | Yes | No | App functionality (delivery) |
| Purchase history (orders) | Yes | Yes | No | App functionality |
| Payment info | Collected by **Razorpay** (card/UPI not stored by app) | No | No | Payment processing (when enabled) |
| Device ID (push token) | Yes | Yes | No | App functionality (notifications) |
| Crash data / diagnostics | Yes (Sentry) | No (scrub PII) | No | App functionality |

**Data used to track you: None.** Don't add ad/attribution SDKs → **no ATT prompt needed**. Keep
it that way; it's a real simplification and a privacy plus.

### 9.6 Google Data Safety form (parallel mapping)

- **Data collected:** Personal info (name, email, phone, address); Location (approx + precise);
  Financial info (payment — *processed by Razorpay*, when enabled); App activity (orders);
  Device/IDs (push token); Diagnostics (crash).
- **Shared with third parties:** Razorpay (payments), FCM/Google (push delivery), Supabase
  (processor/host), MSG91 (SMS). List processors honestly.
- **Security:** "Data is encrypted in transit" → **Yes** (HTTPS/WSS).
- **Data deletion:** "Users can request data deletion" → **Yes** — requires the **in-app account
  deletion** flow + a public deletion URL (§10.3). **This is mandatory; build it before submitting.**

> Keep Apple labels and Google Data Safety **consistent with your DPDP privacy policy** and with
> what the app actually does. Inconsistencies are a common rejection/penalty cause.

---

## 10. Compliance & rejection risk

### 10.1 Apple Guideline 4.2 — "Minimum Functionality" (the #1 risk for wrapped sites)

Apple rejects apps that are "just a repackaged website" with no native value. **How RedLotus
clears the bar** — point reviewers to these in the review notes:

| 4.2 mitigation (native capability) | Where |
|---|---|
| **Push notifications** for live order status | §4 |
| **Native geolocation** with proper permission + prominent disclosure | §6.6 |
| **Native payment** (Razorpay native SDK sheet, not a web redirect) | §7.3 |
| **Deep links / Universal Links** into specific orders | §6.8 |
| **Home-screen presence**, splash, app icon, status-bar integration | §6.2/6.4 |
| **Hardware back-button** handling, safe-area layout (feels native) | §6.5/6.4 |
| **Secure on-device storage** (Keychain/Keystore) | §6.1 |
| **Offline shell** + network awareness | §6.7 |
| Haptics / share (optional polish) | §6 |

Also: **don't reference "website", "browser", or "visit our site"** anywhere in the app UI (you
already avoid "app/download/install" per your v1 rules — extend that discipline). In **App Review
notes**, explicitly list the native features and provide a **test account** (a verified phone/login)
+ a note that it serves Gudha Gorji (so reviewers outside the delivery zone understand the empty
states — use the village-centre override or a demo restaurant so the reviewer sees content).

> **Reviewer-can't-see-content trap:** your storefront is geofenced to Gudha Gorji. A reviewer in
> California will hit empty states and may reject for "no functionality". **Mitigation:** ship a
> review build / config that seeds the `VILLAGE_CENTRE` override (you already have it) so the
> reviewer sees restaurants, and document the test steps in review notes.

### 10.2 Location prominent disclosure (Google + Apple)

Before the OS permission prompt, show an in-app screen explaining **why**:

> "RedLotus uses your location to show restaurants that deliver to you and to set your delivery
> address. We only access location while you're using the app. You can change this anytime in
> Settings."

Foreground-only (when-in-use) — **no background location** (§6.6) keeps you out of Google's
extra background-location declaration/review and Apple's "Always" justification.

### 10.3 In-app account deletion (mandatory — both stores)

- **Apple 5.1.1(v):** apps that let users create accounts must let them **delete** the account
  **from within the app**.
- **Google:** Data deletion policy requires an in-app path **and** a publicly reachable URL to
  request account+data deletion.

**Build:** a Profile → "Delete my account" action → confirm modal → an Edge Function
(`delete-account`, service-role) that deletes the auth user + cascades (`users` row; FKs cascade
to addresses/tokens; **decide order-history policy** — typically anonymise rather than hard-delete
to preserve restaurant settlement records, and disclose that in the policy). Add a public
`/delete-account` info page with the manual request route (WhatsApp/email). **⚠** Don't ship
without this — it's a guaranteed rejection otherwise.

### 10.4 Other India-relevant items

- **DPDP Act 2023:** you already have a compliant privacy policy — ensure it lists the new
  processors (FCM, Razorpay, Sentry) and the push token / location collection. Provide
  consent/notice for notifications & location at point of collection (the contextual prompts do
  this).
- **RBI / payments:** Razorpay is an RBI-authorised PA; using it (not storing card data) keeps you
  out of PCI scope. Don't store card numbers anywhere.
- **No background location, no ad tracking** → simplest compliance posture.

---

## 11. Testing & QA

### 11.1 Apple TestFlight

- **Internal testing:** up to 100 testers (your own ASC users) — **no beta review**, instant.
  Use this for your own devices.
- **External testing:** up to 10,000 testers via public link/email — needs a **Beta App Review**
  (usually fast). Good for a small Gudha Gorji pilot before public release.

### 11.2 Google Play tracks (and the gate)

`internal` → `closed` (alpha/beta) → `open` → `production`.

- **Internal testing:** up to 100 testers, near-instant.
- **⚠ Mandatory closed test (A2):** new personal accounts must run a **closed test with ≥12
  testers opted-in for ≥14 continuous days** before requesting production. **Plan this from day 1**
  — recruit the 12 now and get them installing during Phase 8. This is usually the **longest
  single wait** in the whole project.

### 11.3 Device coverage (budget-realistic)

Test on what your users actually have (tier-3/4 India → mostly **mid/low-end Android**, some
older iPhones):

| Tier | Devices |
|---|---|
| Must | 1 low-end Android (≤3 GB RAM, Android 11–13), 1 mid Android (Android 14/15), 1 iPhone (iOS 16+) |
| Nice | An older iPhone (SE/iOS 15), a tablet |
| Emulators | Android Studio AVD + Xcode Simulator for quick loops; **always final-test push, geo, payments, OAuth on real hardware** |

### 11.4 Pre-submission checklist (copy-paste)

```
ACCOUNTS & SIGNING
[ ] Apple Dev + Play Console enrolled & identity-verified
[ ] Play App Signing enabled; upload keystore backed up (file + passwords, offline)
[ ] Bundle id / package = in.redlotusfoods.app everywhere

BUILD
[ ] Service worker disabled in capacitor build (no SW registered in WebView)
[ ] App icon + splash correct on a notch device
[ ] Version (semver) + build number (run_number) bumped; monotonic
[ ] google-services.json / GoogleService-Info.plist in place

NATIVE CAPABILITIES
[ ] Push: permission prompt, token saved, send-push delivers, tap deep-links to /orders/:id
[ ] Geolocation native; usage strings; prominent disclosure screen shown before prompt
[ ] Google OAuth via system browser works (both OSes); email/pw + phone OTP work
[ ] Secure token storage; session survives cold relaunch
[ ] Android back button correct; safe areas correct; offline banner
[ ] Universal Links / App Links verified (validators pass)

PAYMENTS (if enabling Razorpay at launch)
[ ] Native Razorpay sheet opens; UPI app-switch + OTP work on real device
[ ] Server creates order + verifies signature; no key secret on client

COMPLIANCE
[ ] In-app account deletion works; public /delete-account URL live
[ ] Apple Privacy labels + Google Data Safety filled, consistent with DPDP policy
[ ] Content rating completed
[ ] Review notes: native-feature list + TEST ACCOUNT + Gudha-Gorji content note/override

OPS
[ ] Sentry receiving events (force a test error)
[ ] Capgo: notifyAppReady() called; a test OTA reaches a device
[ ] Crash-free on the must-test devices through a full order flow
```

---

## 12. Crash reporting, analytics & monitoring

**Recommendation: Sentry (`@sentry/capacitor` + `@sentry/react`).** For a webview-centric app it
captures **both** JS/React errors **and** native crashes in one tool, has a generous free tier,
and integrates with source maps so OTA bundles are debuggable. Firebase Crashlytics is native-only
(misses your JS errors, which is where most of your bugs will be since the app is web code) and
adds Firebase SDK weight.

```ts
// src/lib/monitoring.ts
import * as Sentry from '@sentry/capacitor';
import * as SentryReact from '@sentry/react';
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: APP_VERSION,                 // tie errors to OTA bundle / store version
  tracesSampleRate: 0.1,
  // scrub PII: don't send phone/address in breadcrumbs
}, SentryReact.init);
```

- **Product analytics:** you already run **Vercel Analytics + Speed Insights** — they keep working
  inside the WebView (page views, web vitals). That's enough at launch; add **PostHog** later only
  if you need funnels/retention cohorts.
- **Push deliverability:** log `send-push` outcomes (sent/pruned) like `notify-pending-orders`
  already logs; spot stale-token churn.
- **Upload source maps** for each OTA bundle + store build so Sentry stack traces are readable.
- **Monitor after every OTA**: a Capgo rollout + a Sentry error spike = roll back (§5.3).

---

## 13. Phased rollout plan with timeline

Durations assume **one developer, part-time** (you're also finishing an MCA). Sequenced by
dependency. The two long *waits* — Google's 12-tester/14-day gate and store reviews — run in
parallel with other work where possible.

| Phase | Work | Duration | Depends on | Can parallelise? |
|---|---|---|---|---|
| **0. Accounts & prerequisites** | Apple + Play enrolment, identity verification, create app records, Firebase project, **start recruiting 12 testers** | 3–7 days (mostly waiting) | — | Start everything else once Capacitor inits |
| **1. Capacitor foundation** | `cap init`, add ios/android, **disable SW in cap build**, icon/splash, status bar, safe areas, back button, geolocation→native, build locally on both | 1–2 weeks | 0 (partial) | — |
| **2. Auth hardening for native** | Secure token storage + PKCE, **Google OAuth system-browser flow**, Universal/App Links, **account-deletion flow** | 1–2 weeks | 1 | — |
| **3. Push end-to-end** | `device_tokens` (mig 019), plugin + registration, `send-push` EF → FCM, DB webhook on orders, deep-link tap, permission UX, channels | 1–2 weeks | 1, Firebase | Overlaps 2 |
| **4. Razorpay (net-new)** | `razorpay-create-order` + `razorpay-verify` EFs, native plugin + web branch, dark-launch flag (A4) | 1–2 weeks | 1 | Can defer past launch |
| **5. OTA (Capgo)** | Install, channels, `notifyAppReady`, prove a live update | 2–4 days | 1 | Overlaps 3/4 |
| **6. CI/CD** | Capgo deploy on `main`; tag-triggered Android (Linux) + iOS (macOS/Codemagic) + Fastlane | 3–5 days | 1, 5 | Overlaps later phases |
| **7. Store listings & assets** | Screenshots, feature graphic, descriptions, privacy labels, Data Safety, content rating | 3–5 days | 1 | Overlaps testing |
| **8. Testing** | TestFlight internal/external; **Google closed test ≥12 testers × 14 days**; device matrix; checklist | **2–3 weeks** (14-day gate dominates) | 1–7 | The 14-day clock runs while you polish |
| **9. Submit & launch** | Apple review (~1–3 days typical), Play production after gate, fix any rejections, public release + staged rollout | ~1 week | 8 | — |

**Realistic end-to-end: ~10–14 weeks part-time.** Critical path is **Phase 0 → 1 → (2/3) → 8 →
9**, with Google's 14-day closed test as the immovable long pole. **Pull Phase 0's tester
recruitment forward to week 1** so the 14-day clock can run during phases 6–8.

**Suggested launch order:** Android **internal/closed** first (start the 14-day clock), iOS
**TestFlight** in parallel, then iOS App Store (often faster to approve), then Google production
once the gate clears. Consider **COD-only v1** (defer Phase 4) to reach stores sooner; enable
Razorpay via OTA + config afterward (A4).

---

## 14. Cost breakdown

INR at ~₹84/USD (**⚠ VERIFY** forex + any GST/forex card fees).

### 14.1 One-time

| Item | USD | INR (approx) | Notes |
|---|---|---|---|
| Google Play registration | $25 | ₹2,100 | One-time, forever |
| Apple Developer (first year) | $99 | ₹8,300 | Also recurring (below) |
| Mac (only if you buy one) | — | ₹0–60,000 | **Avoidable** via Codemagic free tier (A1) |
| Design assets (icon/splash/screenshots) | — | ₹0 | DIY from existing brand assets |
| **One-time total (no Mac)** | | **~₹10,400** | |

### 14.2 Recurring

| Item | Cost/yr (USD) | INR/yr (approx) | Notes |
|---|---|---|---|
| Apple Developer Program | $99/yr | ₹8,300/yr | Mandatory to stay published |
| Capgo (OTA) | ~$144/yr ($12/mo) | ~₹12,000/yr | **₹0 if self-hosted**; ⚠ verify tier |
| Sentry | $0 (free tier) | ₹0 | Paid (~$26/mo) only if you exceed quota |
| FCM (push) | $0 | ₹0 | Free |
| Firebase | $0 (Spark) | ₹0 | Push only; no paid features used |
| GitHub Actions macOS minutes | variable | ~₹0–1,000/yr | iOS builds only on tags; or Codemagic free |
| Supabase / Vercel / MSG91 | existing | — | No change (push may *reduce* MSG91 promo spend) |
| Razorpay | per-transaction (~2%) | — | No fixed fee; scales with sales |
| **Recurring total (typical)** | | **~₹20,000–21,000/yr** | ≈ ₹1,700/mo, mostly Apple + Capgo |

> **Budget headline:** to be *live on both stores* you need ~**₹10,400 one-time** + **₹8,300/yr**
> (Apple) minimum. OTA (Capgo) adds ~₹12k/yr unless self-hosted. Everything else (push, crash,
> CI) sits on free tiers at your scale.

---

## 15. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Apple 4.2 "just a website" rejection** | Med | High | Ship the native-capability layer (§6); list features + test account + Gudha-Gorji content override in review notes (§10.1) |
| R2 | **Google 12-tester/14-day gate** delays launch | High (A2) | High (schedule) | Recruit 12 testers in week 1; start the closed test as early as possible; run the clock during other phases (§13) |
| R3 | **Google OAuth blocked in WebView** | High if unhandled | Med | System-browser + deep-link + PKCE flow (§6.3); test on both OSes |
| R4 | **Razorpay UPI/OTP breaks in WebView** | High if web-checkout used on device | High | Native Razorpay SDK on device, web checkout only on PWA (§7.3); test UPI app-switch on real device |
| R5 | **Service worker fights OTA / serves stale bundle** | High if not handled | Med | Disable PWA in cap build (§2.4); `notifyAppReady()` health gate |
| R6 | **localStorage session eviction** (WKWebView) | Med | Med (random logouts) | Secure-storage adapter (§6.1); verify cold-relaunch persistence |
| R7 | **Push not delivered** (iOS background, stale tokens, FCM v1 misconfig) | Med | Med | Upload APNs `.p8` to Firebase; HTTP v1; prune `UNREGISTERED` tokens; test on real devices; SMS still backstops owners |
| R8 | **Missing account-deletion** → rejection | Med | High | Build §10.3 before first submission |
| R9 | **OTA policy overreach** (changing app purpose) | Low | High | Safe-harbour rules (§5.4): OTA only fixes/UI/content, never new native capability or app-purpose change |
| R10 | **Keystore loss** → can't update Android app | Low | Critical | Play App Signing (Google holds signing key) + offline backup of upload key (§3.2/3.3) |
| R11 | **macOS build dependency / CI cost** | Med | Med | Codemagic free tier for iOS; iOS builds on tags only (§8.6) |
| R12 | **Preview-branch secrets gap** (your known Supabase gotcha) | Med | Low | Keep FCM/Razorpay/push secrets on the **production** Supabase project; don't rely on preview branches for push (A5) |
| R13 | **Reviewer sees empty geofenced storefront** | Med | High | Review-build override to `VILLAGE_CENTRE`; document in notes (§10.1) |
| R14 | **Capgo/Appflow pricing or status change** | Low | Med | Capgo is open-source → self-host fallback; abstract update calls behind one module |

---

## 16. Post-launch operations

### 16.1 OTA vs full store submission — decision matrix

| Change you're making | Action |
|---|---|
| JS/TS bug fix, copy, CSS, layout, new JS-only screen, query change, enable a dark-launched JS feature | **OTA (Capgo)** — minutes, no review |
| Bump a Capacitor plugin / core version | **Store build** |
| Add/remove a native plugin or permission | **Store build** |
| Change app icon/splash or native config | **Store build** |
| Anything that changes the app's purpose, content rating, or privacy labels | **Store build + update listings** |

**One-line rule:** *changed only `dist/`? OTA. Touched `ios/` or `android/`? Store.*

### 16.2 Update cadence

- **OTA:** as needed — daily/weekly small fixes are fine; use staged rollout for anything risky.
- **Store builds:** batch native changes; aim for a binary every few weeks-to-months, plus the
  **annual** Play target-API bump and Capacitor upgrades.
- **Apple Developer renewal** (annual) — calendar reminder; lapsing **pulls your apps**.

### 16.3 Maintenance checklist (recurring)

```
WEEKLY
[ ] Sentry: triage new crash/error groups; check OTA rollout didn't spike errors
[ ] Push: spot-check delivery; watch device_tokens prune rate
[ ] Order flow smoke test on one real Android + iPhone

MONTHLY
[ ] Dependency + plugin updates (test on devices before a store build)
[ ] Review store ratings/feedback; reply
[ ] Confirm backups: upload keystore, match repo, FCM/Razorpay secrets documented

ANNUAL / EVENT-DRIVEN
[ ] Apple Developer renewal ($99) — before expiry
[ ] Google Play target API level bump (by Google's deadline)
[ ] Capacitor major upgrade (read migration guide; full regression)
[ ] Re-verify privacy labels / Data Safety after any data-collection change
[ ] Rotate APNs/FCM/Razorpay keys if policy/security requires
```

### 16.4 Runbooks (quick)

- **Bad OTA shipped:** Capgo dashboard → re-point channel to last good bundle (or auto-rollback via
  `notifyAppReady` already fired). Confirm via a test device. Post-mortem in Sentry.
- **Push stopped working:** check FCM service-account token mint (OAuth), APNs `.p8` validity in
  Firebase, and `send-push` logs; verify a fresh device token registers.
- **Store rejection:** read the resolution center note; most wrapped-app rejections are 4.2 (add
  native value / clarify in notes) or metadata/privacy mismatches (fix labels). Resubmit.

---

## Appendix A — Consolidated new-secret/env inventory

| Name | Where stored | Used by |
|---|---|---|
| `VITE_RAZORPAY_KEY_ID` | client env (public) | web/native checkout |
| `RAZORPAY_KEY_SECRET` | `supabase secrets` | `razorpay-create-order` / `razorpay-verify` |
| `FCM_SERVICE_ACCOUNT` (JSON) | `supabase secrets` | `send-push` |
| `CRON_SECRET` | `supabase secrets` (exists) | `send-push` gate (reuse) |
| `VITE_SENTRY_DSN` | client env | Sentry init |
| `CAPGO_TOKEN` | GitHub secret | OTA deploy |
| `ANDROID_KEYSTORE_B64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS` | GitHub secrets | Android signing |
| `MATCH_PASSWORD`, `MATCH_GIT_URL`, `ASC_API_KEY_JSON` | GitHub secrets | iOS signing/upload |
| `PLAY_SERVICE_ACCOUNT_JSON` | GitHub secret | Play upload |
| `google-services.json`, `GoogleService-Info.plist` | committed in native projects (not secret, but app-specific) | FCM |
| APNs Auth Key `.p8` (+ Key ID, Team ID) | uploaded to Firebase | iOS push relay |

## Appendix B — First-week concrete command sequence

```bash
# 1. Install Capacitor + core plugins
npm i @capacitor/core @capacitor/app @capacitor/push-notifications \
      @capacitor/splash-screen @capacitor/status-bar @capacitor/geolocation \
      @capacitor/preferences @capacitor/browser @capacitor/network \
      @capacitor/keyboard @capgo/capacitor-updater
npm i -D @capacitor/cli @capacitor/assets

# 2. Init (appId in.redlotusfoods.app, appName RedLotus, webDir dist)
npx cap init

# 3. Disable PWA in the cap build (edit vite.config.ts per §2.4), then:
npm run build:cap            # tsc -b && vite build --mode capacitor && npx cap sync

# 4. Add native platforms
npm i @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android

# 5. Generate icons + splash (after placing resources/icon.png + resources/splash.png)
npx capacitor-assets generate

# 6. Open in IDEs to build/sign locally
npx cap open android        # Android Studio
npx cap open ios            # Xcode (macOS only — A1)
```

---

### Document maintenance

Keep this in sync with reality as you implement. When a section ships, mark it ✅ and note the PR.
If store policy or a tool (Capgo, Capacitor, FCM) changes, update the **⚠ VERIFY** item and the
relevant section. This doc is the single source of truth for the native-apps workstream; pair it
with the existing `src/docs/*_plan.md` family.
