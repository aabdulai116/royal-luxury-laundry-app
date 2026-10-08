/* ---------------- Config ---------------- */
const ADMIN_PASSCODE = "CHANGE_ME"; // real passcode removed from the public repo
const STATUSES = ["Requested","Accepted","Picked Up","Washing","Ready for Delivery","Delivered"];
const STATUS_CLASS = { "Requested":"st-Requested","Accepted":"st-Accepted","Picked Up":"st-PickedUp","Washing":"st-Washing","Ready for Delivery":"st-Ready","Delivered":"st-Delivered" };

/* ---------------- Email notifications (EmailJS) ----------------
   This site has no backend, so emails are sent client-side via EmailJS
   (https://www.emailjs.com — free tier available). To activate:
   1. Create an EmailJS account and connect an email service (Gmail, Outlook, etc).
   2. Create these email templates and note their Template IDs:
      - "Customer Booking Confirmation" — use variables: {{order_id}}, {{customer_name}},
        {{service}}, {{pickup_date}}, {{pickup_time}}, {{address}}, {{notes}}, {{to_email}}
      - "Admin New Order Alert" — same variables, sent to {{to_email}} = admin address
      - "Ready for Delivery" — use: {{order_id}}, {{customer_name}}, {{service}},
        {{final_price}}, {{estimated_delivery}}, {{address}}, {{tracking_url}}, {{to_email}}
      - "Order Status Update" — use: {{order_id}}, {{customer_name}}, {{new_status}},
        {{tracking_url}}, {{to_email}}
      - "Payment Confirmation" — use: {{order_id}}, {{customer_name}}, {{amount_paid}},
        {{payment_reference}}, {{to_email}}
      - "On The Way" — use: {{order_id}}, {{customer_name}}, {{direction}} (either
        "collect your laundry" or "deliver your laundry"), {{staff_name}}, {{tracking_url}}, {{to_email}}
   3. Paste your Public Key, Service ID, and the six Template IDs below.
   Until these are filled in, emails are safely skipped (logged to console only) —
   the site itself keeps working normally. */
const EMAILJS_PUBLIC_KEY = "_L468zVRXa46b_9Yi";
const EMAILJS_SERVICE_ID = "service_5cg0avi";
const EMAILJS_TEMPLATE_CUSTOMER_BOOKING = "template_h23u2z9";
const EMAILJS_TEMPLATE_ADMIN_BOOKING = "template_r8o5uak";
const EMAILJS_TEMPLATE_READY = "template_69qcat3";
const EMAILJS_TEMPLATE_STATUS_UPDATE = "template_9nfhyvs";
const EMAILJS_TEMPLATE_PAYMENT_SUCCESS = "template_rjsyggu";
const EMAILJS_TEMPLATE_ON_THE_WAY = "template_b0pr66t";
/* Create this template in EmailJS and paste its ID here to email people when
   a referral of theirs pays out. Left empty, the reward still lands in their
   balance and they simply see it next time they open their tracking page.
   Template variables: to_email, customer_name, points_earned, points_balance,
   friend_name, tracking_url */
const EMAILJS_TEMPLATE_REFERRAL_REWARD = "";
const ADMIN_EMAIL = "royallaundry273@gmail.com";

/* ---------------- Payments (Paystack) ----------------
   Test mode: uses a test public key so you can try the full payment flow with
   fake cards/mobile money before your business is registered. To activate:
   1. Sign in to your Paystack dashboard → Settings → API Keys & Webhooks.
   2. Copy the "Test Public Key" (starts with pk_test_) and paste it below.
   3. Test card: 4084 0840 8408 4081, any future expiry, CVV 408, PIN 0000, OTP 123456.
      Test mobile money: choose "Mobile Money" in the popup, pick MTN/Telecel/AirtelTigo,
      enter any Ghanaian-format number — Paystack's test environment auto-approves it.
   Card and Mobile Money are both offered in the same checkout popup — customers
   choose whichever they prefer. When your business cert is approved, just swap in
   the "Live Public Key" (starts with pk_live_) — no other code changes needed. */
const PAYSTACK_PUBLIC_KEY = "pk_live_2959f9b78d235dd2e93d762d697869d32bc612b4";

function paystackConfigured(){
  return !PAYSTACK_PUBLIC_KEY.startsWith("YOUR_") && typeof PaystackPop !== "undefined";
}

async function pinTrackingLocation(orderId){
  if(!("geolocation" in navigator)){
    showToast("Location isn't supported on this device.");
    return;
  }
  const btn = document.getElementById("track-pin-btn");
  if(btn){ btn.disabled = true; btn.textContent = "Pinning..."; }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try{
        await updateOrderFields(orderId, {
          customerLocation: { lat: pos.coords.latitude, lng: pos.coords.longitude }
        });
        showToast("Location pinned — thank you!");
      }catch(err){
        console.error("Pin location save error:", err);
        showToast("Could not save your location: " + (err && err.message ? err.message : "please try again"));
      }
      if(btn){ btn.disabled = false; }
    },
    (err) => {
      console.error("Geolocation error:", err);
      showToast("Could not get your location: " + (err.message || "permission denied"));
      if(btn){ btn.disabled = false; btn.textContent = "📍 Pin My Location"; }
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

/* Puts the Pay button into a locked, non-interactive state. Used both while
   a payment is in flight (so a double-tap can't open Paystack twice) and,
   permanently for this page load, after money has actually changed hands —
   at that point re-enabling the button is never safe, even if something
   afterwards goes wrong, because Paystack has already taken the payment. */
function setPayButtonState(label, opts){
  const btn = document.getElementById("pay-now-btn");
  if(!btn) return;
  btn.textContent = label;
  btn.disabled = !!(opts && opts.disabled);
}

async function payNow(orderId){
  if(!paystackConfigured()){
    showToast("Online payment isn't set up yet — please pay on delivery.");
    return;
  }

  // Same-tab guard: a click already in flight for this order is not a
  // second attempt, it's the same attempt landing twice. This has to be
  // claimed synchronously, before any "await" below — a double-tap fires
  // both calls back to back in the same tick, and if the lock were set any
  // later, the second call would sail past this check before the first one
  // ever got around to setting it.
  if(PAYMENT_LOCKS.has(orderId)){
    showToast("Your payment is already opening — please wait.");
    return;
  }
  PAYMENT_LOCKS.add(orderId);
  setPayButtonState("Opening payment...", { disabled: true });

  // Stale-page guard: re-fetch the order fresh rather than trusting whatever
  // this tab last rendered, so a payment made a moment ago (even from a
  // different tab or device) is caught before a second charge is attempted.
  const order = await getOrder(orderId);
  if(!order || !order.finalPrice){
    PAYMENT_LOCKS.delete(orderId);
    setPayButtonState("Pay Now", { disabled: false });
    showToast("Could not find a final price for this order yet.");
    return;
  }
  if(order.paid){
    PAYMENT_LOCKS.delete(orderId);
    showToast("This order is already marked as paid — nothing further to pay.");
    renderTrackedOrder(order); // replaces the button block entirely, since order.paid is now true
    return;
  }

  try{
    const paystack = new PaystackPop();
    paystack.newTransaction({
      key: PAYSTACK_PUBLIC_KEY,
      email: order.email,
      amount: Math.round(Number(order.finalPrice) * 100), // GHS pesewas
      currency: "GHS",
      channels: ["mobile_money", "card"],
      ref: `${order.id}-${Date.now()}`,
      metadata: {
        custom_fields: [
          { display_name: "Order ID", variable_name: "order_id", value: order.id },
          { display_name: "Customer", variable_name: "customer_name", value: order.name }
        ]
      },
      onSuccess: async (transaction) => {
        // From this point on Paystack has taken the customer's money.
        // The button must never become clickable again in this session,
        // no matter what happens next — only the outcome message changes.
        setPayButtonState("Confirming payment...", { disabled: true });
        order.paid = true;
        order.paymentMethod = "online";
        order.paymentReference = transaction.reference;
        try{
          // Write only the payment fields — see updateOrderFields for why.
          await updateOrderFields(order.id, {
            paid: true,
            paymentMethod: "online",
            paymentReference: transaction.reference
          });
          showToast("Payment received — thank you!");
          renderTrackedOrder(order); // the button disappears once order.paid is true
        }catch(err){
          console.error("Saving payment status failed:", err);
          // The write can fail two different ways, and the customer needs to
          // hear about them differently. If someone else's payment (another
          // tab, another device, or the admin) landed first, the order is
          // already paid under a different reference — that's a real double
          // payment and they need to be told exactly that, with both
          // references in hand so it can be refunded. Anything else is an
          // ordinary connection failure and the original payment still needs
          // to be recorded manually.
          let duplicate = false;
          try{
            const check = await getOrder(order.id);
            duplicate = !!(check && check.paid && check.paymentReference && check.paymentReference !== transaction.reference);
          }catch(_){ /* couldn't confirm either way — fall through to the generic message */ }

          if(duplicate){
            setPayButtonState("Already paid — contact us", { disabled: true });
            showToast("It looks like this order was already paid separately. You may have been charged twice — please contact us with order " + order.id + " and payment reference " + transaction.reference + " so we can check and refund any duplicate.");
          }else{
            setPayButtonState("Payment received — contact us to confirm", { disabled: true });
            showToast("Payment succeeded but saving it failed: " + (err && err.message ? err.message : "unknown error") + " — please contact us with order " + order.id + " and payment reference " + transaction.reference + ".");
          }
        }
        // Send the confirmation regardless — the payment itself succeeded on
        // Paystack's end even if saving to the database above failed.
        sendPaymentSuccessEmail(order);
      },
      onCancel: () => {
        // No money moved, so it's safe to let them try again.
        PAYMENT_LOCKS.delete(orderId);
        setPayButtonState(`Pay GH₵${order.finalPrice} — Card or Mobile Money`, { disabled: false });
        showToast("Payment cancelled.");
      }
    });
  }catch(err){
    console.error("Paystack error:", err);
    PAYMENT_LOCKS.delete(orderId);
    setPayButtonState(`Pay GH₵${order.finalPrice} — Card or Mobile Money`, { disabled: false });
    showToast("Could not start payment. Please try again or pay on delivery.");
  }
}

/* ---------------- Order storage (Firebase Firestore, with local fallback) ----------------
   This site is a static file with no server, so orders need a real hosted database to be
   visible to both customers and admin from any device. To activate:
   1. Go to https://console.firebase.google.com → Create a project (free).
   2. In the project, open "Firestore Database" → Create database → start in test mode.
   3. Go to Project Settings → General → "Your apps" → add a Web app → copy the config object.
   4. Paste the six values into FIREBASE_CONFIG below.
   Until this is filled in, orders are saved to this browser's local storage only — meaning
   the admin dashboard will only see orders placed from the same browser/device. This is fine
   for testing, but you'll want Firebase connected before relying on this for real customers. */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCX2oDU2c1Z7VYfpXUSaWtj1fLq79ugpJM",
  authDomain: "royal-luxury-laundry.firebaseapp.com",
  projectId: "royal-luxury-laundry",
  storageBucket: "royal-luxury-laundry.firebasestorage.app",
  messagingSenderId: "672666829540",
  appId: "1:672666829540:web:14c9f2bda62560b40822f1"
};

let DB = null;
let AUTH = null;
function firebaseConfigured(){ return !FIREBASE_CONFIG.apiKey.startsWith("YOUR_"); }
if(firebaseConfigured() && typeof firebase !== "undefined"){
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    DB = firebase.firestore();
    AUTH = firebase.auth();
  }catch(err){ console.error("Firebase init failed:", err); }
}

/* ---------------- Push notifications (added for the mobile app build) ----------------
   Nothing above this block was changed. This only adds device push-token
   registration on top of the existing code. The six send*Email functions
   further down (sendBookingEmails, sendReadyForDeliveryEmail, etc.) are still
   called from the exact same places they always were — only what
   sendEmailJS() does under the hood changed, see its own comment below. */
const CAP = (typeof Capacitor !== "undefined") ? Capacitor : null;
const PUSH = (CAP && CAP.Plugins) ? CAP.Plugins.PushNotifications : null;
const FILES = (CAP && CAP.Plugins) ? CAP.Plugins.Filesystem : null;
const SHARE = (CAP && CAP.Plugins) ? CAP.Plugins.Share : null;
let DEVICE_PUSH_TOKEN = null;

function pushAvailable(){
  return !!(PUSH && CAP && CAP.isNativePlatform && CAP.isNativePlatform());
}

async function ensurePushRegistered(){
  if(!pushAvailable()) return null;
  if(DEVICE_PUSH_TOKEN) return DEVICE_PUSH_TOKEN;
  try{
    const perm = await PUSH.checkPermissions();
    let status = perm.receive;
    if(status !== "granted"){
      const req = await PUSH.requestPermissions();
      status = req.receive;
    }
    if(status !== "granted") return null;

    // Android only: a quiet channel for the live ETA notification, so the
    // "about 9 min away" update can refresh every minute without buzzing
    // each time. (iOS has no channels; the call just fails and is ignored.)
    if(typeof PUSH.createChannel === "function"){
      try{
        await PUSH.createChannel({
          id: "delivery_eta",
          name: "Delivery ETA",
          description: "Live arrival updates while your laundry is on the way",
          importance: 2,
          visibility: 1,
          vibration: false
        });
      }catch(err){ /* not supported on this platform */ }
    }

    return await new Promise((resolve) => {
      let settled = false;
      PUSH.addListener("registration", (token) => {
        if(settled) return;
        settled = true;
        DEVICE_PUSH_TOKEN = token.value;
        resolve(DEVICE_PUSH_TOKEN);
      });
      PUSH.addListener("registrationError", (err) => {
        if(settled) return;
        settled = true;
        console.error("Push registration error:", err);
        resolve(null);
      });
      PUSH.register();
    });
  }catch(err){
    console.error("Push setup failed:", err);
    return null;
  }
}

/* Called right after a booking is created, and again each time the customer
   opens live tracking for an order — attaches this device's push token to
   that order so the Cloud Function can reach this phone for status/payment/
   on-the-way pushes, the same moments the email templates used to fire on. */
async function registerPushForOrder(orderId){
  if(!DB) return;
  try{
    const token = await ensurePushRegistered();
    if(!token) return;
    await DB.collection("orders").doc(orderId).update({ pushToken: token });
  }catch(err){ console.error("Save push token to order failed:", err); }
}

/* Called once the admin dashboard is open — lets the new-order-alert push
   (the old admin EmailJS template) reach every staff device that's logged in. */
async function registerPushForStaff(){
  if(!DB) return;
  try{
    const token = await ensurePushRegistered();
    if(!token) return;
    await DB.collection("staffTokens").doc(token).set({
      token,
      updatedAt: Date.now(),
      staffName: (AUTH && AUTH.currentUser && AUTH.currentUser.displayName) || "staff"
    });
  }catch(err){ console.error("Save staff push token failed:", err); }
}

/* Tapping a push notification — whether the app was closed, in the
   background, or already open — should take the customer straight to that
   order, the same way clicking the tracking link in the old emails did.
   For a "ready for delivery" notification specifically, that also means
   jumping straight into the payment flow, since paying is the one action
   that notification is asking for. This only reacts to the order_id/
   template the worker already attaches to the notification; nothing above
   it changes. */
function handlePushTap(orderId, template){
  if(!orderId) return;
  const trackInput = document.getElementById("track-input");
  if(trackInput){ trackInput.value = orderId; }
  if(typeof handleTrackSearch === "function"){ handleTrackSearch(); }
  scrollToId("track");
  if(template === EMAILJS_TEMPLATE_READY){
    // Give the tracking page a moment to render the order (and its Pay Now
    // button) before triggering Paystack, since payNow() looks for that
    // button on the page to update its label/disabled state.
    setTimeout(() => payNow(orderId), 300);
  }
}

if(PUSH){
  PUSH.addListener("pushNotificationActionPerformed", (action) => {
    try{
      const data = (action && action.notification && action.notification.data) || {};
      handlePushTap(data.order_id, data.template);
    }catch(err){ console.error("Push tap handling failed:", err); }
  });
}

async function saveOrder(order){
  if(DB){
    await DB.collection("orders").doc(order.id).set(order);
  }else{
    localStorage.setItem("rl_order_" + order.id, JSON.stringify(order));
  }
}

/* Update ONLY the named fields on an order, rather than rewriting the whole
   document. This matters for customer-side writes (payment, location pin):
   the Firestore rules only permit unauthenticated users to change a short
   whitelist of fields, and a full-document save would also carry along any
   field the driver changed moments earlier (like driverLocation), causing
   the entire write to be rejected. */
async function updateOrderFields(orderId, fields){
  if(DB){
    await DB.collection("orders").doc(orderId).update(fields);
  }else{
    const raw = localStorage.getItem("rl_order_" + orderId);
    const order = raw ? JSON.parse(raw) : {};
    Object.assign(order, fields);
    localStorage.setItem("rl_order_" + orderId, JSON.stringify(order));
  }
}
async function getOrder(id){
  if(DB){
    const doc = await DB.collection("orders").doc(id).get();
    return doc.exists ? doc.data() : null;
  }else{
    const raw = localStorage.getItem("rl_order_" + id);
    return raw ? JSON.parse(raw) : null;
  }
}
async function listOrders(){
  if(DB){
    const snap = await DB.collection("orders").orderBy("createdAt", "desc").get();
    return snap.docs.map(d => d.data());
  }else{
    const orders = [];
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith("rl_order_")){
        try{ orders.push(JSON.parse(localStorage.getItem(k))); }catch(_){}
      }
    }
    orders.sort((a,b)=> b.createdAt - a.createdAt);
    return orders;
  }
}
async function deleteOrder(id){
  if(DB){
    await DB.collection("orders").doc(id).delete();
  }else{
    localStorage.removeItem("rl_order_" + id);
  }
}

/* ---------------- Royal Rank Rewards ----------------
   A lightweight customer-stats record keyed by email, tracking how many
   orders a customer has completed and how much they've spent — used to
   compute their rank. Kept separate from the orders collection so looking
   up a rank (a public "get" by email) never exposes order details like
   address or phone, unlike listing full orders would. Stats update only
   when an order is marked Delivered, and only the signed-in admin can write
   them (customers can only read their own via a direct doc lookup). */
/* ---------------- Referral programme config ----------------
   Change these four numbers to retune the programme; nothing else
   in the file hard-codes them.

   REFERRAL_PERCENT   what share of the referred friend's first paid order
                      is credited back to the person who referred them
   POINT_VALUE_GHS    what one point is worth when spent (1 = 1 point is GH1)
   WELCOME_POINTS     points given to the NEW customer once their first
                      order is delivered, usable from their second order on
   REFERRAL_MIN_ORDER the referred order must reach this final price before
                      any reward is paid, so tiny orders can't farm points */
const REFERRAL_PERCENT = 10;
const POINT_VALUE_GHS = 1;
const WELCOME_POINTS = 10;
const REFERRAL_MIN_ORDER = 40;

/* Points can't be spent a few at a time. A customer must have banked at
   least this many before any of them come off a bill, and when they do
   redeem, they redeem at least this much in one go. The order itself must
   also be worth at least this much, otherwise the customer would burn 100
   points to save less than 100 cedis. */
const POINTS_REDEEM_MINIMUM = 100;

const RANK_TIERS = [
  { name: "Squire", min: 0, crest: "#8a8270", perk: "Welcome to the court — complete your first orders to begin your ascent." },
  { name: "Knight", min: 2, crest: "#8bb4d9", perk: "Priority handling on every order from here on." },
  { name: "Duke", min: 5, crest: "#c58bd9", perk: "One free Express Same-Day upgrade, once a month." },
  { name: "Royal", min: 10, crest: "#f0cf6d", perk: "Priority scheduling, plus a complimentary item cleaned free every 10th order." }
];

function getRankForCount(count){
  let current = RANK_TIERS[0];
  for(const tier of RANK_TIERS){
    if(count >= tier.min) current = tier;
  }
  const idx = RANK_TIERS.indexOf(current);
  const next = RANK_TIERS[idx + 1] || null;
  return { tier: current, next };
}

function customerDocId(email){
  return (email || "").trim().toLowerCase();
}

async function getCustomerStats(email){
  const id = customerDocId(email);
  const empty = { completedOrders: 0, totalSpent: 0, points: 0, referralCount: 0 };
  if(!id) return empty;
  if(DB){
    try{
      const doc = await DB.collection("customers").doc(id).get();
      return doc.exists ? Object.assign({}, empty, doc.data()) : empty;
    }catch(err){
      console.error("Get customer stats error:", err);
      return empty;
    }
  }else{
    // Local demo mode: order counts are derived from whatever orders exist in
    // this browser, but points have no order to derive them from, so they live
    // in their own localStorage record.
    const orders = await listOrders();
    const matches = orders.filter(o => customerDocId(o.email) === id && o.status === "Delivered");
    const demo = getDemoRewards(id);
    return {
      completedOrders: matches.length,
      totalSpent: matches.reduce((sum,o)=> sum + Number(o.finalPrice || 0), 0),
      points: demo.points,
      referralCount: demo.referralCount
    };
  }
}

/* Points ledger for local demo mode (no Firebase). Mirrors the shape of the
   fields the customers collection holds in production. */
function getDemoRewards(id){
  try{
    const raw = localStorage.getItem("rl_rewards_" + id);
    const parsed = raw ? JSON.parse(raw) : {};
    return { points: Number(parsed.points || 0), referralCount: Number(parsed.referralCount || 0) };
  }catch(_){ return { points: 0, referralCount: 0 }; }
}

function addDemoRewards(id, pointsDelta, referralDelta){
  const current = getDemoRewards(id);
  const next = {
    points: Math.max(0, current.points + Number(pointsDelta || 0)),
    referralCount: current.referralCount + Number(referralDelta || 0)
  };
  try{ localStorage.setItem("rl_rewards_" + id, JSON.stringify(next)); }catch(_){}
  return next;
}

async function incrementCustomerStats(email, amount){
  const id = customerDocId(email);
  if(!id) return;
  if(DB){
    try{
      await DB.collection("customers").doc(id).set({
        email: id,
        completedOrders: firebase.firestore.FieldValue.increment(1),
        totalSpent: firebase.firestore.FieldValue.increment(Number(amount) || 0),
        updatedAt: Date.now()
      }, { merge: true });
    }catch(err){ console.error("Increment customer stats error:", err); }
  }
  // In local demo mode, stats are derived live from orders in getCustomerStats,
  // so there's nothing separate to increment here.
}

/* ---------------- Referral programme ----------------
   How a referral travels through the system:

     1. An existing customer opens their tracking page and copies their
        personal link, which carries ?ref=THEIRCODE
     2. A friend opens that link, books, and the code rides along on the
        order as referredByCode
     3. When the admin marks that order Delivered, processDeliveryRewards
        resolves the code to the referrer and credits both sides

   The code is a one-way hash of the email, so a code can never be read
   back into an email address by whoever receives the link. Turning a code
   back into a customer needs the referralCodes lookup table, which only
   the signed-in admin can read or write. */

function genReferralCode(email){
  const id = customerDocId(email);
  if(!id) return "";
  let h1 = 0x811c9dc5;
  for(let i = 0; i < id.length; i++){
    h1 = h1 ^ id.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  let h2 = 0x9e3779b9;
  for(let i = id.length - 1; i >= 0; i--){
    h2 = h2 ^ id.charCodeAt(i);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const raw = (h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return "RLL" + (raw + "000000").slice(0, 6);
}

function normalizeReferralCode(raw){
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildReferralUrl(code){
  const base = window.location.origin + window.location.pathname;
  return base + "?ref=" + encodeURIComponent(code);
}

/* Writes the code to the lookup table so a future referral can be resolved.
   Admin-only; called when an order is delivered. Safe to call repeatedly. */
async function ensureReferralCode(email){
  const id = customerDocId(email);
  if(!id) return "";
  const code = genReferralCode(id);
  if(DB){
    try{
      await DB.collection("referralCodes").doc(code).set({
        email: id,
        createdAt: Date.now()
      }, { merge: true });
      await DB.collection("customers").doc(id).set({ referralCode: code }, { merge: true });
    }catch(err){ console.error("Ensure referral code error:", err); }
  }
  return code;
}

async function resolveReferralCode(code){
  const clean = normalizeReferralCode(code);
  if(!clean) return "";
  if(DB){
    try{
      const doc = await DB.collection("referralCodes").doc(clean).get();
      return doc.exists ? (doc.data().email || "") : "";
    }catch(err){
      console.error("Resolve referral code error:", err);
      return "";
    }
  }else{
    // Demo mode has no lookup table, so re-derive by scanning known emails.
    const orders = await listOrders();
    const seen = {};
    for(const o of orders){
      const id = customerDocId(o.email);
      if(id && !seen[id]){
        seen[id] = true;
        if(genReferralCode(id) === clean) return id;
      }
    }
    return "";
  }
}

async function addPoints(email, points, referralDelta){
  const id = customerDocId(email);
  if(!id) return;
  const amount = Number(points) || 0;
  if(DB){
    try{
      const payload = {
        email: id,
        points: firebase.firestore.FieldValue.increment(amount),
        updatedAt: Date.now()
      };
      if(referralDelta){
        payload.referralCount = firebase.firestore.FieldValue.increment(Number(referralDelta));
      }
      await DB.collection("customers").doc(id).set(payload, { merge: true });
    }catch(err){ console.error("Add points error:", err); }
  }else{
    addDemoRewards(id, amount, referralDelta || 0);
  }
}

/* Is this the customer's very first completed order? Referral rewards pay
   out once per new customer, so this is what gates them.

   The two storage modes need different questions asked. With Firebase the
   customers record is authoritative and is only incremented after this runs,
   so a zero there means first order. In local demo mode there is no separate
   record and stats are derived from the orders themselves, and the order in
   hand has already been saved as Delivered by the time we get here, so it has
   to be excluded from its own count. */
async function isFirstDeliveredOrder(order){
  const id = customerDocId(order.email);
  if(!id) return false;
  if(DB){
    try{
      const doc = await DB.collection("customers").doc(id).get();
      return !doc.exists || (Number(doc.data().completedOrders) || 0) === 0;
    }catch(err){
      console.error("First delivery check error:", err);
      return false;
    }
  }
  const orders = await listOrders();
  const others = orders.filter(o =>
    customerDocId(o.email) === id &&
    o.status === "Delivered" &&
    o.id !== order.id
  );
  return others.length === 0;
}

/* Everything that happens the moment an order is marked Delivered:
   the customer's own stats go up, they get their own referral code
   minted, and if they arrived through someone else's link, both sides
   get paid. Rewards fire only on a customer's FIRST delivered order,
   so a referrer earns once per person they bring in, not forever. */
async function processDeliveryRewards(order){
  const email = order.email;
  const id = customerDocId(email);
  if(!id) return;

  const isFirstDelivery = await isFirstDeliveredOrder(order);

  await incrementCustomerStats(email, order.finalPrice);
  await ensureReferralCode(email);

  if(!isFirstDelivery) return;
  if(order.referralRewarded) return;

  const code = normalizeReferralCode(order.referredByCode);
  if(!code) return;

  const price = Number(order.finalPrice) || 0;
  if(price < REFERRAL_MIN_ORDER){
    showToast("Referral not paid: order below the GH₵" + REFERRAL_MIN_ORDER + " minimum");
    return;
  }

  const referrerEmail = await resolveReferralCode(code);
  if(!referrerEmail){
    showToast("Referral code " + code + " did not match any customer");
    return;
  }
  if(referrerEmail === id){
    showToast("Referral ignored: that code belongs to this same customer");
    return;
  }

  const reward = Math.round(price * REFERRAL_PERCENT / 100);
  await addPoints(referrerEmail, reward, 1);
  await addPoints(id, WELCOME_POINTS, 0);

  try{
    await updateOrderFields(order.id, {
      referralRewarded: true,
      referralRewardPoints: reward,
      referrerEmail: referrerEmail
    });
    order.referralRewarded = true;
    order.referralRewardPoints = reward;
    order.referrerEmail = referrerEmail;
  }catch(err){ console.error("Mark referral rewarded error:", err); }

  showToast(reward + " points credited to the referrer, " + WELCOME_POINTS + " to " + order.name);
  sendReferralRewardEmail(referrerEmail, order, reward);
}

function emailjsConfigured(){
  return !EMAILJS_PUBLIC_KEY.startsWith("YOUR_") && !EMAILJS_SERVICE_ID.startsWith("YOUR_");
}

/* Mobile app build: this used to POST straight to EmailJS. It now writes a
   request document into Firestore instead — same templateId/templateParams
   shape as before — and a Cloud Function (functions/index.js in the handoff)
   turns that into a native push notification on the right phone. Kept the
   same name and signature on purpose: every function above that calls this
   (sendBookingEmails, sendReadyForDeliveryEmail, sendReferralRewardEmail,
   sendStatusUpdateEmail, sendOnTheWayEmail, sendPaymentSuccessEmail) needed
   zero changes. */
async function sendEmailJS(templateId, templateParams){
  if(!templateId){
    console.warn("No notification template mapped — skipping push.", templateParams);
    return { skipped: true };
  }
  if(!DB){
    console.warn("Push not available (Firebase not configured) — skipping.", templateId, templateParams);
    return { skipped: true };
  }
  try{
    await DB.collection("pushRequests").add({
      template: templateId,
      params: templateParams,
      createdAt: Date.now()
    });
    return { skipped: false };
  }catch(err){
    throw new Error(`Push request failed: ${err && err.message ? err.message : err}`);
  }
}

/* Shared wrapper: runs any of the send*Email functions and surfaces a visible
   toast on failure or when EmailJS isn't fully configured, instead of only
   logging to a console nobody's watching. Used by every notification email
   so a broken template ID or unsaved template setting is never silent. */
async function sendEmailWithFeedback(label, templateId, params){
  try{
    const result = await sendEmailJS(templateId, params);
    if(result && result.skipped){
      console.warn(`${label} skipped — EmailJS not fully configured.`);
    }
  }catch(err){
    console.error(`${label} failed:`, err);
    showToast(`${label} failed to send: ` + (err && err.message ? err.message : "unknown error"));
  }
}

async function sendBookingEmails(order){
  const commonParams = {
    order_id: order.id,
    customer_name: order.name,
    customer_email: order.email,
    customer_phone: order.phone,
    service: order.service + (order.express ? " (Express Same-Day)" : ""),
    pickup_date: order.date,
    pickup_time: order.time,
    address: order.address,
    notes: order.notes || "—"
  };
  await sendEmailWithFeedback("Booking confirmation email", EMAILJS_TEMPLATE_CUSTOMER_BOOKING, { to_email: order.email, ...commonParams });
  await sendEmailWithFeedback("Admin new-order alert", EMAILJS_TEMPLATE_ADMIN_BOOKING, { to_email: ADMIN_EMAIL, ...commonParams });
}

async function sendReadyForDeliveryEmail(order){
  const trackingUrl = `${window.location.origin}${window.location.pathname}?track=${encodeURIComponent(order.id)}`;
  await sendEmailWithFeedback("Ready-for-delivery email", EMAILJS_TEMPLATE_READY, {
    to_email: order.email,
    order_id: order.id,
    customer_name: order.name,
    service: order.service,
    final_price: `GH₵${order.finalPrice}`,
    estimated_delivery: order.estimatedDelivery,
    address: order.address,
    tracking_url: trackingUrl
  });
}

function buildTrackingUrl(orderId){
  return `${window.location.origin}${window.location.pathname}?track=${encodeURIComponent(orderId)}`;
}

async function sendReferralRewardEmail(referrerEmail, order, points){
  if(!EMAILJS_TEMPLATE_REFERRAL_REWARD) return;
  const stats = await getCustomerStats(referrerEmail);
  await sendEmailWithFeedback("Referral reward email", EMAILJS_TEMPLATE_REFERRAL_REWARD, {
    to_email: referrerEmail,
    customer_name: "there",
    points_earned: points,
    points_balance: stats.points || 0,
    friend_name: order.name,
    tracking_url: window.location.origin + window.location.pathname
  });
}

async function sendStatusUpdateEmail(order, newStatus){
  await sendEmailWithFeedback("Status update email", EMAILJS_TEMPLATE_STATUS_UPDATE, {
    to_email: order.email,
    order_id: order.id,
    customer_name: order.name,
    new_status: newStatus,
    tracking_url: buildTrackingUrl(order.id)
  });
}

async function sendOnTheWayEmail(order, direction, staffName){
  await sendEmailWithFeedback("On-the-way email", EMAILJS_TEMPLATE_ON_THE_WAY, {
    to_email: order.email,
    order_id: order.id,
    customer_name: order.name,
    direction: direction,
    staff_name: staffName || "Our team",
    tracking_url: buildTrackingUrl(order.id)
  });
}

async function sendPaymentSuccessEmail(order){
  try{
    const result = await sendEmailJS(EMAILJS_TEMPLATE_PAYMENT_SUCCESS, {
      to_email: order.email,
      order_id: order.id,
      customer_name: order.name,
      amount_paid: `GH₵${order.finalPrice}`,
      payment_reference: order.paymentReference || "—"
    });
    if(result && result.skipped){
      showToast("Payment saved, but email isn't fully configured yet.");
    }
  }catch(err){
    console.error("Payment confirmation email failed:", err);
    showToast("Payment saved, but the confirmation email failed to send: " + (err && err.message ? err.message : "unknown error"));
  }
}

/* ---------------- Utilities ---------------- */
function scrollToId(id){ document.getElementById(id).scrollIntoView({behavior:"smooth", block:"start"}); }

function genOrderId(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return "RL-" + s;
}

let TOAST_TIMEOUT = null;
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  t.style.cursor = "pointer";
  t.onclick = () => { t.classList.remove("show"); if(TOAST_TIMEOUT) clearTimeout(TOAST_TIMEOUT); };
  if(TOAST_TIMEOUT) clearTimeout(TOAST_TIMEOUT);
  const duration = msg.length > 60 ? 20000 : 3500;
  TOAST_TIMEOUT = setTimeout(()=> t.classList.remove("show"), duration);
}

function escapeHtml(str){
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

/* today as yyyy-mm-dd for min date */
(function setMinDate(){
  const el = document.getElementById("f-date");
  const now = new Date();
  const iso = now.toISOString().slice(0,10);
  el.min = iso;
})();

/* Pickup time windows: on any day except Sunday, all windows are available.
   If the customer picks a Sunday as the pickup date, only windows starting
   at or after 2:00 PM are offered — earlier Sunday slots are locked. */
const ALL_TIME_WINDOWS = ["8:00 AM – 10:00 AM", "10:00 AM – 12:00 PM", "1:00 PM – 3:00 PM", "3:00 PM – 5:00 PM", "5:00 PM – 7:00 PM"];
const SUNDAY_TIME_WINDOWS = ["3:00 PM – 5:00 PM", "5:00 PM – 7:00 PM"];

function updateTimeWindowOptions(){
  const dateVal = document.getElementById("f-date").value;
  const timeSelect = document.getElementById("f-time");
  const noteEl = document.getElementById("f-sunday-note");
  const isSunday = !!dateVal && new Date(dateVal + "T00:00:00").getDay() === 0;
  const allowed = isSunday ? SUNDAY_TIME_WINDOWS : ALL_TIME_WINDOWS;

  const currentVal = timeSelect.value;
  timeSelect.innerHTML = '<option value="">Select a window</option>' +
    allowed.map(w => `<option>${w}</option>`).join("");
  timeSelect.value = allowed.includes(currentVal) ? currentVal : "";

  noteEl.style.display = isSunday ? "block" : "none";
}
document.getElementById("f-date").addEventListener("change", updateTimeWindowOptions);
updateTimeWindowOptions();

/* ---------------- Location pinning (booking form) ----------------
   A one-time precise GPS pin, not a continuous live share — most customers
   are stationary at the pickup address, so a single accurate coordinate is
   more useful (and less battery/privacy-intrusive) than ongoing tracking.
   Especially helpful where street addresses aren't precise. */
let BOOKING_LOCATION = null;

function pinBookingLocation(){
  if(!("geolocation" in navigator)){
    showToast("Location isn't supported on this device.");
    return;
  }
  const btn = document.getElementById("pin-location-btn");
  btn.disabled = true;
  btn.textContent = "Pinning...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      BOOKING_LOCATION = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      document.getElementById("pin-location-status").style.display = "block";
      btn.textContent = "📍 Update Pinned Location";
      btn.disabled = false;
    },
    (err) => {
      console.error("Geolocation error:", err);
      showToast("Could not get your location: " + (err.message || "permission denied"));
      btn.textContent = "📍 Pin My Exact Location";
      btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

/* ---------------- Booking field validation ---------------- */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidGhanaPhone(raw){
  const digits = raw.replace(/[\s-]/g, "");
  return /^0\d{9}$/.test(digits) || /^\+233\d{9}$/.test(digits) || /^233\d{9}$/.test(digits);
}

function setFieldError(inputEl, errEl, message){
  if(message){
    inputEl.classList.add("invalid");
    errEl.textContent = message;
    errEl.classList.add("show");
  }else{
    inputEl.classList.remove("invalid");
    errEl.textContent = "";
    errEl.classList.remove("show");
  }
}

function validatePhoneField(){
  const el = document.getElementById("f-phone");
  const errEl = document.getElementById("f-phone-err");
  const val = el.value.trim();
  if(!val){ setFieldError(el, errEl, ""); return true; }
  if(!isValidGhanaPhone(val)){
    setFieldError(el, errEl, "Enter a valid Ghana number, e.g. 054 102 0619.");
    return false;
  }
  setFieldError(el, errEl, "");
  return true;
}

function validateEmailField(){
  const el = document.getElementById("f-email");
  const errEl = document.getElementById("f-email-err");
  const val = el.value.trim();
  if(!val){ setFieldError(el, errEl, ""); return true; }
  if(!EMAIL_PATTERN.test(val)){
    setFieldError(el, errEl, "Enter a valid email address, e.g. you@example.com.");
    return false;
  }
  setFieldError(el, errEl, "");
  return true;
}

document.getElementById("f-phone").addEventListener("blur", validatePhoneField);
document.getElementById("f-phone").addEventListener("input", () => {
  if(document.getElementById("f-phone").classList.contains("invalid")) validatePhoneField();
});
/* When the customer finishes typing their email we look up their own
   rewards record (a single direct read, which the Firestore rules allow
   for anyone who knows the exact address) and, if they have enough banked,
   offer to spend it here. Choosing "yes" only flags the order — the actual
   deduction happens when the admin sets the final price, because until
   then nobody knows what the order is worth. */
async function offerPointsAtBooking(){
  const wrap = document.getElementById("f-points-wrap");
  const box = document.getElementById("f-use-points");
  const note = document.getElementById("f-points-note");
  const email = document.getElementById("f-email").value.trim();

  wrap.style.display = "none";
  box.checked = false;
  BOOKING_POINTS_AVAILABLE = 0;

  if(!email || !EMAIL_PATTERN.test(email)) return;

  try{
    const stats = await getCustomerStats(email);
    const points = stats.points || 0;
    if(points < POINTS_REDEEM_MINIMUM) return;

    BOOKING_POINTS_AVAILABLE = points;
    document.getElementById("f-points-balance").textContent = points;
    note.innerHTML = "Worth up to <strong style=\"color:var(--gold-bright);\">GH₵" +
      (points * POINT_VALUE_GHS) + "</strong> off. We will apply them when we confirm your price. " +
      "Points are spent in one go, so this order needs to come to at least GH₵" +
      POINTS_REDEEM_MINIMUM + " for them to be used.";
    wrap.style.display = "block";
  }catch(err){
    console.error("Points lookup error:", err);
  }
}

let BOOKING_POINTS_AVAILABLE = 0;

document.getElementById("f-email").addEventListener("blur", offerPointsAtBooking);
document.getElementById("f-email").addEventListener("blur", validateEmailField);
document.getElementById("f-email").addEventListener("input", () => {
  if(document.getElementById("f-email").classList.contains("invalid")) validateEmailField();
});
document.getElementById("f-express").addEventListener("change", function(){
  document.getElementById("f-express-warning").style.display = this.checked ? "block" : "none";
});

/* ---------------- Booking ---------------- */
document.getElementById("booking-form").addEventListener("submit", async function(e){
  e.preventDefault();
  const msg = document.getElementById("form-msg");
  msg.className = "form-msg"; msg.textContent = "";

  const dateVal = document.getElementById("f-date").value;
  const timeVal = document.getElementById("f-time").value;
  const isSunday = !!dateVal && new Date(dateVal + "T00:00:00").getDay() === 0;
  if(isSunday && timeVal && !SUNDAY_TIME_WINDOWS.includes(timeVal)){
    updateTimeWindowOptions();
    msg.textContent = "Sunday pickups are only available from 2:00 PM. Please choose a valid window.";
    msg.classList.add("err","show");
    return;
  }

  const name = document.getElementById("f-name").value.trim();
  const phone = document.getElementById("f-phone").value.trim();
  const email = document.getElementById("f-email").value.trim();
  const service = document.getElementById("f-service").value;
  const express = document.getElementById("f-express").checked;
  const address = document.getElementById("f-address").value.trim();
  const date = document.getElementById("f-date").value;
  const time = document.getElementById("f-time").value;
  const notes = document.getElementById("f-notes").value.trim();
  const referral = normalizeReferralCode(document.getElementById("f-referral").value);
  const wantsPoints = document.getElementById("f-use-points").checked && BOOKING_POINTS_AVAILABLE >= POINTS_REDEEM_MINIMUM;

  if(!name || !phone || !email || !service || !address || !date || !time){
    msg.textContent = "Please fill in every required field before confirming.";
    msg.classList.add("err","show");
    return;
  }
  const phoneOk = validatePhoneField();
  const emailOk = validateEmailField();
  if(!phoneOk || !emailOk){
    msg.textContent = "Please fix the highlighted fields before confirming.";
    msg.classList.add("err","show");
    return;
  }

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Confirming...";

  const id = genOrderId();
  const order = {
    id, name, phone, email, service, express, address, date, time, notes,
    status: "Requested",
    createdAt: Date.now(),
    statusHistory: [{ status: "Requested", at: Date.now() }]
  };
  if(referral){
    order.referredByCode = referral;
  }
  if(wantsPoints){
    order.redeemPointsRequested = true;
  }
  if(BOOKING_LOCATION){
    order.customerLocation = BOOKING_LOCATION;
  }

  try{
    await saveOrder(order);
    document.getElementById("confirm-order-id").textContent = id;
    document.getElementById("booking-form-wrap").style.display = "none";
    document.getElementById("booking-confirm").style.display = "block";
    sendBookingEmails(order);
    registerPushForOrder(id);
  }catch(err){
    console.error("Booking storage error:", err);
    msg.textContent = "Something went wrong saving your request (" + (err && err.message ? err.message : "please try again") + ").";
    msg.classList.add("err","show");
  }finally{
    submitBtn.disabled = false;
    submitBtn.textContent = "Confirm Pickup Request";
  }
});

function resetBookingForm(){
  document.getElementById("booking-form").reset();
  document.getElementById("booking-form-wrap").style.display = "block";
  document.getElementById("booking-confirm").style.display = "none";
  const msg = document.getElementById("form-msg");
  msg.className = "form-msg"; msg.textContent = "";
  setFieldError(document.getElementById("f-phone"), document.getElementById("f-phone-err"), "");
  setFieldError(document.getElementById("f-email"), document.getElementById("f-email-err"), "");
  document.getElementById("f-express-warning").style.display = "none";
  BOOKING_LOCATION = null;
  document.getElementById("f-referral-note").style.display = "none";
  document.getElementById("f-points-wrap").style.display = "none";
  document.getElementById("f-use-points").checked = false;
  BOOKING_POINTS_AVAILABLE = 0;
  document.getElementById("pin-location-status").style.display = "none";
  document.getElementById("pin-location-btn").textContent = "📍 Pin My Exact Location";
  updateTimeWindowOptions();
}

/* ---------------- Tracking ---------------- */
let TRACK_UNSUBSCRIBE = null;

/* Guards against paying the same order twice. Two different failure modes
   are covered:
     - the SAME tab: a double-tap or a slow network makes someone click Pay
       again before the first click has even opened the Paystack popup
     - a STALE page: the customer paid a minute ago (maybe on another tab
       or device), the write succeeded, but this particular tab hasn't
       re-rendered yet and still shows the Pay button
   A Set rather than a single boolean, so it stays correct even though only
   one order is ever tracked per page load. */
const PAYMENT_LOCKS = new Set();
/* Retired. Every lookup now goes through the order ID, which is private,
   so every successful lookup earns the full view. Kept as a permanent false
   so the render template below stays readable and a restricted view can be
   reintroduced later without rewriting it. */
const TRACK_LIMITED_VIEW = false;

function clearTrackListener(){
  if(TRACK_UNSUBSCRIBE){
    try{ TRACK_UNSUBSCRIBE(); }catch(_){}
    TRACK_UNSUBSCRIBE = null;
  }
}

async function handleTrackSearch(){
  const raw = document.getElementById("track-input").value.trim();
  const resultEl = document.getElementById("track-result");
  const loadingEl = document.getElementById("track-loading");
  resultEl.innerHTML = "";
  clearTrackListener();
  if(!raw){ resultEl.innerHTML = '<div class="empty-note">Enter your order ID to begin.</div>'; return; }

  loadingEl.style.display = "block";
  try{
    // Order ID only. The ID is the secret that grants access to an order, so
    // this is the single lookup path. Phone number search was removed: phone
    // numbers are guessable, and matching on one required listing the whole
    // orders collection, which the Firestore rules rightly refuse to allow
    // an unauthenticated visitor to do.
    const idGuess = raw.toUpperCase().startsWith("RL-") ? raw.toUpperCase() : `RL-${raw.toUpperCase()}`;
    const order = await getOrder(idGuess);

    if(order){
      beginLiveTracking(order, false);
      return;
    }

    resultEl.innerHTML = '<div class="empty-note">No order found with that ID. Check the order ID in your confirmation email, or call us on 054 102 0619 and we will look it up for you.</div>';
  }catch(err){
    console.error("Track search error:", err);
    resultEl.innerHTML = '<div class="empty-note">We could not reach the order ledger. Please try again in a moment.</div>';
  }finally{
    loadingEl.style.display = "none";
  }
}

/* Browser push notifications: fires while the customer has the tracking page
   open, on top of (not instead of) the email notifications — email covers them
   when they've closed the tab, this covers the instant, in-the-moment ping. */
let TRACK_LAST_SEEN = null; // { status, paid } of the last render, to detect changes

function requestTrackingNotifications(){
  if(!("Notification" in window)){
    showToast("Notifications aren't supported in this browser.");
    return;
  }
  Notification.requestPermission().then(permission => {
    const btn = document.getElementById("enable-notify-btn");
    if(permission === "granted"){
      if(btn) btn.textContent = "Notifications enabled ✓";
      showToast("You'll be notified here as your order updates.");
    }else{
      showToast("Notifications weren't enabled.");
    }
  });
}

function notifyIfChanged(order){
  if(TRACK_LAST_SEEN && TRACK_LAST_SEEN.id === order.id){
    if(TRACK_LAST_SEEN.status !== order.status){
      pushBrowserNotification("Royal Luxury Laundry", `${order.id} is now: ${order.status}`);
    }
    if(!TRACK_LAST_SEEN.paid && order.paid){
      pushBrowserNotification("Payment Received", `Your payment for ${order.id} was successful.`);
    }
    if(!TRACK_LAST_SEEN.hasLocation && order.driverLocation){
      const direction = order.status === "Ready for Delivery" ? "deliver your laundry" : "collect your laundry";
      const who = order.assignedTo ? `${order.assignedTo} is` : "We're";
      pushBrowserNotification("On the way!", `${who} heading out to ${direction} for ${order.id}.`);
    }
  }
  TRACK_LAST_SEEN = { id: order.id, status: order.status, paid: !!order.paid, hasLocation: !!order.driverLocation };
}

function pushBrowserNotification(title, body){
  if("Notification" in window && Notification.permission === "granted"){
    try{ new Notification(title, { body, icon: undefined }); }catch(err){ console.error("Notification error:", err); }
  }
}

/* Start (or restart) live tracking for a single order: renders it immediately,
   then keeps it updated without the customer needing to search again.
   Uses a real-time Firestore listener when connected; falls back to polling
   every few seconds in local demo mode. */
function beginLiveTracking(order, limited){
  clearTrackListener();
  TRACK_LAST_SEEN = null;
  // `limited` is no longer used — order ID lookups always grant full access.
  renderTrackedOrder(order);
  notifyIfChanged(order);
  registerPushForOrder(order.id);

  if(DB){
    TRACK_UNSUBSCRIBE = DB.collection("orders").doc(order.id).onSnapshot(
      (doc) => { if(doc.exists){ const fresh = doc.data(); renderTrackedOrder(fresh); notifyIfChanged(fresh); } },
      (err) => console.error("Live tracking listener error:", err)
    );
  }else{
    const intervalId = setInterval(async () => {
      try{
        const fresh = await getOrder(order.id);
        if(fresh){ renderTrackedOrder(fresh); notifyIfChanged(fresh); }
      }catch(err){ console.error("Tracking poll error:", err); }
    }, 5000);
    TRACK_UNSUBSCRIBE = () => clearInterval(intervalId);
  }
}

function formatHistoryTime(ts){
  if(!ts) return "";
  return new Date(ts).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
}

/* ---------------- Royal Rank card (customer tracking page) ---------------- */
async function renderRankCard(email){
  const slot = document.getElementById("rank-card-slot");
  if(!slot) return;
  try{
    const stats = await getCustomerStats(email);
    const completed = stats.completedOrders || 0;
    const { tier, next } = getRankForCount(completed);
    const progressPct = next ? Math.min(100, Math.max(4, Math.round((completed - tier.min) / (next.min - tier.min) * 100))) : 100;
    slot.innerHTML = `
      <div class="rank-card">
        <div class="rank-card-head">
          <svg class="rank-crest" viewBox="0 0 100 100" fill="none"><path d="M50 8 L58 24 L72 14 L68 32 L86 30 L74 44 L92 52 L74 58 L84 74 L66 68 L64 88 L50 74 L36 88 L34 68 L16 74 L26 58 L8 52 L26 44 L14 30 L32 32 L28 14 L42 24 Z" stroke="${tier.crest}" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <div>
            <div class="rank-name" style="color:${tier.crest};">${tier.name}</div>
            <div class="rank-sub">${completed} order${completed === 1 ? "" : "s"} completed</div>
          </div>
        </div>
        <div class="rank-perk">${escapeHtml(tier.perk)}</div>
        ${next ? `
          <div class="rank-progress-track"><div class="rank-progress-fill" style="width:${progressPct}%; background:${next.crest};"></div></div>
          <div class="rank-progress-label">${next.min - completed} more order${(next.min - completed) === 1 ? "" : "s"} to reach <strong style="color:${next.crest};">${next.name}</strong></div>
        ` : `<div class="rank-progress-label">You've reached the highest rank. 👑</div>`}
      </div>
    `;
    renderReferralCard(email, stats);
  }catch(err){
    console.error("Render rank card error:", err);
    slot.innerHTML = "";
  }
}

/* The customer-facing half of the referral programme: balance, personal
   link, and the share buttons. Appended under the rank card on the tracking
   page, which is the one screen a customer reliably comes back to. */
function renderReferralCard(email, stats){
  const slot = document.getElementById("rank-card-slot");
  if(!slot) return;
  const completed = stats.completedOrders || 0;
  const points = stats.points || 0;
  const referrals = stats.referralCount || 0;

  if(completed < 1){
    slot.insertAdjacentHTML("beforeend", `
      <div class="ref-card">
        <h4>Refer a friend</h4>
        <p class="ref-lede">Earn ${REFERRAL_PERCENT}% of what your friends spend, as points you can put straight towards your own wash.</p>
        <div class="ref-locked">Your personal referral link unlocks once your first order has been delivered. Almost there.</div>
      </div>
    `);
    return;
  }

  const code = genReferralCode(email);
  const url = buildReferralUrl(code);
  const shareText = "I use Royal Luxury Laundry in Kumasi and they pick up and deliver to your door. Book with my link and we both get rewarded: ";

  slot.insertAdjacentHTML("beforeend", `
    <div class="ref-card">
      <h4>Refer a friend</h4>
      <p class="ref-lede">Every friend who books with your link earns you ${REFERRAL_PERCENT}% of their first order as points. ${POINT_VALUE_GHS === 1 ? "One point is one cedi" : "Each point is worth GH" + POINT_VALUE_GHS} off a future wash.</p>
      <div class="ref-balance">
        <div class="pts">${points}</div>
        <div class="pts-label">points${points > 0 ? " &middot; worth GH₵" + (points * POINT_VALUE_GHS) : ""}</div>
      </div>
      ${points >= POINTS_REDEEM_MINIMUM
        ? `<div class="ref-applied">Ready to spend. Tell us when we confirm your price and we will take GH₵${POINTS_REDEEM_MINIMUM} or more off your bill.</div>`
        : `<div class="ref-locked" style="margin-bottom:16px;">
             <div style="margin-bottom:10px;">Points unlock at <strong style="color:var(--gold-bright);">${POINTS_REDEEM_MINIMUM} points</strong>. You need ${POINTS_REDEEM_MINIMUM - points} more.</div>
             <div class="rank-progress-track"><div class="rank-progress-fill" style="width:${Math.min(100, Math.max(3, Math.round(points / POINTS_REDEEM_MINIMUM * 100)))}%; background:var(--gold);"></div></div>
           </div>`}
      ${referrals > 0 ? `<div class="ref-applied">You have brought in ${referrals} customer${referrals === 1 ? "" : "s"} so far. Thank you.</div>` : ""}
      <div class="ref-code-row">
        <div class="ref-code-box">${escapeHtml(code)}</div>
      </div>
      <div class="ref-actions">
        <button class="btn btn-solid" onclick="copyReferralLink('${escapeHtml(url)}')">Copy My Link</button>
        <button class="btn btn-ghost" onclick="shareReferralWhatsApp('${escapeHtml(shareText)}', '${escapeHtml(url)}')">Share on WhatsApp</button>
      </div>
      <div class="ref-terms">
        Points are credited once your friend's first order is delivered and reaches GH₵${REFERRAL_MIN_ORDER}. They can be spent once your balance reaches ${POINTS_REDEEM_MINIMUM} points, on any order of GH₵${POINTS_REDEEM_MINIMUM} or more. Just say so when we confirm your price.
      </div>
    </div>
  `);
}

function copyReferralLink(url){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(
      function(){ showToast("Referral link copied"); },
      function(){ fallbackCopy(url); }
    );
  }else{
    fallbackCopy(url);
  }
}

function fallbackCopy(text){
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try{
    document.execCommand("copy");
    showToast("Referral link copied");
  }catch(_){
    showToast("Copy failed — your link is: " + text);
  }
  document.body.removeChild(el);
}

function shareReferralWhatsApp(text, url){
  const msg = encodeURIComponent(text + url);
  window.open("https://wa.me/?text=" + msg, "_blank");
}

/* ---------------- Live delivery map (customer tracking page) ---------------- */
let DELIVERY_MAP_INSTANCE = null;
let DELIVERY_MAP_MARKER = null;

/* Straight-line distance between two coordinates, in kilometres (haversine). */
function distanceKm(a, b){
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2) ** 2 + Math.sin(dLng/2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Live ETA from the driver's current position to the customer's pinned spot.
   This is a straight-line estimate padded for real roads and traffic, not a
   routed direction — good enough for "roughly how far away are they", which
   is what a waiting customer actually wants to know. Deliberately phrased as
   an approximation so nobody treats it as a promise. */
function estimateEta(driverLoc, customerLoc){
  if(!driverLoc || !customerLoc) return null;
  const straightKm = distanceKm(driverLoc, customerLoc);
  const roadKm = straightKm * 1.35;      // roads wander; pad the straight line
  const avgSpeedKmh = 20;                 // conservative urban average
  const minutes = Math.round((roadKm / avgSpeedKmh) * 60);
  return {
    km: roadKm,
    minutes: Math.max(1, minutes),
    arriving: roadKm < 0.25
  };
}

function renderDeliveryMap(loc, staffName, customerLoc){
  const slot = document.getElementById("delivery-map-slot");
  if(!slot || !loc || typeof L === "undefined") return;

  const eta = estimateEta(loc, customerLoc);
  const etaHtml = eta
    ? (eta.arriving
        ? `<div class="eta-banner eta-arriving"><span class="eta-big">Arriving now</span><span class="eta-sub">Just outside</span></div>`
        : `<div class="eta-banner"><span class="eta-big">~${eta.minutes} min away</span><span class="eta-sub">about ${eta.km.toFixed(1)} km · estimate</span></div>`)
    : `<div class="eta-banner eta-none"><span class="eta-sub">Pin your exact location above to see a live arrival estimate.</span></div>`;

  slot.innerHTML = `
    <div class="delivery-map-wrap">
      <div class="delivery-map-title"><span class="live-dot" style="display:inline-block; margin-right:6px;"></span>${staffName ? `${escapeHtml(staffName)} is on the way` : "Live delivery location"}</div>
      ${etaHtml}
      <div id="delivery-map" class="delivery-map"></div>
      <div class="delivery-map-updated">Updated ${formatHistoryTime(loc.updatedAt)}</div>
    </div>
  `;

  // Leaflet can't reuse a destroyed container, so always start fresh since
  // this slot is recreated on every tracking re-render.
  try{
    DELIVERY_MAP_INSTANCE = L.map("delivery-map", { zoomControl: false, attributionControl: false }).setView([loc.lat, loc.lng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(DELIVERY_MAP_INSTANCE);
    const goldIcon = L.divIcon({
      className: "",
      html: '<div style="width:16px;height:16px;background:#c9a227;border:2px solid #f0cf6d;border-radius:50%;box-shadow:0 0 10px rgba(201,162,39,0.7);"></div>',
      iconSize: [16,16], iconAnchor: [8,8]
    });
    DELIVERY_MAP_MARKER = L.marker([loc.lat, loc.lng], { icon: goldIcon }).addTo(DELIVERY_MAP_INSTANCE);

    // Show the destination too, and frame both so the customer can see the
    // gap closing rather than just a lone dot drifting.
    if(customerLoc){
      const homeIcon = L.divIcon({
        className: "",
        html: '<div style="width:14px;height:14px;background:#c58bd9;border:2px solid #f0cf6d;border-radius:50%;box-shadow:0 0 8px rgba(197,139,217,0.7);"></div>',
        iconSize: [14,14], iconAnchor: [7,7]
      });
      L.marker([customerLoc.lat, customerLoc.lng], { icon: homeIcon }).addTo(DELIVERY_MAP_INSTANCE);
      L.polyline([[loc.lat, loc.lng], [customerLoc.lat, customerLoc.lng]], {
        color: "#c9a227", weight: 2, opacity: 0.5, dashArray: "6 8"
      }).addTo(DELIVERY_MAP_INSTANCE);
      DELIVERY_MAP_INSTANCE.fitBounds(
        [[loc.lat, loc.lng], [customerLoc.lat, customerLoc.lng]],
        { padding: [40, 40], maxZoom: 16 }
      );
    }
  }catch(err){ console.error("Delivery map render error:", err); }
}

function renderCustomerLocationMap(orderId, loc){
  const el = document.getElementById(`customer-map-${orderId}`);
  if(!el || !loc || typeof L === "undefined") return;
  try{
    const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([loc.lat, loc.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);
    const pinIcon = L.divIcon({
      className: "",
      html: '<div style="width:16px;height:16px;background:#c58bd9;border:2px solid #f0cf6d;border-radius:50%;box-shadow:0 0 10px rgba(197,139,217,0.7);"></div>',
      iconSize: [16,16], iconAnchor: [8,8]
    });
    L.marker([loc.lat, loc.lng], { icon: pinIcon }).addTo(map);
  }catch(err){ console.error("Customer location map render error:", err); }
}

/* ---------------- PDF Receipt ---------------- */
async function downloadReceipt(orderId){
  try{
    const order = await getOrder(orderId);
    if(!order){ showToast("Could not find that order."); return; }
    if(typeof window.jspdf === "undefined"){ showToast("Receipt tool is still loading — try again in a moment."); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const marginX = 48;
    let y = 56;

    const gold = [201, 162, 39];
    const dark = [30, 28, 22];
    const muted = [120, 113, 96];

    // Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(...dark);
    doc.text("ROYAL LUXURY LAUNDRY", marginX, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...muted);
    doc.text("Laundry to Your Doorstep · Fankyenebra, TUC", marginX, y + 14);
    doc.text("0541 020 619 · 0554 176 157 · 0509 813 440 · 0554 188 301", marginX, y + 26);

    doc.setDrawColor(...gold);
    doc.setLineWidth(1.2);
    y += 40;
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 28;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...dark);
    doc.text("RECEIPT", marginX, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...muted);
    doc.text(`Issued ${new Date().toLocaleString(undefined, { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" })}`, pageWidth - marginX, y, { align: "right" });
    y += 24;

    function row(label, value){
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...muted);
      doc.text(label.toUpperCase(), marginX, y);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...dark);
      doc.text(String(value || "—"), marginX, y + 14);
      y += 34;
    }
    function sectionTitle(text){
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...gold);
      doc.text(text.toUpperCase(), marginX, y);
      y += 6;
      doc.setDrawColor(230,222,200);
      doc.setLineWidth(0.6);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 20;
    }

    sectionTitle("Order Details");
    row("Order ID", order.id);
    row("Customer", `${order.name}  ·  ${order.phone}  ·  ${order.email || "—"}`);
    row("Item Type", order.service + (order.express ? "  (Express Same-Day)" : ""));
    row("Pickup", `${order.date}, ${order.time}`);
    row("Address", order.address);

    sectionTitle("Status History");
    const history = (order.statusHistory && order.statusHistory.length ? order.statusHistory : [{ status: order.status, at: order.createdAt }])
      .slice().sort((a,b)=> a.at - b.at);
    history.forEach(h=>{
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...dark);
      doc.text(h.status, marginX, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...muted);
      doc.text(formatHistoryTime(h.at), pageWidth - marginX, y, { align: "right" });
      y += 18;
    });
    y += 14;

    sectionTitle("Payment");
    if(order.pointsRedeemed){
      row("Subtotal", `GH₵${order.priceBeforePoints}`);
      row("Points Redeemed", `${order.pointsRedeemed} pts  -GH₵${order.pointsDiscount}`);
    }
    row("Final Price", order.finalPrice ? `GH₵${order.finalPrice}` : "Not yet priced");
    row("Payment Status", order.paid ? `Paid${order.paymentMethod === "cash" ? " (Cash)" : order.paymentMethod === "online" ? " (Card/Mobile Money)" : ""}` : "Unpaid");
    if(order.paymentReference) row("Payment Reference", order.paymentReference);
    row("Estimated Delivery", order.estimatedDelivery || "—");

    y += 10;
    doc.setDrawColor(...gold);
    doc.setLineWidth(1);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 22;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(...muted);
    doc.text("Thank you for choosing Royal Luxury Laundry.", marginX, y);

    // In the phone app, a browser-style download does nothing (Android) or
    // replaces the app screen with the PDF (iPhone). Save the file into the
    // app's cache and open the share sheet instead, so the customer can save
    // it to Files, print it, or send it on WhatsApp. The website keeps the
    // normal download.
    const isNativeApp = CAP && typeof CAP.isNativePlatform === "function" && CAP.isNativePlatform();
    if(isNativeApp && FILES && SHARE){
      const fileName = `${order.id}-receipt.pdf`;
      const base64 = doc.output("datauristring").split(",")[1];
      const written = await FILES.writeFile({ path: fileName, data: base64, directory: "CACHE" });
      await SHARE.share({ title: `Receipt ${order.id}`, url: written.uri, dialogTitle: "Save or share your receipt" });
    }else{
      doc.save(`${order.id}-receipt.pdf`);
    }
  }catch(err){
    console.error("Receipt generation error:", err);
    showToast("Could not generate receipt: " + (err && err.message ? err.message : "please try again"));
  }
}

function renderTrackedOrder(order){
  const resultEl = document.getElementById("track-result");
  const stepIndex = STATUSES.indexOf(order.status);
  const timelineHtml = STATUSES.map((s, i)=>{
    const cls = i < stepIndex ? "done" : (i === stepIndex ? "done current" : "");
    const icon = i <= stepIndex
      ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>';
    return `<div class="timeline-step ${cls}"><div class="seal-dot">${icon}</div><div class="label">${escapeHtml(s)}</div></div>`;
  }).join("");

  const history = (order.statusHistory && order.statusHistory.length ? order.statusHistory : [{ status: order.status, at: order.createdAt }])
    .slice()
    .sort((a,b)=> a.at - b.at);
  const historyHtml = history.map((h, i) => `
    <div class="history-row">
      <div class="history-line ${i === history.length - 1 ? "last" : ""}">
        <div class="history-dot ${i === history.length - 1 ? "current" : ""}"></div>
      </div>
      <div class="history-content">
        <div class="history-status">${escapeHtml(h.status)}</div>
        <div class="history-time">${formatHistoryTime(h.at)}</div>
      </div>
    </div>
  `).join("");

  const notifySupported = "Notification" in window;
  const notifyGranted = notifySupported && Notification.permission === "granted";
  const notifyDenied = notifySupported && Notification.permission === "denied";

  resultEl.innerHTML = `
    <div class="track-order-head">
      <div class="oid">${escapeHtml(order.id)} <span class="live-badge"><span class="live-dot"></span>${DB ? "Live" : "Auto-updating"}</span></div>
      <div class="oname">${TRACK_LIMITED_VIEW ? `Booked ${escapeHtml(order.date)}` : `${escapeHtml(order.name)} · booked ${escapeHtml(order.date)}`}</div>
      ${notifySupported ? `<button id="enable-notify-btn" class="btn btn-ghost" style="padding:6px 14px; font-size:0.68rem; margin-top:10px;" onclick="requestTrackingNotifications()" ${notifyGranted ? "disabled" : ""}>${notifyGranted ? "Notifications enabled ✓" : notifyDenied ? "Notifications blocked" : "Enable Notifications"}</button>` : ""}
    </div>
    ${TRACK_LIMITED_VIEW ? "" : `<div id="rank-card-slot"></div>`}
    <div class="timeline">${timelineHtml}</div>
    ${order.driverLocation && order.status !== "Delivered" && !TRACK_LIMITED_VIEW ? `<div id="delivery-map-slot"></div>` : ""}
    <div class="order-detail-grid">
      <div class="item"><div class="k">Item Type</div><div class="v">${escapeHtml(order.service)}${order.express ? ' <span style="color:#f0cf6d;">· Express</span>' : ""}</div></div>
      <div class="item"><div class="k">Status</div><div class="v"><span class="status-pill ${STATUS_CLASS[order.status]}"><span class="dot"></span>${escapeHtml(order.status)}</span></div></div>
      ${TRACK_LIMITED_VIEW ? "" : `<div class="item"><div class="k">Pickup Window</div><div class="v">${escapeHtml(order.time)}</div></div>`}
      ${TRACK_LIMITED_VIEW ? "" : `<div class="item"><div class="k">Address</div><div class="v">${escapeHtml(order.address)}</div></div>`}
      ${order.finalPrice && !TRACK_LIMITED_VIEW ? `<div class="item"><div class="k">Final Price</div><div class="v">GH₵${escapeHtml(order.finalPrice)}${order.pointsRedeemed ? ` <span style="color:#a8d19a; font-size:0.8rem;">(${order.pointsRedeemed} points saved you GH₵${escapeHtml(order.pointsDiscount)})</span>` : ""}</div></div>` : ""}
      ${order.estimatedDelivery ? `<div class="item"><div class="k">Estimated Delivery</div><div class="v">${escapeHtml(order.estimatedDelivery)}</div></div>` : ""}
      ${order.finalPrice && !TRACK_LIMITED_VIEW ? `<div class="item"><div class="k">Payment</div><div class="v">${order.paid ? `<span class="status-pill st-Delivered"><span class="dot"></span>Paid${order.paymentMethod === "cash" ? " (Cash)" : order.paymentMethod === "points" ? " (Points)" : ""}</span>` : '<span class="status-pill st-Requested"><span class="dot"></span>Unpaid</span>'}</div></div>` : ""}
      ${order.notes && !TRACK_LIMITED_VIEW ? `<div class="item" style="grid-column:1/-1;"><div class="k">Notes</div><div class="v">${escapeHtml(order.notes)}</div></div>` : ""}
      ${order.status !== "Delivered" && !TRACK_LIMITED_VIEW ? `
        <div class="item" style="grid-column:1/-1;">
          <div class="k">Exact Location</div>
          <div class="v">
            ${order.customerLocation ? '<span style="color:#a8d19a;">📍 Pinned</span>' : '<span style="color:var(--muted);">Not pinned yet</span>'}
            <button id="track-pin-btn" class="btn btn-ghost" style="padding:6px 14px; font-size:0.68rem; margin-left:10px;" onclick="pinTrackingLocation('${order.id}')">${order.customerLocation ? "Update Pin" : "📍 Pin My Location"}</button>
          </div>
        </div>
      ` : ""}
    </div>
    ${TRACK_LIMITED_VIEW ? `<div class="empty-note" style="margin-top:20px; padding:14px; background:var(--bg-elevated); border:1px solid var(--border-soft);">Showing status only. Enter your order ID (in your confirmation email) to see full details, pay online, or pin your location.</div>` : ""}
    ${order.finalPrice && !order.paid && !TRACK_LIMITED_VIEW ? `<div style="text-align:center; margin-top:26px;"><button id="pay-now-btn" class="btn btn-solid" onclick="payNow('${order.id}')" ${PAYMENT_LOCKS.has(order.id) ? "disabled" : ""}>${PAYMENT_LOCKS.has(order.id) ? "Opening payment..." : `Pay GH₵${escapeHtml(order.finalPrice)} — Card or Mobile Money`}</button></div>` : ""}
    ${order.status === "Delivered" && !TRACK_LIMITED_VIEW ? `<div style="text-align:center; margin-top:18px;"><button class="btn btn-ghost" onclick="downloadReceipt('${order.id}')">Download Receipt (PDF)</button></div>` : ""}
    <div class="history-panel">
      <div class="history-panel-title">Status History</div>
      ${historyHtml}
    </div>
  `;

  if(!TRACK_LIMITED_VIEW){
    renderRankCard(order.email);
    if(order.driverLocation && order.status !== "Delivered"){
      renderDeliveryMap(order.driverLocation, order.assignedTo, order.customerLocation);
    }
  }
}

document.getElementById("track-input").addEventListener("keydown", (e)=>{ if(e.key === "Enter") handleTrackSearch(); });

/* ---------------- View switching ---------------- */
function isAdminAuthed(){
  return AUTH ? !!AUTH.currentUser : sessionStorage_adminAuthed;
}

function showAdmin(){
  document.getElementById("site-view").style.display = "none";
  document.getElementById("admin-view").style.display = "block";
  if(isAdminAuthed()){
    if(AUTH && AUTH.currentUser && !AUTH.currentUser.displayName){
      document.getElementById("admin-login-shell").style.display = "none";
      document.getElementById("staff-name-modal").style.display = "flex";
    }else{
      document.getElementById("admin-login-shell").style.display = "none";
      document.getElementById("admin-shell").style.display = "block";
      loadAdminOrders();
    }
  }else{
    document.getElementById("admin-login-shell").style.display = "flex";
    document.getElementById("admin-shell").style.display = "none";
  }
  window.scrollTo(0,0);
}
function showSite(){
  document.getElementById("admin-view").style.display = "none";
  document.getElementById("site-view").style.display = "block";
  window.scrollTo(0,0);
}

/* Admin login: uses real Firebase Authentication (email/password) so Firestore
   security rules can verify who's actually signed in — not just a UI gate.
   Set this up once in Firebase Console → Authentication → Sign-in method →
   enable Email/Password, then Authentication → Users → Add user with the
   email below and a password of your choosing.
   If Firebase isn't connected yet, this falls back to the local ADMIN_PASSCODE
   so the dashboard still works in local demo mode — but that fallback offers
   no real database protection, since Firestore itself isn't reachable in that mode. */
let sessionStorage_adminAuthed = false;

async function attemptAdminLogin(){
  const email = document.getElementById("admin-email").value.trim();
  const val = document.getElementById("admin-pass").value;
  const errEl = document.getElementById("admin-login-err");
  errEl.classList.remove("show");

  if(AUTH){
    if(!email){
      errEl.textContent = "Please enter your staff email.";
      errEl.classList.add("show");
      return;
    }
    try{
      await AUTH.signInWithEmailAndPassword(email, val);
      document.getElementById("admin-email").value = "";
      document.getElementById("admin-pass").value = "";

      // First-time sign-in for this account: capture a display name once,
      // so future "on the way" notifications can say who's coming, not just
      // a generic message. Stored permanently on their Firebase account.
      if(AUTH.currentUser && !AUTH.currentUser.displayName){
        document.getElementById("admin-login-shell").style.display = "none";
        document.getElementById("staff-name-modal").style.display = "flex";
        return;
      }

      document.getElementById("admin-login-shell").style.display = "none";
      document.getElementById("admin-shell").style.display = "block";
      loadAdminOrders();
    }catch(err){
      console.error("Admin sign-in failed:", err);
      errEl.textContent = "Incorrect email or password. Please try again.";
      errEl.classList.add("show");
    }
  }else{
    if(val === ADMIN_PASSCODE){
      sessionStorage_adminAuthed = true;
      document.getElementById("admin-pass").value = "";
      document.getElementById("admin-login-shell").style.display = "none";
      document.getElementById("admin-shell").style.display = "block";
      loadAdminOrders();
    }else{
      errEl.textContent = "Incorrect passcode. Please try again.";
      errEl.classList.add("show");
    }
  }
}
function getStaffName(){
  if(AUTH && AUTH.currentUser && AUTH.currentUser.displayName) return AUTH.currentUser.displayName;
  return "Our team";
}
function updateStaffBadge(){
  const badge = document.getElementById("staff-badge");
  if(!badge) return;
  if(AUTH && AUTH.currentUser){
    const name = AUTH.currentUser.displayName || AUTH.currentUser.email || "Staff";
    badge.innerHTML = `Signed in as <strong>${escapeHtml(name)}</strong>`;
  }else{
    badge.textContent = "";
  }
}
async function confirmStaffName(){
  const input = document.getElementById("staff-name-input");
  const name = input.value.trim();
  if(!name){
    input.focus();
    return;
  }
  try{
    if(AUTH.currentUser){
      await AUTH.currentUser.updateProfile({ displayName: name });
    }
  }catch(err){ console.error("Set display name failed:", err); }
  input.value = "";
  document.getElementById("staff-name-modal").style.display = "none";
  document.getElementById("admin-shell").style.display = "block";
  loadAdminOrders();
  registerPushForStaff();
}
async function adminLogout(){
  stopAdminLiveUpdates();
  if(AUTH){
    try{ await AUTH.signOut(); }catch(err){ console.error("Sign-out error:", err); }
  }
  sessionStorage_adminAuthed = false;
  showSite();
}

/* ---------------- Admin dashboard ---------------- */
let ALL_ORDERS = [];
let ACTIVE_FILTER = "All";
let EXPANDED_ID = null;

function switchAdminTab(tab){
  document.getElementById("admin-tab-orders").classList.toggle("active", tab === "orders");
  document.getElementById("admin-tab-analytics").classList.toggle("active", tab === "analytics");
  document.getElementById("admin-tab-leaderboard").classList.toggle("active", tab === "leaderboard");
  document.getElementById("admin-orders-panel").style.display = tab === "orders" ? "block" : "none";
  document.getElementById("admin-analytics-panel").style.display = tab === "analytics" ? "block" : "none";
  document.getElementById("admin-leaderboard-panel").style.display = tab === "leaderboard" ? "block" : "none";
  if(tab === "analytics") renderAnalytics();
  if(tab === "leaderboard") renderLeaderboard();
}

/* Keeps the admin dashboard live. Without this, orders are fetched once and
   cached, so a customer paying on their own phone (or another staff member
   changing a status) wouldn't appear until someone hit Refresh — which looked
   exactly like the payment had failed to save. */
let ADMIN_UNSUBSCRIBE = null;

function stopAdminLiveUpdates(){
  if(ADMIN_UNSUBSCRIBE){
    try{ ADMIN_UNSUBSCRIBE(); }catch(_){}
    ADMIN_UNSUBSCRIBE = null;
  }
}

function refreshAdminViews(){
  renderAdminStats();
  renderAdminFilters();
  renderAdminTable();
  if(document.getElementById("admin-analytics-panel").style.display !== "none"){
    renderAnalytics();
  }
  if(document.getElementById("admin-leaderboard-panel").style.display !== "none"){
    renderLeaderboard();
  }
}

function startAdminLiveUpdates(){
  if(!DB) return;
  stopAdminLiveUpdates();
  ADMIN_UNSUBSCRIBE = DB.collection("orders").orderBy("createdAt", "desc").onSnapshot(
    (snap) => {
      ALL_ORDERS = snap.docs.map(d => d.data());
      refreshAdminViews();
    },
    (err) => console.error("Admin live update error:", err)
  );
}

async function loadAdminOrders(){
  const loadingEl = document.getElementById("admin-orders-loading");
  const wrapEl = document.getElementById("admin-table-wrap");
  const emptyEl = document.getElementById("admin-empty");
  document.getElementById("demo-mode-banner").style.display = DB ? "none" : "block";
  updateStaffBadge();
  loadingEl.style.display = "block";
  wrapEl.style.display = "none";
  emptyEl.style.display = "none";

  try{
    ALL_ORDERS = await listOrders();
    refreshAdminViews();
    startAdminLiveUpdates();
  }catch(err){
    console.error("Load admin orders error:", err);
    showToast("Could not load orders: " + (err && err.message ? err.message : "please refresh"));
  }finally{
    loadingEl.style.display = "none";
  }
}

function renderAnalytics(){
  const panel = document.getElementById("admin-analytics-panel");
  const totalOrders = ALL_ORDERS.length;

  if(totalOrders === 0){
    panel.innerHTML = '<div class="empty-note">No orders yet — analytics will appear once bookings start coming in.</div>';
    return;
  }

  const paidOrders = ALL_ORDERS.filter(o => o.paid);
  const pricedUnpaid = ALL_ORDERS.filter(o => o.finalPrice && !o.paid);
  const totalRevenue = paidOrders.reduce((sum,o)=> sum + Number(o.finalPrice || 0), 0);
  const pendingRevenue = pricedUnpaid.reduce((sum,o)=> sum + Number(o.finalPrice || 0), 0);
  const avgOrderValue = paidOrders.length ? totalRevenue / paidOrders.length : 0;
  const expressCount = ALL_ORDERS.filter(o => o.express).length;
  const cashRevenue = paidOrders.filter(o => o.paymentMethod === "cash").reduce((sum,o)=> sum + Number(o.finalPrice || 0), 0);
  const onlineRevenue = paidOrders.filter(o => o.paymentMethod === "online").reduce((sum,o)=> sum + Number(o.finalPrice || 0), 0);
  const cashOrderCount = paidOrders.filter(o => o.paymentMethod === "cash").length;
  const onlineOrderCount = paidOrders.filter(o => o.paymentMethod === "online").length;

  // Orders by item type
  const typeCounts = {};
  ALL_ORDERS.forEach(o => { typeCounts[o.service] = (typeCounts[o.service] || 0) + 1; });
  const typeEntries = Object.entries(typeCounts).sort((a,b)=> b[1] - a[1]);
  const maxTypeCount = typeEntries.length ? typeEntries[0][1] : 1;

  // Orders by status
  const statusCounts = {};
  STATUSES.forEach(s => statusCounts[s] = 0);
  ALL_ORDERS.forEach(o => { if(statusCounts[o.status] !== undefined) statusCounts[o.status]++; });
  const maxStatusCount = Math.max(...Object.values(statusCounts), 1);

  // Last 7 days
  const days = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date();
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  const dayCounts = days.map(d => {
    const next = new Date(d); next.setDate(d.getDate() + 1);
    return ALL_ORDERS.filter(o => o.createdAt >= d.getTime() && o.createdAt < next.getTime()).length;
  });
  const maxDayCount = Math.max(...dayCounts, 1);

  panel.innerHTML = `
    <div class="analytics-section">
      <div class="analytics-section-title">Revenue by Payment Method</div>
      <div class="revenue-methods">
        <div class="revenue-method-card" style="border-color:rgba(111,158,92,0.4);">
          <div class="revenue-method-head">
            <span class="dot" style="background:#6f9e5c;"></span>
            <span class="revenue-method-name">Cash</span>
          </div>
          <div class="revenue-method-value" style="color:#a8d19a;">GH₵${cashRevenue.toFixed(2)}</div>
          <div class="revenue-method-sub">${cashOrderCount} order${cashOrderCount === 1 ? "" : "s"} · ${totalRevenue > 0 ? Math.round(cashRevenue / totalRevenue * 100) : 0}% of total</div>
          <div class="bar-track" style="margin-top:12px;"><div class="bar-fill" style="width:${totalRevenue > 0 ? (cashRevenue / totalRevenue * 100) : 0}%; background:#6f9e5c;"></div></div>
        </div>
        <div class="revenue-method-card" style="border-color:rgba(139,180,217,0.4);">
          <div class="revenue-method-head">
            <span class="dot" style="background:#8bb4d9;"></span>
            <span class="revenue-method-name">Paid Online</span>
          </div>
          <div class="revenue-method-value" style="color:#a9cbe8;">GH₵${onlineRevenue.toFixed(2)}</div>
          <div class="revenue-method-sub">${onlineOrderCount} order${onlineOrderCount === 1 ? "" : "s"} · ${totalRevenue > 0 ? Math.round(onlineRevenue / totalRevenue * 100) : 0}% of total</div>
          <div class="bar-track" style="margin-top:12px;"><div class="bar-fill" style="width:${totalRevenue > 0 ? (onlineRevenue / totalRevenue * 100) : 0}%; background:#8bb4d9;"></div></div>
        </div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="analytics-section-title">Combined Total</div>
      <div class="revenue-hero">
        <div class="revenue-total-equation">
          <div class="equation-part">
            <div class="equation-label">Cash</div>
            <div class="equation-value" style="color:#a8d19a;">GH₵${cashRevenue.toFixed(2)}</div>
          </div>
          <div class="equation-op">+</div>
          <div class="equation-part">
            <div class="equation-label">Online</div>
            <div class="equation-value" style="color:#a9cbe8;">GH₵${onlineRevenue.toFixed(2)}</div>
          </div>
          <div class="equation-op">=</div>
          <div class="equation-part">
            <div class="equation-label">Total Revenue Achieved</div>
            <div class="equation-value equation-total">GH₵${totalRevenue.toFixed(2)}</div>
          </div>
        </div>
      </div>
      <div class="analytics-grid" style="margin-top:14px;">
        <div class="analytics-card"><div class="n">GH₵${pendingRevenue.toFixed(2)}</div><div class="l">Pending Payment</div></div>
        <div class="analytics-card"><div class="n">GH₵${avgOrderValue.toFixed(2)}</div><div class="l">Avg Order Value</div></div>
        <div class="analytics-card"><div class="n">${expressCount}</div><div class="l">Express Orders</div></div>
      </div>
    </div>

    <div class="analytics-section">
      <div class="analytics-section-title">Orders — Last 7 Days</div>
      <div class="daily-chart">
        ${days.map((d,i)=>`
          <div class="daily-chart-col">
            <div class="daily-chart-count">${dayCounts[i]}</div>
            <div class="daily-chart-bar" style="height:${Math.max(dayCounts[i] / maxDayCount * 100, 4)}%;"></div>
            <div class="daily-chart-label">${d.toLocaleDateString(undefined, { weekday: "short" })}</div>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="analytics-section">
      <div class="analytics-cols">
        <div>
          <div class="analytics-section-title">Orders by Item Type</div>
          <div class="bar-list">
            ${typeEntries.map(([name,count])=>`
              <div class="bar-row">
                <div class="bar-row-head"><span class="name">${escapeHtml(name)}</span><span class="value">${count}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width:${count / maxTypeCount * 100}%;"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
        <div>
          <div class="analytics-section-title">Orders by Status</div>
          <div class="bar-list">
            ${STATUSES.map(s=>`
              <div class="bar-row">
                <div class="bar-row-head"><span class="name">${escapeHtml(s)}</span><span class="value">${statusCounts[s]}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width:${statusCounts[s] / maxStatusCount * 100}%;"></div></div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- Leaderboard ---------------- */
let LEADERBOARD_PERIOD = "weekly";

function switchLeaderboardPeriod(period){
  LEADERBOARD_PERIOD = period;
  renderLeaderboard();
}

function renderLeaderboard(){
  const panel = document.getElementById("admin-leaderboard-panel");
  if(!panel) return;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windowMs = LEADERBOARD_PERIOD === "daily" ? DAY
                 : LEADERBOARD_PERIOD === "weekly" ? 7 * DAY
                 : LEADERBOARD_PERIOD === "monthly" ? 30 * DAY
                 : null; // "alltime"
  const cutoff = windowMs ? now - windowMs : 0;

  const paidOrders = ALL_ORDERS.filter(o => o.paid && o.finalPrice && o.createdAt >= cutoff);

  const byCustomer = {};
  paidOrders.forEach(o => {
    const key = customerDocId(o.email);
    if(!key) return;
    if(!byCustomer[key]){
      byCustomer[key] = { email: o.email, name: o.name, total: 0, orders: 0, lastOrderAt: o.createdAt };
    }
    byCustomer[key].total += Number(o.finalPrice || 0);
    byCustomer[key].orders += 1;
    if(o.createdAt > byCustomer[key].lastOrderAt){
      byCustomer[key].name = o.name; // keep the most recent name on file
      byCustomer[key].lastOrderAt = o.createdAt;
    }
  });

  const ranked = Object.values(byCustomer).sort((a,b)=> b.total - a.total).slice(0, 10);

  // Rank badges reflect the customer's real all-time standing, not just
  // orders within the selected period — a big spender today shouldn't look
  // like a brand-new customer just because the window is narrow.
  const allTimeDeliveredCounts = {};
  ALL_ORDERS.forEach(o => {
    if(o.status !== "Delivered") return;
    const key = customerDocId(o.email);
    if(!key) return;
    allTimeDeliveredCounts[key] = (allTimeDeliveredCounts[key] || 0) + 1;
  });

  const periodLabel = { daily: "Today", weekly: "Last 7 Days", monthly: "Last 30 Days", alltime: "All Time" }[LEADERBOARD_PERIOD];

  const periodChips = ["daily","weekly","monthly","alltime"].map(p => `
    <div class="filter-chip ${LEADERBOARD_PERIOD === p ? "active" : ""}" onclick="switchLeaderboardPeriod('${p}')">${{ daily:"Daily", weekly:"Weekly", monthly:"Monthly", alltime:"All Time" }[p]}</div>
  `).join("");

  const rows = ranked.length === 0
    ? `<div class="empty-note">No paid orders in this period yet.</div>`
    : ranked.map((c, i) => {
        const key = customerDocId(c.email);
        const { tier } = getRankForCount(allTimeDeliveredCounts[key] || 0);
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i+1}`;
        return `
          <div class="leaderboard-row">
            <div class="leaderboard-rank">${medal}</div>
            <div class="leaderboard-crest" style="background:${tier.crest};"></div>
            <div class="leaderboard-info">
              <div class="leaderboard-name">${escapeHtml(c.name)}</div>
              <div class="leaderboard-sub">${escapeHtml(c.email)} · ${c.orders} order${c.orders === 1 ? "" : "s"} · <span style="color:${tier.crest};">${tier.name}</span></div>
            </div>
            <div class="leaderboard-total">GH₵${c.total.toFixed(2)}</div>
          </div>
        `;
      }).join("");

  panel.innerHTML = `
    <div class="analytics-section">
      <div class="analytics-section-title">Top Spenders — ${periodLabel}</div>
      <div class="filter-row">${periodChips}</div>
      <div class="leaderboard-list">${rows}</div>
    </div>
  `;
}

function renderAdminStats(){
  const total = ALL_ORDERS.length;
  const counts = {};
  STATUSES.forEach(s=> counts[s] = 0);
  ALL_ORDERS.forEach(o=> { if(counts[o.status] !== undefined) counts[o.status]++; });
  const cards = [
    { n: total, l: "Total Orders" },
    { n: counts["Requested"], l: "Requested" },
    { n: counts["Picked Up"] + counts["Washing"], l: "In Progress" },
    { n: counts["Ready for Delivery"], l: "Ready" },
    { n: counts["Delivered"], l: "Delivered" },
  ];
  document.getElementById("admin-stats").innerHTML = cards.map(c=>`
    <div class="stat-card"><div class="n">${c.n}</div><div class="l">${c.l}</div></div>
  `).join("");
}

function renderAdminFilters(){
  const filters = ["All", ...STATUSES];
  document.getElementById("admin-filters").innerHTML = filters.map(f=>`
    <div class="filter-chip ${ACTIVE_FILTER === f ? "active":""}" onclick="setAdminFilter('${f.replace(/'/g,"\\'")}')">${escapeHtml(f)}</div>
  `).join("");
}
function setAdminFilter(f){ ACTIVE_FILTER = f; renderAdminFilters(); renderAdminTable(); }

function renderAdminTable(){
  const wrapEl = document.getElementById("admin-table-wrap");
  const emptyEl = document.getElementById("admin-empty");
  const bodyEl = document.getElementById("admin-orders-body");

  const filtered = ACTIVE_FILTER === "All" ? ALL_ORDERS : ALL_ORDERS.filter(o=> o.status === ACTIVE_FILTER);

  if(ALL_ORDERS.length === 0){
    wrapEl.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  wrapEl.style.display = "block";

  bodyEl.innerHTML = filtered.map(o=>{
    const rows = [`
      <tr>
        <td class="oid-cell">${escapeHtml(o.id)}</td>
        <td>${escapeHtml(o.name)}<br><span style="color:var(--muted); font-size:0.75rem;">${escapeHtml(o.phone)}</span></td>
        <td>${escapeHtml(o.service)}${o.express ? '<br><span style="color:var(--gold-bright); font-size:0.72rem; letter-spacing:0.5px;">EXPRESS +GH₵100</span>' : ""}</td>
        <td>${escapeHtml(o.date)}<br><span style="color:var(--muted); font-size:0.75rem;">${escapeHtml(o.time)}</span></td>
        <td>
          <select class="status-select" onchange="updateOrderStatus('${o.id}', this.value)">
            ${STATUSES.map(s=>`<option value="${s}" ${s===o.status?"selected":""}>${s}</option>`).join("")}
          </select>
        </td>
        <td style="white-space:nowrap;">
          ${o.finalPrice
            ? (o.paid
                ? `<span class="status-pill st-Delivered"><span class="dot"></span>Paid</span>
                   <div style="font-size:0.7rem; color:var(--muted); margin-top:5px;">GH₵${escapeHtml(o.finalPrice)}${o.paymentMethod === "cash" ? " · Cash" : o.paymentMethod === "online" ? " · Online" : ""}</div>`
                : `<span class="status-pill st-Requested"><span class="dot"></span>Unpaid</span>
                   <div style="font-size:0.7rem; color:var(--muted); margin-top:5px;">GH₵${escapeHtml(o.finalPrice)} due</div>`)
            : `<span style="font-size:0.72rem; color:var(--muted);">Not priced</span>`}
        </td>
        <td style="white-space:nowrap;">
          <button class="expand-btn" onclick="toggleExpand('${o.id}')">${EXPANDED_ID === o.id ? "Hide" : "Details"}</button>
          <button class="expand-btn" style="margin-left:6px;" onclick="editOrderPricing('${o.id}')">Edit Price</button>
          ${o.finalPrice && !o.paid ? `<button class="expand-btn" style="margin-left:6px; border-color:rgba(111,158,92,0.5); color:#a8d19a;" onclick="confirmMarkPaidCash('${o.id}')">Mark Paid (Cash)</button>` : ""}
          <button class="expand-btn" style="margin-left:6px; border-color:rgba(184,84,63,0.5); color:#e0a396;" onclick="confirmDeleteOrder('${o.id}')">Delete</button>
          ${o.acceptedBy ? `<div style="font-size:0.68rem; color:var(--gold-bright); margin-top:6px;">Accepted by ${escapeHtml(o.acceptedBy)}</div>` : ""}
        </td>
      </tr>
    `];
    if(EXPANDED_ID === o.id){
      rows.push(`
        <tr class="detail-row"><td colspan="7">
          <div class="detail-grid-admin">
            <div><div class="k">Email</div><div>${escapeHtml(o.email || "—")}</div></div>
            <div><div class="k">Address</div><div>${escapeHtml(o.address)}</div></div>
            <div><div class="k">Express</div><div>${o.express ? "Yes (+GH₵100)" : "No"}</div></div>
            <div><div class="k">Booked</div><div>${escapeHtml(new Date(o.createdAt).toLocaleString())}</div></div>
            <div><div class="k">Accepted By</div><div>${o.acceptedBy ? escapeHtml(o.acceptedBy) : "—"}</div></div>
            <div><div class="k">Notes</div><div>${o.notes ? escapeHtml(o.notes) : "—"}</div></div>
            <div><div class="k">Final Price</div><div>${o.finalPrice ? `GH₵${escapeHtml(o.finalPrice)}` : "—"}${o.pointsRedeemed ? `<div style="font-size:0.7rem; color:#a8d19a; margin-top:3px;">${o.pointsRedeemed} pts off GH₵${escapeHtml(o.priceBeforePoints || "")}</div>` : ""}</div></div>
            <div><div class="k">Points</div><div>${o.pointsRedeemed ? `${o.pointsRedeemed} redeemed` : (o.redeemPointsRequested ? `<span style="color:#f0cf6d;">Customer requested</span>` : "—")}</div></div>
            <div><div class="k">Referral</div><div>${o.referredByCode ? `${escapeHtml(o.referredByCode)}${o.referralRewarded ? `<div style="font-size:0.7rem; color:#a8d19a; margin-top:3px;">Paid out ${o.referralRewardPoints} pts</div>` : `<div style="font-size:0.7rem; color:var(--muted); margin-top:3px;">Pays out on delivery</div>`}` : "—"}</div></div>
            <div><div class="k">Payment</div><div>${o.finalPrice ? (o.paid ? `Paid${o.paymentMethod === "cash" ? " (Cash)" : o.paymentMethod === "online" ? " (Online)" : o.paymentMethod === "points" ? " (Points)" : ""}` : "Unpaid") : "—"}</div></div>
            <div><div class="k">Estimated Delivery</div><div>${o.estimatedDelivery ? escapeHtml(o.estimatedDelivery) : "—"}</div></div>
          </div>
          ${o.status === "Delivered" ? `<div style="margin-top:16px;"><button class="expand-btn" onclick="downloadReceipt('${o.id}')">Download Receipt (PDF)</button></div>` : ""}
          ${o.customerLocation ? `
            <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border-soft);">
              <div class="k" style="margin-bottom:8px;">Customer's Exact Location</div>
              <div id="customer-map-${o.id}" class="delivery-map" style="height:180px; margin-bottom:10px;"></div>
              <a class="btn btn-ghost" style="padding:8px 16px; font-size:0.72rem;" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${o.customerLocation.lat},${o.customerLocation.lng}">Open in Google Maps</a>
            </div>
          ` : ""}
          ${o.status !== "Requested" && o.status !== "Delivered" ? `
            <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border-soft);">
              <div class="k" style="margin-bottom:8px;">Live Delivery Tracking</div>
              <button id="location-btn-${o.id}" class="expand-btn" onclick="toggleLocationSharing('${o.id}')">
                ${LOCATION_SHARING_ORDER_ID === o.id ? "Stop Sharing Location" : "Share My Location"}
              </button>
              <span style="font-size:0.72rem; color:var(--muted); margin-left:10px;">${LOCATION_SHARING_ORDER_ID === o.id ? "Broadcasting live — the customer sees this on their tracking page." : "Turn on while you're picking up or delivering this order."}</span>
              ${o.assignedTo ? `<div style="font-size:0.72rem; color:var(--gold-bright); margin-top:8px;">Currently assigned to: ${escapeHtml(o.assignedTo)}</div>` : ""}
            </div>
          ` : ""}
        </td></tr>
      `);
      if(o.customerLocation){
        setTimeout(() => renderCustomerLocationMap(o.id, o.customerLocation), 0);
      }
    }
    return rows.join("");
  }).join("");
}

function toggleExpand(id){
  EXPANDED_ID = EXPANDED_ID === id ? null : id;
  renderAdminTable();
}

let READY_MODAL_ORDER_ID = null;
let READY_MODAL_MODE = "statusChange"; // "statusChange" | "edit"

function updateOrderStatus(id, newStatus){
  const order = ALL_ORDERS.find(o=> o.id === id);
  if(!order) return;

  if(newStatus === "Ready for Delivery"){
    openPricingModal(id, "statusChange");
    return;
  }
  applyStatusUpdate(order, newStatus, false);
}

function editOrderPricing(id){
  openPricingModal(id, "edit");
}

/* Points the customer had available when this modal was opened, plus
   whatever this order has already taken off them. Held here so the
   redemption input can be validated without another round trip. */
let READY_MODAL_POINTS_AVAILABLE = 0;

function openPricingModal(id, mode){
  const order = ALL_ORDERS.find(o=> o.id === id);
  if(!order) return;
  READY_MODAL_ORDER_ID = id;
  READY_MODAL_MODE = mode;
  loadPointsForPricingModal(order);
  document.getElementById("ready-price").value = order.priceBeforePoints || order.finalPrice || "";
  document.getElementById("ready-eta").value = order.estimatedDelivery || "";
  document.getElementById("ready-modal-express-note").style.display = order.express ? "block" : "none";
  const errEl = document.getElementById("ready-modal-err");
  errEl.classList.remove("show"); errEl.textContent = "";
  if(mode === "edit"){
    document.getElementById("ready-modal-kicker").textContent = "Edit Order Pricing";
    document.getElementById("ready-modal-title").textContent = "Update price & delivery estimate";
  }else{
    document.getElementById("ready-modal-kicker").textContent = "Mark Ready for Delivery";
    document.getElementById("ready-modal-title").textContent = "Confirm final details";
  }
  document.getElementById("ready-modal").style.display = "flex";
}

/* Look up how many points this customer can spend. Any points this order
   already redeemed are added back to the pool, so reopening the modal to
   edit a price never double-charges the balance. */
async function loadPointsForPricingModal(order){
  const wrap = document.getElementById("ready-points-wrap");
  const input = document.getElementById("ready-points");
  const summary = document.getElementById("ready-points-summary");
  wrap.style.display = "none";
  input.value = Number(order.pointsRedeemed || 0);
  READY_MODAL_POINTS_AVAILABLE = 0;
  try{
    const stats = await getCustomerStats(order.email);
    const alreadyOnThisOrder = Number(order.pointsRedeemed || 0);
    const available = (stats.points || 0) + alreadyOnThisOrder;
    READY_MODAL_POINTS_AVAILABLE = available;
    if(available <= 0) return;

    // Below the threshold the box still shows, but read-only, so you can tell
    // the customer exactly how far off they are instead of guessing.
    if(available < POINTS_REDEEM_MINIMUM){
      summary.innerHTML = escapeHtml(order.name) + " has <strong>" + available +
        " points</strong>, below the " + POINTS_REDEEM_MINIMUM + " point minimum. They need " +
        (POINTS_REDEEM_MINIMUM - available) + " more before points can be spent.";
      input.value = 0;
      input.disabled = true;
      document.getElementById("ready-points-effect").textContent = "";
      wrap.style.display = "block";
      return;
    }

    input.disabled = false;
    summary.innerHTML = escapeHtml(order.name) + " has <strong>" + available +
      " points</strong> available, worth GH₵" + (available * POINT_VALUE_GHS) + " off this order." +
      (order.redeemPointsRequested
        ? " <span style=\"color:#a8d19a;\">They asked to use their points on this order.</span>"
        : "");
    wrap.style.display = "block";
    input.max = available;

    // The customer asked for their points at booking, so pre-fill the largest
    // amount this order can absorb. It stays editable — the final call is yours.
    if(order.redeemPointsRequested && !order.pointsRedeemed){
      const priceNow = Number(document.getElementById("ready-price").value) || 0;
      if(priceNow >= POINTS_REDEEM_MINIMUM){
        input.value = Math.min(available, Math.floor(priceNow / POINT_VALUE_GHS));
      }
    }
    updatePointsEffect();
  }catch(err){
    console.error("Load points error:", err);
  }
}

function updatePointsEffect(){
  const effect = document.getElementById("ready-points-effect");
  const priceRaw = Number(document.getElementById("ready-price").value) || 0;
  let pts = Math.floor(Number(document.getElementById("ready-points").value) || 0);
  if(pts < 0) pts = 0;
  if(pts > READY_MODAL_POINTS_AVAILABLE) pts = READY_MODAL_POINTS_AVAILABLE;
  const discount = Math.min(pts * POINT_VALUE_GHS, priceRaw);
  if(pts === 0){
    effect.style.color = "var(--muted)";
    effect.textContent = "No points applied. The customer pays the full price above.";
  }else if(pts < POINTS_REDEEM_MINIMUM){
    effect.style.color = "#e0a0a0";
    effect.textContent = "Points are redeemed in one go, " + POINTS_REDEEM_MINIMUM +
      " at a minimum. Enter 0, or " + POINTS_REDEEM_MINIMUM + " or more.";
  }else if(priceRaw < POINTS_REDEEM_MINIMUM){
    effect.style.color = "#e0a0a0";
    effect.textContent = "This order is only GH₵" + priceRaw.toFixed(2) +
      ". Points can only be spent on an order of GH₵" + POINTS_REDEEM_MINIMUM +
      " or more, so they are not wasted.";
  }else{
    effect.style.color = "var(--muted)";
    effect.innerHTML = "Applying " + pts + " points takes GH₵" + discount.toFixed(2) +
      " off. Customer pays <strong style=\"color:var(--gold-bright);\">GH₵" +
      (priceRaw - discount).toFixed(2) + "</strong>.";
  }
}

document.getElementById("ready-points").addEventListener("input", updatePointsEffect);
document.getElementById("ready-price").addEventListener("input", function(){
  // Once a price is typed, top the requested redemption up to whatever the
  // order can now absorb, so you don't have to work the arithmetic yourself.
  const order = ALL_ORDERS.find(o => o.id === READY_MODAL_ORDER_ID);
  const input = document.getElementById("ready-points");
  if(order && order.redeemPointsRequested && !input.disabled && !order.pointsRedeemed){
    const priceNow = Number(this.value) || 0;
    if(priceNow >= POINTS_REDEEM_MINIMUM){
      input.value = Math.min(READY_MODAL_POINTS_AVAILABLE, Math.floor(priceNow / POINT_VALUE_GHS));
    }else{
      input.value = 0;
    }
  }
  updatePointsEffect();
});

/* Billing confirmation popup.
   Shown whenever a customer's points are involved in an order, so the
   deduction is never applied silently. Resolves true if the admin confirms.
   The three cases it covers:
     - points are being spent  -> show the arithmetic and the balance left to collect
     - customer asked but the order is under the minimum -> explain, bill in full
     - customer asked but their balance fell short       -> explain, bill in full  */
let BILL_MODAL_RESOLVE = null;

function showBillConfirmation(order, grossPrice, pointsToUse, discount, available){
  const lines = document.getElementById("bill-lines");
  const msg = document.getElementById("bill-message");
  const due = grossPrice - discount;

  document.getElementById("bill-sub").textContent =
    order.id + " \u2014 " + order.name;

  let html = `<div class="bill-row"><div class="k">Order total</div><div class="v">GH₵${grossPrice.toFixed(2)}</div></div>`;
  if(pointsToUse > 0){
    html += `<div class="bill-row credit"><div class="k">${pointsToUse} points redeemed</div><div class="v">\u2212 GH₵${discount.toFixed(2)}</div></div>`;
    html += `<div class="bill-row"><div class="k">Points left after this</div><div class="v">${available - pointsToUse}</div></div>`;
  }
  lines.innerHTML = html;

  document.getElementById("bill-total-value").textContent = "GH₵" + due.toFixed(2);

  if(pointsToUse > 0 && due <= 0){
    document.getElementById("bill-total-label").textContent = "Nothing to collect";
    msg.className = "bill-msg";
    msg.innerHTML = "Their points cover this order in full. Nothing to collect \u2014 it will be marked <strong>Paid (Points)</strong> automatically.";
  }else if(pointsToUse > 0){
    document.getElementById("bill-total-label").textContent = "Balance to collect";
    msg.className = "bill-msg";
    msg.innerHTML = "Collect <strong>GH₵" + due.toFixed(2) + "</strong> from the customer by MoMo, card or cash. Their emailed invoice will show this amount.";
  }else if(order.redeemPointsRequested && grossPrice < POINTS_REDEEM_MINIMUM){
    document.getElementById("bill-total-label").textContent = "Amount to bill";
    msg.className = "bill-msg warn";
    msg.innerHTML = "This customer asked to use their points, but points can only be spent on an order of <strong>GH₵" +
      POINTS_REDEEM_MINIMUM + "</strong> or more. Their balance is untouched and the full amount is billed. Worth telling them why.";
  }else if(order.redeemPointsRequested && available < POINTS_REDEEM_MINIMUM){
    document.getElementById("bill-total-label").textContent = "Amount to bill";
    msg.className = "bill-msg warn";
    msg.innerHTML = "This customer asked to use their points, but they only have <strong>" + available +
      "</strong> \u2014 below the " + POINTS_REDEEM_MINIMUM + " point minimum. Their balance is untouched and the full amount is billed.";
  }else{
    document.getElementById("bill-total-label").textContent = "Amount to bill";
    msg.className = "bill-msg warn";
    msg.innerHTML = "This customer asked to use their points, but none are being applied. Check the points field before confirming.";
  }

  document.getElementById("bill-modal").style.display = "flex";
  return new Promise(function(resolve){ BILL_MODAL_RESOLVE = resolve; });
}

function closeBillModal(confirmed){
  document.getElementById("bill-modal").style.display = "none";
  if(BILL_MODAL_RESOLVE){
    const r = BILL_MODAL_RESOLVE;
    BILL_MODAL_RESOLVE = null;
    r(!!confirmed);
  }
}

function closeReadyModal(){
  document.getElementById("ready-modal").style.display = "none";
  READY_MODAL_ORDER_ID = null;
  renderAdminTable(); // restores the dropdown to the actual stored status
}

async function confirmReadyModal(){
  const id = READY_MODAL_ORDER_ID;
  const mode = READY_MODAL_MODE;
  const order = ALL_ORDERS.find(o=> o.id === id);
  const errEl = document.getElementById("ready-modal-err");
  if(!order){ closeReadyModal(); return; }

  const price = document.getElementById("ready-price").value.trim();
  const eta = document.getElementById("ready-eta").value.trim();
  if(!price || Number(price) <= 0 || !eta){
    errEl.textContent = "Please enter both a final price and an estimated delivery time.";
    errEl.classList.add("show");
    return;
  }
  errEl.classList.remove("show");

  // Work out the points side before touching the order, so a bad number
  // stops here rather than half-applying.
  let pointsToUse = Math.floor(Number(document.getElementById("ready-points").value) || 0);
  if(pointsToUse < 0) pointsToUse = 0;
  if(pointsToUse > READY_MODAL_POINTS_AVAILABLE) pointsToUse = READY_MODAL_POINTS_AVAILABLE;
  const grossPrice = Number(price);

  if(pointsToUse > 0 && pointsToUse < POINTS_REDEEM_MINIMUM){
    errEl.textContent = "Points are spent in one go, " + POINTS_REDEEM_MINIMUM +
      " at a minimum. Enter 0 to skip, or " + POINTS_REDEEM_MINIMUM + " or more.";
    errEl.classList.add("show");
    return;
  }
  if(pointsToUse > 0 && grossPrice < POINTS_REDEEM_MINIMUM){
    errEl.textContent = "Points can only be spent on an order of GH₵" + POINTS_REDEEM_MINIMUM +
      " or more. This order is GH₵" + grossPrice.toFixed(2) + ".";
    errEl.classList.add("show");
    return;
  }

  const discount = Math.min(pointsToUse * POINT_VALUE_GHS, grossPrice);
  const alreadyRedeemed = Number(order.pointsRedeemed || 0);
  const pointsDelta = pointsToUse - alreadyRedeemed;

  // Never move a customer's points without the admin seeing the arithmetic.
  if(pointsToUse > 0 || order.redeemPointsRequested){
    const ok = await showBillConfirmation(order, grossPrice, pointsToUse, discount, READY_MODAL_POINTS_AVAILABLE);
    if(!ok) return;
  }

  if(pointsDelta !== 0){
    try{
      await addPoints(order.email, -pointsDelta, 0);
    }catch(err){
      console.error("Redeem points error:", err);
      errEl.textContent = "Could not update the customer's points balance. Please try again.";
      errEl.classList.add("show");
      return;
    }
  }

  if(pointsToUse > 0){
    order.priceBeforePoints = grossPrice.toFixed(2);
    order.pointsRedeemed = pointsToUse;
    order.pointsDiscount = discount.toFixed(2);
    order.finalPrice = (grossPrice - discount).toFixed(2);

    // Points can cover the bill outright. Paystack cannot take a zero-cedi
    // charge, and there is nothing left to collect in cash either, so the
    // order is settled here and now rather than sitting forever unpaid.
    if(Number(order.finalPrice) <= 0){
      order.paid = true;
      order.paymentMethod = "points";
      showToast(order.id + " fully covered by points \u2014 marked paid");
    }
  }else{
    delete order.priceBeforePoints;
    delete order.pointsRedeemed;
    delete order.pointsDiscount;
    order.finalPrice = price;
  }
  order.estimatedDelivery = eta;
  document.getElementById("ready-modal").style.display = "none";
  READY_MODAL_ORDER_ID = null;

  if(mode === "statusChange"){
    await applyStatusUpdate(order, "Ready for Delivery", true);
  }else{
    // Standalone edit — save the new price/ETA. If the customer was already
    // notified (status is Ready for Delivery), resend so they see the update.
    try{
      await saveOrder(order);
      showToast(`${order.id} pricing updated`);
      renderAdminTable();
      if(order.status === "Ready for Delivery"){
        sendReadyForDeliveryEmail(order);
      }
    }catch(err){
      console.error("Edit pricing error:", err);
      showToast("Could not save changes: " + (err && err.message ? err.message : "please try again"));
    }
  }
}

async function applyStatusUpdate(order, newStatus, notifyReady){
  const prevStatus = order.status;
  const prevHistory = order.statusHistory ? [...order.statusHistory] : [];
  const prevAcceptedBy = order.acceptedBy;
  order.status = newStatus;
  if(!Array.isArray(order.statusHistory)) order.statusHistory = [];
  order.statusHistory.push({ status: newStatus, at: Date.now() });
  if(newStatus === "Accepted"){
    order.acceptedBy = getStaffName();
  }
  try{
    await saveOrder(order);
    showToast(`${order.id} marked as "${newStatus}"`);
    renderAdminStats();
    renderAdminTable();
    if(notifyReady){
      sendReadyForDeliveryEmail(order);
    }else if(newStatus === "Accepted" || newStatus === "Picked Up" || newStatus === "Washing" || newStatus === "Delivered"){
      sendStatusUpdateEmail(order, newStatus);
    }
    if(newStatus === "Delivered"){
      processDeliveryRewards(order);
      if(LOCATION_SHARING_ORDER_ID === order.id){
        stopLocationSharing();
      }
    }
  }catch(err){
    console.error("Update status error:", err);
    order.status = prevStatus;
    order.statusHistory = prevHistory;
    order.acceptedBy = prevAcceptedBy;
    showToast("Could not update status: " + (err && err.message ? err.message : "please try again"));
    renderAdminTable();
  }
}

function confirmDeleteOrder(id){
  if(!confirm(`Delete order ${id}? This cannot be undone.`)) return;
  deleteOrderNow(id);
}

async function deleteOrderNow(id){
  try{
    await deleteOrder(id);
    ALL_ORDERS = ALL_ORDERS.filter(o=> o.id !== id);
    if(EXPANDED_ID === id) EXPANDED_ID = null;
    renderAdminStats();
    renderAdminTable();
    showToast(`${id} deleted`);
  }catch(err){
    console.error("Delete order error:", err);
    showToast("Could not delete order: " + (err && err.message ? err.message : "please try again"));
  }
}

/* ---------------- Live delivery location sharing (admin side) ----------------
   Lets whoever is out doing the pickup/delivery (using the admin dashboard on
   their phone) broadcast their live position so the customer sees it on their
   tracking page. Uses the browser's own GPS via the Geolocation API — no
   separate driver app needed. Only one order can be actively shared at a time
   per device, matching how a small operation actually works: one person, one
   delivery in progress. */
let LOCATION_SHARING_ORDER_ID = null;
let LOCATION_WATCH_ID = null;
let LOCATION_LAST_SENT = 0;

function toggleLocationSharing(orderId){
  if(LOCATION_SHARING_ORDER_ID === orderId){
    stopLocationSharing();
  }else{
    startLocationSharing(orderId);
  }
}

async function startLocationSharing(orderId){
  if(!("geolocation" in navigator)){
    showToast("This device doesn't support location sharing.");
    return;
  }

  const staffName = getStaffName();

  // Collision check: fetch the freshest copy of this order (not the cached
  // admin table, which may be stale) to see if someone else is actively
  // sharing location on it right now.
  try{
    const fresh = await getOrder(orderId);
    if(fresh && fresh.assignedTo && fresh.assignedTo !== staffName && fresh.driverLocation && fresh.driverLocation.updatedAt){
      const secondsAgo = Math.round((Date.now() - fresh.driverLocation.updatedAt) / 1000);
      if(secondsAgo < 90){
        const proceed = confirm(`${fresh.assignedTo} is already sharing location for this order (last updated ${secondsAgo}s ago). Take over anyway?`);
        if(!proceed) return;
      }
    }
  }catch(err){ console.error("Collision check failed:", err); }

  if(LOCATION_WATCH_ID !== null){
    navigator.geolocation.clearWatch(LOCATION_WATCH_ID);
  }
  LOCATION_SHARING_ORDER_ID = orderId;
  renderAdminTable();

  const order = ALL_ORDERS.find(o => o.id === orderId);
  if(order){
    order.assignedTo = staffName;
    const direction = (order.status === "Ready for Delivery") ? "deliver your laundry" : "collect your laundry";
    sendOnTheWayEmail(order, direction, staffName);
    showToast(`Customer notified: ${staffName} is on the way to ${direction === "deliver your laundry" ? "deliver" : "pick up"}.`);
  }else{
    showToast("Requesting location permission...");
  }

  LOCATION_WATCH_ID = navigator.geolocation.watchPosition(
    async (pos) => {
      const now = Date.now();
      if(now - LOCATION_LAST_SENT < 8000) return; // throttle: at most every 8s
      LOCATION_LAST_SENT = now;
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, updatedAt: now };
      try{
        const order = ALL_ORDERS.find(o => o.id === orderId);
        if(order){
          order.driverLocation = loc;
          order.assignedTo = staffName;
          // Targeted write: the admin's cached copy of this order may be
          // seconds out of date, and a full save would wipe a payment the
          // customer just made from their own device.
          await updateOrderFields(orderId, { driverLocation: loc, assignedTo: staffName });
        }
      }catch(err){ console.error("Location update error:", err); }
    },
    (err) => {
      console.error("Geolocation error:", err);
      showToast("Could not get your location: " + (err.message || "permission denied"));
      stopLocationSharing();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function stopLocationSharing(){
  if(LOCATION_WATCH_ID !== null){
    navigator.geolocation.clearWatch(LOCATION_WATCH_ID);
    LOCATION_WATCH_ID = null;
  }
  LOCATION_SHARING_ORDER_ID = null;
  renderAdminTable();
  showToast("Location sharing stopped.");
}

function confirmMarkPaidCash(id){
  const order = ALL_ORDERS.find(o=> o.id === id);
  if(!order) return;
  if(!order.finalPrice){
    showToast("Set a final price for this order before marking it paid.");
    return;
  }
  if(!confirm(`Confirm GH₵${order.finalPrice} was collected in cash for ${id}?`)) return;
  markPaidCash(id);
}

async function markPaidCash(id){
  const order = ALL_ORDERS.find(o=> o.id === id);
  if(!order) return;

  // The admin table is live, but re-check the actual document right before
  // writing anyway — this is the same stale-cache gap as the customer's Pay
  // button, just from the staff side: if the order was paid online moments
  // ago and this tab hasn't caught up yet, this stops it being logged as a
  // second, cash, payment on top of it.
  try{
    const fresh = await getOrder(id);
    if(fresh && fresh.paid){
      showToast(id + " is already marked paid (" + (fresh.paymentMethod || "unknown method") + ") — nothing to change.");
      renderAdminTable();
      return;
    }
  }catch(err){ console.error("Pre-write payment check failed:", err); }

  const prevPaid = order.paid;
  const prevMethod = order.paymentMethod;
  const prevRef = order.paymentReference;
  order.paid = true;
  order.paymentMethod = "cash";
  order.paymentReference = "Cash (collected in person)";
  try{
    await saveOrder(order);
    showToast(`${id} marked as paid in cash`);
    renderAdminStats();
    renderAdminTable();
    if(document.getElementById("admin-analytics-panel").style.display !== "none"){
      renderAnalytics();
    }
    if(document.getElementById("admin-leaderboard-panel").style.display !== "none"){
      renderLeaderboard();
    }
    sendPaymentSuccessEmail(order);
  }catch(err){
    console.error("Mark paid (cash) error:", err);
    order.paid = prevPaid;
    order.paymentMethod = prevMethod;
    order.paymentReference = prevRef;
    showToast("Could not mark as paid: " + (err && err.message ? err.message : "please try again"));
    renderAdminTable();
  }
}

/* Auto-open tracking for links from emails, e.g. ?track=RL-4F8K2Q.
   Placed at the very end of the script so everything it depends on
   (handleTrackSearch, beginLiveTracking, TRACK_UNSUBSCRIBE) already exists —
   running this too early caused the tracking page to open blank until the
   customer manually searched again. */
(function autoReferralFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const code = normalizeReferralCode(params.get("ref"));
  if(!code) return;
  const input = document.getElementById("f-referral");
  const note = document.getElementById("f-referral-note");
  if(!input) return;
  input.value = code;
  if(note){
    note.textContent = "Referral code " + code + " applied. Once this order is delivered, your friend earns points and you get " + WELCOME_POINTS + " to spend on your next wash.";
    note.style.display = "block";
  }
  // Land the visitor on the booking form rather than the top of the page,
  // since a referral link is an invitation to book.
  setTimeout(function(){ scrollToId("booking"); }, 400);
})();

(function autoTrackFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get("track");
  if(trackId){
    document.getElementById("track-input").value = trackId;
    handleTrackSearch();
    scrollToId("track");
  }
})();

