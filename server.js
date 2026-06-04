require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const compression = require("compression");
const app = express();

// --- Ensure uploads directory exists ---
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(
  "/uploads",
  express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
      if (filePath.match(/\.(mp4)$/i))
        res.setHeader("Content-Type", "video/mp4");
      if (filePath.match(/\.(webm)$/i))
        res.setHeader("Content-Type", "video/webm");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Accept-Ranges", "bytes");
    },
  }),
);

// --- CORS (configurable) ---
const defaultOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // IRMA India frontend
  "https://www.irmaindia.com",
  "https://irmaindia.com",
  // Add backend URL for testing (optional)
  "https://influential-panda-railtransexpo-39a8c6ee.koyeb.app",
];

const envOrigins = (
  process.env.ALLOWED_ORIGINS ||
  process.env.REACT_APP_API_BASE_URL ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

/** Extra checks so IRMA / subdomains work even if exact origin string drifts */
function originAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    // Allow any IRMA India domain (www, admin, etc.)
    if (
      host === "irmaindia.com" ||
      host === "www.irmaindia.com" ||
      host.endsWith(".irmaindia.com")
    ) {
      return true;
    }
    // Allow any localhost for development
    if (host === "localhost" || host.startsWith("localhost:")) return true;
    if (host === "127.0.0.1") return true;
  } catch {
    /* ignore */
  }
  return false;
}
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[CORS DEV] Allowing origin: ${origin}`);
        return cb(null, true);
      }
      if (originAllowed(origin)) {
        console.log(`[CORS PROD] ✅ Allowing origin: ${origin}`);
        return cb(null, true);
      }
      console.log(`[CORS PROD] ❌ Blocking origin: ${origin}`);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "ngrok-skip-browser-warning",
      "X-Requested-With",
    ],
  }),
);

// --- Simple request logger ---
app.use((req, res, next) => {
  console.log(
    `[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`,
  );
  next();
});
// --- Compression for faster responses ---

app.use(
  compression({
    filter: (req, res) => {
      // Compress everything except already-compressed formats
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
    level: 6, // Balance between speed and compression
  }),
);
// --- Connect to Mongo (if used) ---
let mongoClient = null;
try {
  mongoClient = require("./utils/mongoClient");
} catch (e) {
  mongoClient = null;
}

let cachedDb = null;

async function obtainDb() {
  if (cachedDb) return cachedDb;
  if (!mongoClient) return null;
  try {
    if (typeof mongoClient.getDb === "function") {
      cachedDb = await mongoClient.getDb();
      return cachedDb;
    }
    if (mongoClient.db) {
      cachedDb = mongoClient.db;
      return cachedDb;
    }
    return null;
  } catch (err) {
    console.warn("[obtainDb] Mongo not ready:", err.message);
    return null;
  }
}

// --- Routes ---
// Load core routers (some may be SQL or Mongo variants)
let visitorsRouter = null;
let visitorConfigRouter = null;
try {
  visitorsRouter = require("./routes/visitors-mongo");
} catch (e) {
  try {
    visitorsRouter = require("./routes/visitors");
  } catch (e2) {
    visitorsRouter = null;
  }
}
try {
  visitorConfigRouter = require("./routes/visitor-config-mongo");
} catch (e) {
  try {
    visitorConfigRouter = require("./routes/visitorConfig");
  } catch (e2) {
    visitorConfigRouter = null;
  }
}

let exhibitorsRouter = null;
try {
  exhibitorsRouter = require("./routes/exhibitors-mongo");
} catch (e) {
  try {
    exhibitorsRouter = require("./routes/exhibitors");
  } catch (e2) {
    exhibitorsRouter = null;
  }
}

let exhibitorConfigRouter = null;
try {
  exhibitorConfigRouter = require("./routes/exhibitor-config-mongo");
} catch (e) {
  exhibitorConfigRouter = null;
  try {
    exhibitorConfigRouter = require("./routes/exhibitorConfig");
  } catch (e2) {
    exhibitorConfigRouter = exhibitorConfigRouter || null;
  }
}

let partnersRouter = null;
try {
  partnersRouter = require("./routes/partners-mongo");
} catch (e) {
  try {
    partnersRouter = require("./routes/partners");
  } catch (e2) {
    partnersRouter = null;
  }
}

let partnerConfigRouter = null;
{
  try {
    partnerConfigRouter = require("./routes/partnerConfig");
  } catch (e2) {
    partnerConfigRouter = null;
  }
}

let speakersRouter = null;
try {
  speakersRouter = require("./routes/speakers-mongo");
} catch (e) {
  try {
    speakersRouter = require("./routes/speakers");
  } catch (e2) {
    speakersRouter = null;
  }
}

let speakerConfigMongoRouter = null;
let speakerConfigRouter = null;
try {
  speakerConfigMongoRouter = require("./routes/speaker-config-mongo");
} catch (e) {
  speakerConfigMongoRouter = null;
}
try {
  speakerConfigRouter = require("./routes/speakerConfig");
} catch (e) {
  speakerConfigRouter = null;
}

let awardeesRouter = null;
try {
  awardeesRouter = require("./routes/awardees");
  console.log("✅ Loaded awardees router");
} catch (e) {
  console.error("❌ Failed to load awardees router:", e.message);
  console.error("   Full error:", e.stack);
  awardeesRouter = null;
}
let awardeeConfigRouter = null;
try {
  awardeeConfigRouter = require("./routes/awardee-config-mongo");
} catch (e) {
  try {
    awardeeConfigRouter = require("./routes/awardeeConfig");
  } catch (e2) {
    awardeeConfigRouter = null;
  }
}

// OTP router (log any require error to console)
const otpRouter = (() => {
  try {
    return require("./routes/otp");
  } catch (e) {
    console.error(
      "Failed to require ./routes/otp:",
      e && (e.stack || e.message || e),
    );
    return null;
  }
})();

// mailer/router require with debug
const emailRouter = (() => {
  try {
    const r = require("./routes/email");
    console.log("Loaded ./routes/email ->", !!r);
    return r;
  } catch (e) {
    console.error(
      "Failed to require ./routes/email:",
      e && (e.stack || e.message || e),
    );
    return null;
  }
})();

const paymentRouter = (() => {
  try {
    return require("./routes/payment");
  } catch (e) {
    console.warn("no payment router", e && e.message);
    return null;
  }
})();
const remindersRouter = (() => {
  try {
    return require("./routes/reminders");
  } catch (e) {
    return null;
  }
})();
const ticketsScanRouter = (() => {
  try {
    const r = require("./routes/tickets-scan");
    console.log("✅ Loaded ./routes/tickets-scan");
    return r;
  } catch (e) {
    console.error("❌ Failed to load ./routes/tickets-scan:", e.stack || e);
    return null;
  }
})();

const ticketsUpgradeRouter = (() => {
  try {
    return require("./routes/tickets-upgrade");
  } catch (e) {
    return null;
  }
})();
const imageUploadRouter = (() => {
  try {
    return require("./routes/imageUpload");
  } catch (e) {
    return null;
  }
})();

let adminRouter = null;
try {
  adminRouter = require("./routes/adminConfig");
} catch (e) {
  adminRouter = null;
}

// registration-configs router (centralized registration field configs)
const registrationConfigsRouter = (() => {
  try {
    const r = require("./routes/registration-configs");
    console.log("Loaded ./routes/registration-configs ->", !!r);
    return r;
  } catch (e) {
    console.warn(
      "No ./routes/registration-configs router found (optional).",
      e && e.message ? e.message : e,
    );
    return null;
  }
})();

// --- Coupons router (new) ---
let couponsRouter = null;
try {
  couponsRouter = require("./routes/coupons");
} catch (e) {
  couponsRouter = null;
  if (e) console.warn("No coupons router found at ./routes/coupons.js");
}

// --- ticketDownload router (mount at /api/tickets/download) ---
let ticketDownload = null;
try {
  ticketDownload = require("./routes/ticketDownload");
} catch (e) {
  ticketDownload = null;
  if (e)
    console.warn(
      "No ticketDownload router found at ./routes/ticketDownload.js",
    );
}

// --- Mount routes (always relative paths) ---
// Visitors
if (visitorsRouter) app.use("/api/visitors", visitorsRouter);
else console.warn("No visitors router found");
if (visitorConfigRouter) app.use("/api/visitor-config", visitorConfigRouter);
else console.warn("No visitor-config router found");

// Exhibitors CRUD
if (exhibitorsRouter) app.use("/api/exhibitors", exhibitorsRouter);
else console.warn("No exhibitors router found");

// exhibitor-config must be available at /api/exhibitor-config for frontend
if (exhibitorConfigRouter) {
  app.use("/api/exhibitor-config", exhibitorConfigRouter);
} else {
  console.warn(
    "No exhibitor-config router found (routes/exhibitor-config-mongo.js or routes/exhibitorConfig.js missing)",
  );
}

// Partners: partners CRUD and partner-config (ensure mounted at /api/partner-config)
if (partnersRouter) app.use("/api/partners", partnersRouter);
else console.warn("No partners CRUD router found");
if (partnerConfigRouter) {
  app.use("/api/partner-config", partnerConfigRouter);
} else {
  // Provide a safe fallback endpoint to avoid frontend 404 when router file is missing.
  console.warn(
    "No partner-config router found (routes/partner-config-mongo.js or routes/partnerConfig.js missing). Mounting fallback /api/partner-config that returns empty config.",
  );
  app.get("/api/partner-config", (req, res) =>
    res.json({ fields: [], images: [], eventDetails: {} }),
  );
}

// Speakers (CRUD)
if (speakersRouter) app.use("/api/speakers", speakersRouter);
else console.warn("No speakers router found");
// speaker-config: prefer mongo then SQL fallback at /api/speaker-config
if (speakerConfigMongoRouter)
  app.use("/api/speaker-config", speakerConfigMongoRouter);
else if (speakerConfigRouter)
  app.use("/api/speaker-config", speakerConfigRouter);
else {
  console.warn(
    "No speaker-config router found (routes/speaker-config-mongo.js or routes/speakerConfig.js missing) - mounting fallback",
  );
  app.get("/api/speaker-config", (req, res) =>
    res.json({ fields: [], images: [], eventDetails: {} }),
  );
}

// Awardees CRUD and config
if (awardeesRouter) app.use("/api/awardees", awardeesRouter);
else console.warn("No awardees CRUD router found");
if (awardeeConfigRouter) app.use("/api/awardee-config", awardeeConfigRouter);
else {
  console.warn("No awardee-config router found - mounting fallback");
  app.get("/api/awardee-config", (req, res) =>
    res.json({ fields: [], images: [], eventDetails: {} }),
  );
}

// Coupons
if (couponsRouter) {
  app.use("/api/coupons", couponsRouter);
  console.log("Mounted /api/coupons");
} else {
  console.warn("No coupons router found (routes/coupons.js missing)");
}

// Other API routes (mount if available)
if (otpRouter) app.use("/api/otp", otpRouter);
if (paymentRouter) app.use("/api/payment", paymentRouter);
// Default small limit for most routes
app.use(express.json({ limit: "1mb" }));

// Larger limit only for upload routes
app.use("/api/upload", express.json({ limit: "20mb" }));
app.use("/api/image", express.json({ limit: "20mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  }),
);
// Mount email router at both /api/email and /api/mailer to match frontend calls
if (emailRouter) {
  app.use("/api/email", emailRouter);
  app.use("/api/mailer", emailRouter); // <--- ensure /api/mailer resolves
  console.log("Mounted email router at /api/email and /api/mailer");
} else {
  console.warn("No email/mailer router found (routes/email.js missing)");
}

if (remindersRouter) app.use("/api/reminders", remindersRouter);

// ✅ CRITICAL: Mount /api/tickets/download BEFORE /api/tickets
// Mount ticketDownload FIRST (most specific route)
if (ticketDownload) {
  app.use("/api/tickets/download", ticketDownload);
  console.log("✅ Mounted /api/tickets/download");
} else {
  console.warn(
    "⚠️  No ticketDownload router (routes/ticketDownload.js missing) - email download buttons will not work",
  );
}

// Then mount general /api/tickets routes (these catch everything else under /api/tickets/*)
if (ticketsScanRouter) app.use("/api/tickets", ticketsScanRouter);
if (ticketsUpgradeRouter) app.use("/api/tickets", ticketsUpgradeRouter);
// Mount image/upload routes at /api so frontend calls like /api/upload-asset and /api/upload-file resolve correctly.
if (imageUploadRouter) app.use("/api", imageUploadRouter);
else
  console.warn("No image upload router found (routes/imageUpload.js missing)");

if (adminRouter) app.use("/api", adminRouter);

// Registration configs router (new centralized registration field configs)
if (registrationConfigsRouter) {
  app.use("/api/registration-configs", registrationConfigsRouter);
  console.log("Mounted /api/registration-configs");
} else {
  console.warn(
    "No registration-configs router found - frontend will fallback to per-endpoint config sources.",
  );
}

// --- Unified configs route (new) ---
let configsRouter = null;
try {
  configsRouter = require("./routes/configs");
} catch (e) {
  configsRouter = null;
  console.warn(
    "No configs router found at ./routes/configs.js; falling back to in-file handlers for event-details.",
  );
}
if (configsRouter) {
  app.use("/api/configs", configsRouter);
  console.log("Mounted /api/configs");
}

// --- Backwards-compatible event-details endpoints (use unified configs collection if configsRouter missing or in addition) ---
app.get("/api/event-details", async (req, res) => {
  try {
    // prefer reading via DB directly, using obtainDb
    const db = await obtainDb();
    if (!db)
      return res
        .status(200)
        .json({ name: "", date: "", venue: "", time: "", tagline: "" });
    const col = db.collection("app_configs");
    const doc = await col.findOne({ key: "event-details" });
    if (!doc || !doc.value)
      return res.json({ name: "", date: "", venue: "", time: "", tagline: "" });
    return res.json(doc.value);
  } catch (err) {
    console.error("GET /api/event-details error", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to read event details" });
  }
});

app.post("/api/event-details/config", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, message: "database not available" });
    const payload = req.body || {};
    const col = db.collection("app_configs");
    const update = {
      $set: { key: "event-details", value: payload, updatedAt: new Date() },
    };
    await col.updateOne({ key: "event-details" }, update, { upsert: true });
    const after = await col.findOne({ key: "event-details" });
    // notify via server logs; frontend listeners are triggered by client dispatch after save
    return res.json({
      success: true,
      key: after.key,
      value: after.value,
      updatedAt: after.updatedAt,
    });
  } catch (err) {
    console.error(
      "POST /api/event-details/config error",
      err && (err.stack || err),
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to save event details" });
  }
});

// If configsRouter is mounted, also provide a small convenience alias for GET/POST event-details to configs route (redirect style)
if (configsRouter) {
  // keep compatibility but prefer DB-backed handlers above; we keep these for clear routing if needed
  app.get("/api/configs/event-details", (req, res, next) => {
    // letting configsRouter handle it (mounted at /api/configs)
    next();
  });
}

// --- Health & root ---
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("API server is running"));

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && (err.stack || err));
  if (err && /Not allowed by CORS/.test(String(err.message || ""))) {
    return res.status(403).json({ error: "CORS denied" });
  }
  res
    .status(err?.status || 500)
    .json({ error: err?.message || "server error" });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;

(async function start() {
  try {
    if (mongoClient) {
      const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
      const MONGO_DB = process.env.MONGO_DB || "railtrans_expo";
      try {
        await mongoClient.connect(MONGO_URI, MONGO_DB);
        console.log("Connected to MongoDB:", MONGO_URI, MONGO_DB);
      } catch (err) {
        console.warn("Failed to connect to MongoDB:", err);
      }
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running at port ${PORT}`);
      setInterval(
        async () => {
          try {
            const db = await obtainDb();
            if (!db) {
              console.log("[reminder-sender] DB not available, skipping");
              return;
            }

            // ✅ FIXED REMINDER DATES
            const today = new Date();
            const todayStr = today.toISOString().split("T")[0];
            const reminderDates = ["2026-06-27", "2026-06-29"];

            if (!reminderDates.includes(todayStr)) {
              console.log(
                `[reminder-sender] ${todayStr} - Not a reminder date. Skipping.`,
              );
              return;
            }

            console.log(
              `[reminder-sender] ${todayStr} - REMINDER DATE! Sending tickets...`,
            );

            const sendTicketEmail = require("./utils/sendTicketEmail");

            // Find all pending reminders
            const reminders = await db
              .collection("scheduled_reminders")
              .find({
                status: "pending",
              })
              .toArray();

            console.log(
              `[reminder-sender] Found ${reminders.length} pending reminders`,
            );

            let sent = 0;
            let failed = 0;

            for (const reminder of reminders) {
              try {
                const { ObjectId } = require("mongodb");
                let record = null;

                try {
                  record = await db.collection(reminder.entity).findOne({
                    _id: new ObjectId(reminder.entityId),
                  });
                } catch {
                  record = await db.collection(reminder.entity).findOne({
                    ticket_code: reminder.entityId,
                  });
                }

                if (!record || !record.email) {
                  console.log(
                    `[reminder-sender] No record for ${reminder.entity}/${reminder.entityId}`,
                  );
                  await db
                    .collection("scheduled_reminders")
                    .updateOne(
                      { _id: reminder._id },
                      { $set: { status: "skipped", updatedAt: new Date() } },
                    );
                  continue;
                }

                console.log(
                  `[reminder-sender] Sending ticket to ${record.email} (${reminder.entity})`,
                );

                const result = await sendTicketEmail({
                  entity: reminder.entity,
                  record: record,
                  options: { forceSend: true, includeBadge: true },
                });

                if (result?.success) {
                  await db
                    .collection("scheduled_reminders")
                    .updateOne(
                      { _id: reminder._id },
                      {
                        $set: {
                          status: "sent",
                          sentAt: new Date(),
                          updatedAt: new Date(),
                        },
                      },
                    );
                  await db
                    .collection(reminder.entity)
                    .updateOne(
                      { _id: record._id },
                      {
                        $set: { ticket_email_sent_at: new Date() },
                        $unset: { ticket_email_failed: "" },
                      },
                    );
                  sent++;
                  console.log(
                    `[reminder-sender] ✅ Ticket sent to ${record.email}`,
                  );
                } else {
                  failed++;
                  console.error(
                    `[reminder-sender] ❌ Failed for ${record.email}:`,
                    result?.error,
                  );
                }
              } catch (e) {
                failed++;
                console.error(
                  `[reminder-sender] Error: ${reminder.entity}/${reminder.entityId}:`,
                  e.message,
                );
              }
            }

            console.log(
              `[reminder-sender] Done: ${sent} sent, ${failed} failed`,
            );
          } catch (e) {
            console.error("[reminder-sender] Error:", e.message);
          }
        },
        60 * 60 * 1000,
      ); // Check every 1 hour (so it catches the reminder dates)

      console.log(
        "[reminder-sender] Started (runs every 24h, sends ticket emails with badges)",
      );
      console.log(
        "Allowed CORS origins:",
        allowedOrigins.length ? allowedOrigins : "all (dev)",
      );
      // Log mounted route availability to help debug 404s
      console.log("Route status:");
      console.log(
        " - /api/visitor-config ->",
        visitorConfigRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/partner-config ->",
        partnerConfigRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/exhibitor-config ->",
        exhibitorConfigRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/speaker-config ->",
        speakerConfigMongoRouter || speakerConfigRouter
          ? "mounted"
          : "fallback/none",
      );
      console.log(
        " - /api/awardee-config ->",
        awardeeConfigRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/registration-configs ->",
        registrationConfigsRouter ? "mounted" : "fallback/none",
      );
      console.log(" - /api/otp ->", otpRouter ? "mounted" : "fallback/none");
      console.log(
        " - /api/mailer ->",
        emailRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/configs ->",
        configsRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/coupons ->",
        couponsRouter ? "mounted" : "fallback/none",
      );
      console.log(
        " - /api/tickets/download ->",
        ticketDownload ? "mounted" : "fallback/none",
      );
      if (process.env.REACT_APP_API_BASE_URL)
        console.log(
          "Front-end API base env:",
          process.env.REACT_APP_API_BASE_URL,
        );
    });
  } catch (e) {
    console.error("Failed to start server", e && (e.stack || e));
    process.exit(1);
  }
})();
