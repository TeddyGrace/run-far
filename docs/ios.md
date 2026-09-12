# run-far on iOS (and Apple Health)

This is the runbook for shipping run-far as an iPhone app and using Apple Health as an
alternative to Whoop. It assumes you have not bought an Apple Developer account yet, and says
what that money actually buys you at each step.

## Why an iOS app is required, not just nice to have

Every other integration in run-far is server-to-server: the API holds an OAuth token and pulls
from Whoop or Google. **Apple Health has no cloud API at all.** HealthKit is an on-device
database, readable only by an app running on that device, after the person grants per-data-type
permission in Apple's own sheet. There is no endpoint, no token, and no way for the server to
ask.

So the app is not a nicer wrapper around the website. It is the only mechanism by which Apple
Health data can reach run-far, and it inverts the direction of the integration: the app reads
HealthKit and pushes to `POST /api/apple-health/ingest`.

The second thing the app buys you is **background delivery**. HealthKit can wake the app when
new data lands — the watch syncs shortly after you wake up, iOS wakes run-far, and the recovery
score is on the dashboard before you open anything. Without it, Apple Health data would only
arrive when you happened to open the app, and the morning's recommendation would be computed
from yesterday. That wake runs native code with no WebView, which is why the device holds its
own bearer token (below).

## What the $99/year actually gets you

| You want | Needs the paid account? |
| --- | --- |
| Run a plain app on your own iPhone from Xcode | No — a free Apple ID works, but the build expires after 7 days |
| **HealthKit entitlement** | **Probably — verify first, see below** |
| TestFlight (share with other people) | Yes |
| App Store release | Yes |
| Push notifications | Yes |

### Verify the HealthKit/free-account question before planning around it

Apple's free "Personal Team" provisioning supports only a subset of capabilities, and the
restricted list has changed across Xcode versions. HealthKit is widely reported to be
unavailable to free accounts, but this is worth **checking rather than trusting** — including
over this document, which is not authoritative on it.

The check takes two minutes and costs nothing, and it is worth doing as step zero because the
answer decides whether you can validate before paying:

1. Do steps 3 and 4 below (generate the Xcode project, open it).
2. In the app target → Signing & Capabilities, select your **personal team** (your plain Apple
   ID) under Team.
3. Click **+ Capability** and add **HealthKit**.

If Xcode accepts it, you can validate on your own phone for free. If it refuses — the usual
wording is along the lines of the capability being unsupported for your team, or a provisioning
profile failing to generate — then HealthKit needs the paid account, and there is no way around
that. Buy it and carry on from step 1.

Either way the rest of the app builds and runs on your phone for free; it is only the HealthKit
read that is in question.

## Architecture

```
iPhone
├── WKWebView ─ the existing React app (apps/web), unchanged
│     └── session cookie auth, same as the browser
└── native (packages/health-bridge, Swift)
      ├── HealthKit reads: sleep sessions + nightly vitals, workouts
      ├── HKObserverQuery + background delivery → wakes on new data
      └── POST /api/apple-health/ingest with a Keychain bearer token
```

**Capacitor, not a native rewrite.** The dashboard, calendar, plan builder and assistant are a
substantial React app. A parallel SwiftUI copy would mean every change shipping twice. The
native shell adds only what the web genuinely cannot do.

**Two credentials, on purpose.** Inside the WebView, the ordinary signed session cookie works
unchanged. Native code cannot read the WebView's cookie jar, so on the native side a device
holds a long-lived bearer token in the Keychain, issued by `POST /api/apple-health/devices`
(which is itself cookie-authenticated, from the WebView, while you are signed in). The token is
revocable per-device from Settings, stored server-side only as a SHA-256 hash, and — because it
has no expiry — it is resolved by the global `activeUserGuard`, so a disabled or lapsed account's
phone stops syncing like everything else.

## Setup, in order

### 1. Buy the developer account

<https://developer.apple.com/programs/enroll/>. As an individual it is $99/year and approval is
usually same-day. You need it before the HealthKit capability will attach to your app ID.

### 2. Register the app ID and enable HealthKit

In the developer portal → Certificates, Identifiers & Profiles → Identifiers → new App ID:

- Bundle ID: `app.runfar.ios` (matches `appId` in `apps/web/capacitor.config.ts` — change both
  together if you want a different one)
- Capabilities: **HealthKit**

### 3. Generate the Xcode project

On a Mac, with Xcode and CocoaPods installed:

```bash
pnpm install
export RUNFAR_IOS_ORIGIN=https://your-deployed-origin   # e.g. your Railway URL
pnpm --filter @run-far/web build
pnpm --filter @run-far/web exec cap add ios
pnpm --filter @run-far/web exec cap sync ios
pnpm --filter @run-far/web exec cap open ios
```

`RUNFAR_IOS_ORIGIN` is required and has no default — the config throws without it. Every command
above that reads the Capacitor config needs it in the environment, which is why it is `export`ed
rather than prefixed onto one line.

**What that origin does:** the WebView loads the deployed app from it (`server.url`). The app's
origin *is* your backend's origin, so `/api/...` is same-origin exactly as in Safari and the
existing session cookie works with no CORS entry and no SameSite change. The trade is that the
app needs a network connection to start and has no offline shell.

Use an **https** origin. Pointing this at a plain-http dev server on a LAN address also needs an
App Transport Security exception in Info.plist — a foot-gun to leave in a project you will later
submit.

`cap add ios` generates `apps/web/ios/`, which is a real Xcode project you will hand-edit (for
capabilities and Info.plist). Commit it.

### 4. Xcode: capabilities

In the app target → Signing & Capabilities, add:

- **HealthKit**, and tick **Background Delivery** under it. Without that tick,
  `enableBackgroundDelivery` silently does nothing and syncing only happens when the app is
  open — the single most important setting here, and the one whose absence looks like a bug
  rather than a misconfiguration.

### 5. Xcode: Info.plist purpose strings

Both are required. An app that touches HealthKit without them is rejected at submission, and
`NSHealthShareUsageDescription` is the text shown in the permission sheet, so it should say what
run-far does with the data rather than repeating the app's name:

```xml
<key>NSHealthShareUsageDescription</key>
<string>run-far reads your sleep, heart-rate variability, resting heart rate and workouts to
compute a daily recovery score and adjust your training plan when your recovery doesn't match
what the plan expects.</string>

<key>NSHealthUpdateUsageDescription</key>
<string>run-far does not write any data to Apple Health.</string>
```

run-far requests read access only — `requestAuthorization(toShare: [], read:)` — so the update
string is there because Apple requires it if the entitlement is present, and it says so plainly.

### 6. Build to your iPhone

In Xcode: plug the phone in, select it in the device dropdown (top bar), press ▶.

- **Trust the certificate.** The first run of a build signed with a personal team fails to launch
  with an untrusted-developer error. On the phone: Settings → General → VPN & Device Management →
  tap your developer profile → Trust. Then press ▶ again.
- **A real device, not the simulator.** HealthKit does not exist in the simulator; the plugin
  reports it unavailable, which is correct behaviour rather than a bug.
- **A free-team build expires after 7 days** and must be re-run from Xcode. A paid one lasts a
  year.

### 7. Connect it

Sign in → Settings → **Recovery data source** → Connect Apple Health → grant the permissions →
the first sync backfills 90 days.

**Signing in: use email and password, not Google.** Google blocks its OAuth flow inside embedded
web views, so "Continue with Google" will likely be refused in the app. If your account is
Google-only, set a password first from the website (Settings → the email sign-in card), then use
email + password in the app. This is a genuine limitation of the WebView approach, and the reason
native apps use a system browser for OAuth — worth fixing before anyone else uses the app.

Then switch **Recovery data source** to Apple Health. These are two separate steps on purpose:
data from an athlete still on Whoop is stored rather than refused, so you arrive at Apple Health
with history already there instead of an empty dashboard and a month's wait for a baseline. The
Settings card tells you when data is syncing but not yet being read.

## Building without a local Mac: GitHub Actions

`.github/workflows/ios.yml` builds the app on a GitHub-hosted Mac, so Xcode never needs to be
installed locally. The generated Xcode project (`apps/web/ios/`) is committed with HealthKit,
Background Delivery and the Info.plist purpose strings already set (steps 4 and 5 above are done).

**Unsigned compile, on every push touching the app.** No Apple account, no secrets. This is the
loop for fixing Swift compile errors.

**TestFlight upload, on demand.** Actions → iOS → Run workflow → tick *testflight*. Requires the
paid account (a free Personal Team cannot issue API keys or distribution certificates), plus,
once:

1. Developer portal → Identifiers → register App ID `app.runfar.ios` with **HealthKit** enabled.
2. App Store Connect → Apps → **+** → New App, bundle ID `app.runfar.ios`. The API cannot create
   the app record; this step is manual.
3. App Store Connect → Users and Access → Integrations → App Store Connect API → generate a
   **Team key with the Admin role**. Admin is what lets CI create the cloud-managed distribution
   certificate and provisioning profile. Download the `.p8` (only downloadable once).
4. Add repository secrets (Settings → Secrets and variables → Actions):
   - `APP_STORE_CONNECT_KEY_ID` — the key's ID
   - `APP_STORE_CONNECT_ISSUER_ID` — shown above the keys table
   - `APP_STORE_CONNECT_KEY_P8` — the full contents of the `.p8` file
   - `APPLE_TEAM_ID` — Membership details in the developer portal

The build number is the workflow run number, so every upload is accepted. Once processing
finishes (usually 10–30 minutes), install the TestFlight app on the phone, signed in with the same
Apple ID, and the build appears under internal testing with no App Review.

## What to expect from the data

**No recovery score for the first two weeks.** Apple publishes no recovery score, so run-far
derives one from how far your HRV, resting HR, sleep and respiratory rate sit from *your own*
baseline (`apps/api/src/integrations/appleHealth/recoveryScore.ts`). Below 14 days of baseline it
returns nothing, deliberately: a score built on a 3-day standard deviation swings on ordinary
variation, which for a new athlete means a red-recovery card telling them to abandon a real
session, generated out of noise. The rules read a null score as "no opinion" and stay quiet. The
Settings card counts down the remaining nights.

**No strain.** Whoop's 0-21 strain has no Apple equivalent and is not invented. Load — and
therefore ACWR — runs on active energy in kilojoules instead, which is a real additive measure
and works identically for both providers.

**HRV is SDNN, not RMSSD.** Apple Watch records SDNN; Whoop reports RMSSD. Different
computations, different scales. This is why only one provider is ever read at a time: a baseline
mixing the two has a mean and a standard deviation that describe neither. Switching provider is
not destructive — the other provider's rows stay, unread, and reading resumes if you switch back.

**Sleep needs the watch worn overnight.** No watch means no HRV, no resting HR and no sleep
stages, so a night without it is recorded as unscorable rather than as a night of bad recovery.

**iPhone-only.** HealthKit does not exist on iPad, and the plugin reports that rather than
offering a button that cannot work.

## App Review notes

- **Guideline 4.2 (minimum functionality).** A WebView wrapper around a website gets rejected.
  What clears it here is real device functionality: HealthKit integration and background health
  delivery. Say so in the review notes, and mention that the app reads Apple Health, which the
  website cannot.
- **Health data handling.** A privacy policy URL is required. HealthKit data must not be used
  for advertising or sold, and must not be shared with third parties without consent. run-far
  sends it to run-far's own API only.
- **Demo account.** Give the reviewer credentials with an active comp entitlement, and say that
  a device with no Apple Health history will show "collecting baseline" rather than a recovery
  score — otherwise it looks broken to someone testing on a fresh device.
- **Sign in with Apple.** Required if you offer other third-party sign-in. run-far offers Google
  sign-in, so **this is likely to be required** before release. It is not implemented yet.
- **Subscriptions.** Not wired into the app deliberately (see below).

## Known rough edges of the WebView approach

**Remote-loaded, not bundled.** `server.url` points the WebView at the deployed site, which is
what makes the session cookie work with no backend changes. Before an App Store release, consider
switching to a bundled build: it starts offline, loads faster, and reads less like a wrapped
website to a reviewer. The cost is real, though — the web app would need an absolute API base URL
instead of relative `/api`, the API would need the capacitor origin in its CORS allowlist, and the
session cookie would need `SameSite=None; Secure`, which is a meaningfully weaker cookie posture
than the current `lax`.

**Google sign-in doesn't work in the WebView** (see step 7). The fix is a native OAuth flow via
`ASWebAuthenticationSession`, which is also roughly the machinery Sign in with Apple needs — so
these two are worth doing together.

## Deliberately not done yet

**StoreKit / in-app purchase.** If the iOS app exposed run-far's subscription, Apple would
require in-app purchase (15–30%), and you could not point people at Stripe Checkout from inside
the app. The v1 iOS build therefore has no purchase path at all: existing entitlements (comp, or
a Stripe subscription bought on the web) are honoured, and there is nothing to buy in-app. The
schema already reserves `entitlement_source = 'apple'` for when this is implemented; what is
missing is StoreKit 2 on the client and App Store Server Notifications v2 on the server.

**Sign in with Apple.** See above — likely blocking for App Store release given Google sign-in
is offered.

**Push notifications.** The recovery digest is email-only. Push would be the natural iOS
follow-on and needs no new backend concepts, just APNs credentials and a device-token table
(the `health_ingest_devices` table is a reasonable model, but keep them separate: a push token
and a data-push credential have different lifetimes and different revocation rules).

## Troubleshooting

**"Nothing came back" after granting permission.** iOS never reports read-permission status —
deliberately, so an app cannot detect that you declined to share a condition. A sync that reads
zero of everything is the only signal, which is why the Settings card says this rather than
claiming success. Re-grant in iOS Settings → Health → Data Access & Devices → run-far.

**Background sync stopped after a while.** Observer queries do not survive process death, and
iOS terminates apps freely; the plugin re-arms them in `load()` on every launch. If it is still
not firing, confirm Background Delivery is ticked in Signing & Capabilities, and note that iOS
coalesces and rate-limits `.immediate` delivery at its own discretion.

**Sync returns 401.** The device registration was revoked (Settings, or another device evicted
it past the 8-device cap). The plugin discards its token and stops background delivery rather
than waking forever to be refused — reconnect from Settings.

**Sync returns 402.** The account's subscription is inactive. Background delivery stops until
it is active again.
