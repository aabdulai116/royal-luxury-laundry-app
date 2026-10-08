// Royal Luxury Laundry — push notification worker (runs on Supabase, not Firebase).
//
// What this replaces: a Firebase Cloud Function, which needs the Blaze
// (pay-as-you-go, credit-card-required) plan just to deploy. This does the
// exact same job — read a "please notify someone" request, work out who to
// notify, send a push, clean up — but runs as a Supabase Edge Function
// instead, which has a free tier that needs no card.
//
// What did NOT change: the website, the orders, the customers, the admin
// dashboard — everything still lives in the same Firestore database it
// always has. This function only READS Firestore (to find pushRequests
// waiting to go out, and to look up a device token) and WRITES Firestore
// only to delete a pushRequest once it's handled, or clean up a dead
// staff token. It never touches an order, a customer record, or anything
// the website depends on.
//
// How it's invoked: not a live trigger (Supabase's free tier doesn't offer
// one for an external database like Firestore). Instead, a Supabase cron
// job calls this function once a minute (see SUPABASE_SETUP.md). That means
// a push can take up to ~60 seconds to arrive instead of being instant —
// still far faster than email ever was, just not real-time.
//
// Secrets this function needs (set with `supabase secrets set`, never
// committed to this file or the repo):
//   FIREBASE_SERVICE_ACCOUNT_JSON   the full JSON key for a Firebase
//                                    service account with Firestore +
//                                    Cloud Messaging access (Firebase
//                                    console → Project settings → Service
//                                    accounts → Generate new private key)
//   PUSH_WORKER_SECRET               a password you make up yourself; the
//                                    cron job must send it, so a stranger
//                                    who finds this function's URL can't
//                                    trigger it

// @deno-types="npm:@types/node"
import { initializeApp, cert, getApps } from "npm:firebase-admin@12/app";
import { getFirestore, FieldValue } from "npm:firebase-admin@12/firestore";
import { getMessaging } from "npm:firebase-admin@12/messaging";

const TEMPLATE_CUSTOMER_BOOKING = "template_h23u2z9";
const TEMPLATE_ADMIN_BOOKING = "template_r8o5uak";
const TEMPLATE_READY = "template_69qcat3";
const TEMPLATE_STATUS_UPDATE = "template_9nfhyvs";
const TEMPLATE_PAYMENT_SUCCESS = "template_rjsyggu";
const TEMPLATE_ON_THE_WAY = "template_b0pr66t";

function buildNotification(template: string, params: Record<string, any>) {
  switch (template) {
    case TEMPLATE_CUSTOMER_BOOKING:
      return {
        title: "Booking received",
        body: `${params.order_id}: pickup for ${params.service} on ${params.pickup_date} at ${params.pickup_time}. We'll keep you posted here.`,
      };
    case TEMPLATE_ADMIN_BOOKING:
      return {
        title: `New order — ${params.order_id}`,
        body: `${params.customer_name} · ${params.service} · pickup ${params.pickup_date} ${params.pickup_time} · ${params.address}`,
      };
    case TEMPLATE_READY:
      return {
        title: "Ready for delivery",
        body: `${params.order_id} is ready — total ${params.final_price}. Estimated delivery: ${params.estimated_delivery}.`,
      };
    case TEMPLATE_STATUS_UPDATE:
      return { title: "Order update", body: `${params.order_id} is now: ${params.new_status}.` };
    case TEMPLATE_PAYMENT_SUCCESS:
      return {
        title: "Payment received",
        body: `We received ${params.amount_paid} for ${params.order_id}. Reference: ${params.payment_reference}.`,
      };
    case TEMPLATE_ON_THE_WAY: {
      const verb = params.direction === "deliver your laundry" ? "deliver" : "collect";
      return { title: "On the way!", body: `${params.staff_name} is heading out to ${verb} your laundry for ${params.order_id}.` };
    }
    default:
      if (params && params.points_earned !== undefined) {
        return {
          title: "Referral reward!",
          body: `You earned ${params.points_earned} points because ${params.friend_name} completed their first order.`,
        };
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Live delivery ETA
//
// While a staff member is sharing their location on an order (the app writes
// order.driverLocation about every 8 seconds), each run of this worker works
// out how far away they are and refreshes ONE notification on the customer's
// phone: "about 9 min away". It uses the same estimate as the tracking page in
// the app (straight line distance, padded 35% for winding roads, at 20 km/h),
// so the notification and the screen always agree.
//
// The notification is replaced in place, not stacked: Android uses the same
// notification tag and iOS the same collapse id for every update on an order.
// Routine updates go to the quiet "delivery_eta" channel the app creates, so
// they don't buzz every minute; "on the way" and "arriving now" do alert.
// ---------------------------------------------------------------------------

type LatLng = { lat: number; lng: number; updatedAt?: number };

const ETA_FRESH_MS = 3 * 60 * 1000;   // ignore a driver location older than this
const ETA_CHANNEL = "delivery_eta";

function distanceKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function estimateEta(driverLoc?: LatLng, customerLoc?: LatLng) {
  if (!driverLoc || !customerLoc) return null;
  const roadKm = distanceKm(driverLoc, customerLoc) * 1.35;
  const minutes = Math.max(1, Math.round((roadKm / 20) * 60));
  return { km: roadKm, minutes, arriving: roadKm < 0.25 };
}

function etaPhrase(eta: { km: number; minutes: number }) {
  return `about ${eta.minutes} min away (${eta.km.toFixed(1)} km)`;
}

// Delivery options that make a push replace the order's previous ETA push.
function etaDelivery(orderId: string, quiet: boolean) {
  const tag = `eta-${orderId}`;
  return {
    android: {
      notification: quiet ? { tag, channelId: ETA_CHANNEL } : { tag },
    },
    apns: {
      headers: { "apns-collapse-id": tag },
      payload: { aps: quiet ? {} : { sound: "default" } },
    },
  };
}

async function liveEtaPass(db: FirebaseFirestore.Firestore, messaging: any) {
  const cutoff = Date.now() - ETA_FRESH_MS;
  const snap = await db.collection("orders").where("driverLocation.updatedAt", ">=", cutoff).get();
  let sent = 0;

  for (const doc of snap.docs) {
    const order = doc.data() as any;
    if (!order.pushToken || order.status === "Delivered") continue;
    const eta = estimateEta(order.driverLocation, order.customerLocation);
    if (!eta) continue;

    const stateRef = db.collection("etaPushState").doc(doc.id);
    const state = (await stateRef.get()).data() as any || {};
    const who = order.assignedTo || "Our team";

    let notification;
    let quiet = true;
    if (eta.arriving) {
      if (state.arrivingSent) continue;
      notification = { title: "Arriving now", body: `${who} is just outside with ${doc.id}.` };
      quiet = false;
    } else {
      if (state.lastMinutes === eta.minutes) continue;
      notification = { title: `${who} is on the way`, body: `${doc.id}: ${etaPhrase(eta)}.` };
    }

    try {
      await messaging.send({
        token: order.pushToken,
        notification,
        data: { template: "eta_update", order_id: doc.id },
        ...etaDelivery(doc.id, quiet),
      });
      sent++;
      await stateRef.set({
        lastMinutes: eta.minutes,
        arrivingSent: eta.arriving || !!state.arrivingSent,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error("send-push: ETA update failed for", doc.id, err);
    }
  }
  return sent;
}

async function resolveTargets(db: FirebaseFirestore.Firestore, template: string, params: Record<string, any>) {
  if (template === TEMPLATE_ADMIN_BOOKING) {
    const snap = await db.collection("staffTokens").get();
    return snap.docs.map((d) => d.id).filter(Boolean);
  }
  if (params && params.order_id) {
    const orderSnap = await db.collection("orders").doc(params.order_id).get();
    const token = orderSnap.exists ? (orderSnap.data() as any).pushToken : null;
    return token ? [token] : [];
  }
  if (params && params.to_email) {
    const ordersSnap = await db
      .collection("orders")
      .where("email", "==", params.to_email)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    const withToken = ordersSnap.docs.find((d) => (d.data() as any).pushToken);
    return withToken ? [(withToken.data() as any).pushToken] : [];
  }
  return [];
}

function getDb() {
  if (getApps().length === 0) {
    const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON secret is not set");
    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount) });
    // Deno's runtime (used by Supabase Edge Functions) doesn't support the
    // gRPC connection Firestore uses by default, which shows up as
    // "14 UNAVAILABLE: No connection established". Switching to a plain
    // HTTPS connection fixes it. This must be set once, right after the
    // very first time Firestore is touched.
    const db = getFirestore();
    db.settings({ preferRest: true });
    return db;
  }
  return getFirestore();
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("PUSH_WORKER_SECRET");
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || given !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = getDb();
  const messaging = getMessaging();

  const pending = await db.collection("pushRequests").orderBy("createdAt", "asc").limit(25).get();
  let sent = 0;
  let skipped = 0;

  for (const doc of pending.docs) {
    const { template, params } = doc.data() as { template: string; params: Record<string, any> };
    try {
      const notification = buildNotification(template, params || {});
      if (!notification) {
        skipped++;
        await doc.ref.delete();
        continue;
      }

      const tokens = await resolveTargets(db, template, params || {});
      if (!tokens.length) {
        skipped++;
        await doc.ref.delete();
        continue;
      }

      // "On the way": add the current ETA if the staff member's location has
      // already come in, and tag it so the live ETA updates replace it.
      let extra = {};
      if (template === TEMPLATE_ON_THE_WAY && params && params.order_id) {
        const orderSnap = await db.collection("orders").doc(params.order_id).get();
        const order = orderSnap.exists ? (orderSnap.data() as any) : null;
        const fresh = order && order.driverLocation && order.driverLocation.updatedAt >= Date.now() - ETA_FRESH_MS;
        const eta = fresh ? estimateEta(order.driverLocation, order.customerLocation) : null;
        if (eta) {
          notification.body = notification.body.replace(/\.$/, "") + ` · ${eta.arriving ? "just outside" : etaPhrase(eta)}.`;
          await db.collection("etaPushState").doc(params.order_id).set({
            lastMinutes: eta.minutes,
            arrivingSent: eta.arriving,
            updatedAt: Date.now(),
          });
        } else {
          // New trip: forget any ETA state left over from an earlier trip.
          await db.collection("etaPushState").doc(params.order_id).delete().catch(() => null);
        }
        extra = etaDelivery(params.order_id, false);
      }

      const result = await messaging.sendEachForMulticast({
        notification,
        data: { template: template || "", order_id: (params && params.order_id) || "" },
        tokens,
        ...extra,
      });
      sent += result.successCount;

      if (template === TEMPLATE_ADMIN_BOOKING) {
        await Promise.all(
          result.responses.map((r, i) => {
            if (r.success) return null;
            if (r.error?.code === "messaging/registration-token-not-registered") {
              return db.collection("staffTokens").doc(tokens[i]).delete().catch(() => null);
            }
            return null;
          }),
        );
      }
    } catch (err) {
      console.error("send-push: failed to process", doc.id, err);
    } finally {
      await doc.ref.delete().catch(() => null);
    }
  }

  let etaSent = 0;
  try {
    etaSent = await liveEtaPass(db, messaging);
  } catch (err) {
    console.error("send-push: live ETA pass failed", err);
  }

  return new Response(JSON.stringify({ checked: pending.size, sent, skipped, etaSent }), {
    headers: { "Content-Type": "application/json" },
  });
});
