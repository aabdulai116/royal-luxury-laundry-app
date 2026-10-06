# Royal Luxury Laundry — mobile app handoff

Build and release guide for the Royal Luxury Laundry Android and iOS apps.

## What this is

Your existing site (`www/index.html` — the exact same file from the site handoff, with one
surgical change explained below) wrapped as a real native app using **Capacitor**, so it can
ship to both the Play Store and the App Store without a rewrite. There is no separate "mobile
version" of the app's logic — the booking form, tracker, admin dashboard, Paystack checkout,
referral system, all of it, is the same code, running inside a native shell instead of a
browser tab.

```
rll-app/
├── www/index.html          ← your app, unchanged except the notification swap below
├── www/cap/                ← local Capacitor JS bundles the page loads (no CDN, no build step)
├── android/                ← native Android project (open in Android Studio)
├── ios/                    ← native iOS project (open in Xcode — needs a Mac)
├── supabase/functions/send-push/  ← the push-sending worker (runs on Supabase, not Firebase)
├── firestore.rules         ← updated security rules (diff from your current rules, explained below)
├── firebase.json, .firebaserc
├── SUPABASE_SETUP.md       ← step by step: create the Supabase project, deploy the worker, schedule it
└── capacitor.config.json   ← app id, app name, splash/status bar settings
```

**Why Supabase and not a Firebase Cloud Function:** sending the push still needs *some* small piece of
server-side code to run (a phone can't push a notification to a different phone by itself). Firebase can run
that code too, but only on its paid "Blaze" plan, which asks for a credit card up front even though this
business will likely never be billed. Supabase runs the exact same job on a free tier that needs no card.
Firestore — your orders, customers, and admin dashboard — is completely unaffected either way; the worker
only reads it to find a pending notification and a device token, and deletes its own queue entries.

## The only functional change: email notifications → push notifications

Everything else is identical. Specifically:

- `index.html`'s six `send*Email` functions (`sendBookingEmails`, `sendReadyForDeliveryEmail`,
  `sendStatusUpdateEmail`, `sendOnTheWayEmail`, `sendPaymentSuccessEmail`,
  `sendReferralRewardEmail`) are called from the **exact same places, in the exact same order**
  as before. Not one call site moved.
- The only thing that changed is what happens inside `sendEmailJS()`, the low-level function
  they all funnel through. It used to `fetch()` EmailJS. It now writes a small document into a
  new `pushRequests` Firestore collection instead.
- A small worker (`supabase/functions/send-push/`), running on Supabase rather than Firebase,
  checks that collection once a minute and turns each request into a real push notification —
  delivered by the phone's OS even if the app is closed — using the same template IDs and the
  same data the email templates used, then deletes the request. A push can take up to about a
  minute to arrive rather than being instant, since this checks on a schedule instead of
  reacting the moment something happens — still far faster than email ever was.
- A small new block in `index.html` (clearly commented, right after the Firebase config)
  registers each device for push and attaches its token to the right place: a customer's
  token goes on their own order document (added the moment they book, and refreshed each time
  they open live tracking); staff tokens go into a new `staffTokens` collection so admin's
  "new order" push reaches every phone that has the dashboard open.
- Your EmailJS account, keys, and the six template IDs are left in the file, untouched and
  unused — nothing was deleted, in case you ever want to fall back to email for something.

Everything else — Firestore rules for orders, the referral/points math, the double-payment
protections, Paystack, the admin dashboard, Leaflet maps, jsPDF receipts — is byte-for-byte
what you already had.

## What is built vs. what is left to do

I don't have a Mac, an Apple Developer account, your Firebase console, a Google Play
Console account, or the ability to pay App Store/Play Store fees — so the steps below need
you, in this order.

### 1. Firebase: register the two apps, deploy the rules (free, ~15 minutes, no card)

Your Firebase project (`royal-luxury-laundry`) already exists from the site, and stays on its
free Spark plan — nothing here needs Blaze or a credit card.

1. **Firebase console → Project settings → Add app → Android.**
   Package name: `com.royalluxurylaundry.app` (must match exactly). Download the
   `google-services.json` it gives you and place it at `android/app/google-services.json`.
   (The Android build already looks for this file — nothing else to configure.)
2. **Firebase console → Project settings → Add app → iOS.**
   Bundle ID: `com.royalluxurylaundry.app`. Download `GoogleService-Info.plist` — you'll drag
   this into Xcode in step 3.
3. **Deploy the updated rules.** From inside `rll-app/`, with Node.js installed:
   ```
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules
   ```

### 1b. Supabase: deploy the push-sending worker (free, no card)

See **`SUPABASE_SETUP.md`** for the full walkthrough — create the project, generate a Firebase
service account key, deploy `supabase/functions/send-push`, and schedule it to run every
minute.

### 2. Android build (needs Android Studio, free)

1. Install [Android Studio](https://developer.android.com/studio).
2. `npx cap open android` (from `rll-app/`) opens the project.
3. Let Gradle sync (first time takes a few minutes).
4. Run it on an emulator or your own phone to test the whole flow — book an order, watch the
   push notification actually arrive.
5. When ready to publish: Android Studio → Build → Generate Signed Bundle/APK → follow the
   wizard to create a signing key (**save this key file somewhere safe and back it up** —
   losing it means you can never update the app again under the same listing).
6. Create a [Google Play Console](https://play.google.com/console) account (**one-time $25
   fee**), create a new app listing, and upload the signed `.aab` it produces.
7. Play Console will ask for: app description, screenshots (from the emulator or your phone),
   a privacy policy page (you likely need a short one covering the data this app already
   collects — name, phone, email, address, location pin, payment reference), and content
   rating questionnaire. Review usually takes a few hours to a few days the first time.

### 3. iOS build (needs a Mac + Xcode, free; App Store needs a paid account)

This is the one piece I genuinely cannot do any part of from here — it requires macOS.

1. On a Mac, install Xcode from the App Store.
2. Install [CocoaPods](https://cocoapods.org): `sudo gem install cocoapods`.
3. Copy this whole `rll-app/` folder to the Mac, then from inside it: `npx cap open ios`.
4. In Xcode: drag in the `GoogleService-Info.plist` from step 1 (check "Copy items if needed").
5. In Xcode → target "App" → Signing & Capabilities: add the **Push Notifications**
   capability, and add **Background Modes → Remote notifications**.
6. Join the [Apple Developer Program](https://developer.apple.com/programs/) (**$99/year**) —
   required for push notifications and for App Store submission; there's no free tier that
   allows either.
7. In Apple's developer portal, create an **APNs Authentication Key** and upload it in
   **Firebase console → Project settings → Cloud Messaging → Apple app configuration**. This
   is the step that lets Firebase actually deliver pushes to iPhones.
8. Set your Team in Xcode's signing settings, plug in an iPhone or use a simulator to test.
9. Archive the build (Product → Archive) and upload to **App Store Connect** directly from
   Xcode's Organizer window.
10. In App Store Connect: create the app listing (same package of assets as Play Store —
    screenshots, description, privacy policy, age rating), submit for review. Apple's review
    typically takes 1–3 days and, unlike Android, is a human review — expect at least one
    round of back-and-forth the first time.

### 4. One shared thing both stores will ask for: a privacy policy page

Both stores require a URL to a privacy policy before they'll accept the listing. Since
`royalluxurylaundry.com` already exists, the simplest option is a short new page there
covering: what's collected (name, phone, email, delivery address, an optional location pin,
payment reference from Paystack), why, and that it's shared only with Paystack (to process
payment) and Firebase (to store the order) — happy to draft that page's text and an
`index.html` for it if you want it here.

## Known limitations of this build, worth knowing about

- **Push notifications only work once google-services.json / GoogleService-Info.plist and
  (for iOS) the APNs key are in place.** Until then, the app runs exactly like the website —
  bookings, tracking, admin, payments all work — it just silently skips the push step, the
  same way it used to silently skip email if EmailJS wasn't configured.
- **A customer's push token is only attached once they've opened the app and granted
  notification permission.** If they deny it (or never open the tracker after booking), that
  particular order simply gets no push — same practical gap as an email going to a wrong or
  unchecked inbox before.
- The in-page `Notification` API code you already had (the "Enable Notifications" button on
  the tracking page, for while it's open in a browser tab) was left completely alone. It's
  redundant now inside the native app — the OS-level push covers that case too — but it does
  no harm left in place, and it still matters if you keep the website itself running
  alongside the app.
