const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const admin = require("firebase-admin");

dotenv.config({ path: path.join(__dirname, ".env") });

function getServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  return null;
}

function ensureFirebase() {
  if (admin.apps.length) {
    return;
  }

  const serviceAccount = getServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
    });
    return;
  }

  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || "crmdep",
  });
}

ensureFirebase();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "depcrm-notification-server" });
});

app.post("/send-trip-notification", async (req, res) => {
  try {
    const apiKey = process.env.NOTIFICATION_API_KEY || "";
    if (apiKey && req.headers["x-api-key"] !== apiKey) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const driverId = String(req.body?.driverId || "").trim();
    const requestId = String(req.body?.requestId || "").trim();
    const source = String(req.body?.source || "dashboard").trim();

    if (!driverId || !requestId) {
      return res.status(400).json({ ok: false, error: "driverId and requestId are required" });
    }

    const db = admin.firestore();
    const [driverSnap, requestSnap] = await Promise.all([
      db.collection("drivers").doc(driverId).get(),
      db.collection("requests").doc(requestId).get(),
    ]);

    if (!driverSnap.exists) {
      return res.status(404).json({ ok: false, error: "driver-not-found" });
    }

    if (!requestSnap.exists) {
      return res.status(404).json({ ok: false, error: "request-not-found" });
    }

    const driver = driverSnap.data() || {};
    const trip = requestSnap.data() || {};
    const tokens = Array.from(new Set([
      driver.fcmToken,
      ...(Array.isArray(driver.notificationTokens) ? driver.notificationTokens : []),
    ].map((token) => String(token || "").trim()).filter(Boolean)));

    if (!tokens.length) {
      return res.status(200).json({ ok: false, sent: 0, error: "missing-token" });
    }

    const title = "Nouvelle course";
    const depart = String(trip.depart || trip.pickupAddress || "").trim();
    const destination = String(trip.destination || trip.destinationAddress || "").trim();
    const motif = String(trip.motif || trip.serviceType || trip.panneType || "Course").trim();
    const phone = String(trip.phone || trip.clientPhone || trip.Phone || "").trim();
    const price = String(trip.prix ?? trip.price ?? trip.commission ?? "").trim();
    const bodyParts = [[depart, destination].filter(Boolean).join(" -> "), price ? `${price} DA` : "", phone]
      .filter(Boolean);
    const body = bodyParts.join(" | ") || motif;

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title,
        body,
      },
      android: {
        priority: "high",
        notification: {
          channelId: "trip_alerts_depson",
          sound: "depson",
          priority: "high",
          defaultVibrateTimings: true,
        },
      },
      data: {
        type: "incoming_trip",
        collection: "requests",
        requestId,
        driverId,
        source,
        title,
        body,
        depart,
        destination,
        motif,
        price,
        prix: price,
        phone,
        Phone: phone,
      },
    });

    return res.json({
      ok: response.successCount > 0,
      sent: response.successCount,
      failed: response.failureCount,
    });
  } catch (error) {
    console.error("Notification server error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "internal-server-error",
    });
  }
});

const port = Number(process.env.NOTIFICATION_API_PORT || 8787);
app.listen(port, () => {
  console.log(`Notification server listening on http://localhost:${port}`);
});
