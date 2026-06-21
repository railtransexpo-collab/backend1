/**
 * routes/otp.js
 *
 * OTP endpoints for registration flows.
 * - GET  /api/otp/check-email?email=...&type=...
 * - POST /api/otp/send   { value: <email>, registrationType: <role> }
 * - POST /api/otp/verify { value: <email>, otp: <code>, registrationType: <role> }
 *
 * Behavior:
 * - Checks backend for existing email (role-aware) and returns 409 on /send when email exists.
 * - Generates 6-digit OTP, stores in an in-memory Map with TTL (5 minutes) and short resend cooldown.
 * - Sends OTP email using transporter (SMTP config via env or jsonTransport fallback).
 *
 * NOTE: This file assumes a mongoClient util (getDb()/db) and nodemailer installed.
 */
const { sendMail } = require("../utils/mailer");

const { storeOtpToken } = require("../utils/otpStore");
const express = require("express");
const nodemailer = require("nodemailer");
const mongoClient = require("../utils/mongoClient"); // uses getDb() or .db

const router = express.Router();
const crypto = require("crypto");
// Add this near the top with other helpers
let dbConnectionRetries = 0;
const MAX_RETRIES = 3;

async function obtainDbWithRetry() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const db = await obtainDb();
      if (db) return db;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    } catch (err) {
      console.warn(`[otp] DB connection attempt ${i + 1} failed:`, err.message);
      if (i === MAX_RETRIES - 1) throw err;
    }
  }
  throw new Error("Could not connect to database after retries");
}
// Global store so it survives hot reloads in dev
const otpVerifiedStore =
  global._otpVerifiedStore || (global._otpVerifiedStore = new Map());

/* ---------- simple mongo helper ---------- */
async function obtainDb() {
  if (!mongoClient) throw new Error("mongoClient not available");
  if (typeof mongoClient.getDb === "function") return await mongoClient.getDb();
  if (mongoClient.db) return mongoClient.db;
  throw new Error("mongoClient has no getDb/db");
}

/* ---------- mailer setup (dev-friendly) ---------- */
function buildTransporter() {
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure =
      typeof process.env.SMTP_SECURE === "string"
        ? process.env.SMTP_SECURE.toLowerCase() === "true"
        : port === 465;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
    });
  }
  if (process.env.SMTP_SERVICE) {
    return nodemailer.createTransport({
      service: process.env.SMTP_SERVICE,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
    });
  }
  // Dev fallback: jsonTransport (no real email delivered)
  return nodemailer.createTransport({ jsonTransport: true });
}
const transporter = buildTransporter();
if (transporter && transporter.verify) {
  transporter.verify((err) => {
    if (err)
      console.warn(
        "[mailer] verify failed:",
        err && err.message ? err.message : err,
      );
    else console.log("[mailer] transporter ready");
  });
}

/* ---------- utils ---------- */
function isValidEmail(addr = "") {
  return typeof addr === "string" && /\S+@\S+\.\S+/.test(addr);
}
function normalizeEmail(e = "") {
  return String(e || "")
    .trim()
    .toLowerCase();
}
function escapeRegex(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------- OTP store & config ---------- */
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends per key
const MAX_VERIFY_ATTEMPTS = 5;
const otpStore = new Map(); // key = `${role}::${email}`

setInterval(
  () => {
    const now = Date.now();
    for (const [k, r] of otpStore.entries())
      if (!r || r.expires < now) otpStore.delete(k);
  },
  10 * 60 * 1000,
).unref();

function genOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ---------- role normalization ---------- */
function normalizeToRole(t = "") {
  if (!t) return null;
  const s = String(t).trim().toLowerCase();
  const singular = s.endsWith("s") ? s.slice(0, -1) : s;
  const map = {
    visitor: "visitor",
    exhibitor: "exhibitor",
    speaker: "speaker",
    partner: "partner",
    awardee: "awardee",
  };
  return map[singular] || null;
}

/* ---------- helper: map role -> collection ---------- */
function roleToCollection(role) {
  if (!role) return null;
  return `${role}s`; // e.g. visitor -> visitors
}
const KNOWN_COLLECTIONS = [
  "visitors",
  "exhibitors",
  "partners",
  "speakers",
  "awardees",
];

/* ---------- Mongo lookup (updated) ----------
   Behavior:
    - If registrationType (role) provided and valid -> try [roleCollection, "registrants"] only (stop on first match).
    - If no valid role provided -> try ["registrants", ...KNOWN_COLLECTIONS].
*/
async function findExistingByEmailMongo(emailRaw, registrationType) {
  try {
    const db = await obtainDbWithRetry(); // Use retry version
    if (!db) {
      console.warn("[otp] No database connection, returning null");
      return null;
    }

    const emailNorm = normalizeEmail(emailRaw);
    if (!emailNorm) return null;

    const role = normalizeToRole(registrationType);
    let collectionsToTry = [];

    if (role) {
      const roleCol = roleToCollection(role);
      collectionsToTry = [roleCol, "registrants"];
    } else {
      collectionsToTry = ["registrants", ...KNOWN_COLLECTIONS];
    }

    collectionsToTry = Array.from(new Set(collectionsToTry.filter(Boolean)));

    const regex = new RegExp(`^\\s*${escapeRegex(emailNorm)}\\s*$`, "i");
    const candidatePaths = [
      "email",
      "data.email",
      "form.email",
      "data.emailAddress",
      "data.contactEmail",
    ];

    if (process.env.DEBUG_FIND_EMAIL === "true") {
      console.debug(
        `[otp] findExistingByEmailMongo: trying collections: ${collectionsToTry.join(", ")}`,
      );
    }

    for (const colName of collectionsToTry) {
      if (!colName) continue;
      try {
        const coll = db.collection(colName);
        const q = {
          $or: candidatePaths.map((p) => {
            const obj = {};
            obj[p] = { $regex: regex };
            return obj;
          }),
        };
        if (colName === "registrants" && role) q.role = role;

        const projection = {
          _id: 1,
          ticket_code: 1,
          name: 1,
          company: 1,
          mobile: 1,
          email: 1,
          data: 1,
          form: 1,
          role: 1,
        };
        const doc = await coll.findOne(q, { projection }).catch((err) => {
          console.warn(`[otp] Query failed on ${colName}:`, err.message);
          return null;
        });

        if (!doc) continue;

        let matchedPath = null;
        let emailValue = null;
        for (const p of candidatePaths) {
          const parts = p.split(".");
          let v = doc;
          for (const part of parts) {
            if (
              v &&
              typeof v === "object" &&
              Object.prototype.hasOwnProperty.call(v, part)
            )
              v = v[part];
            else {
              v = undefined;
              break;
            }
          }
          if (
            typeof v === "string" &&
            v.trim() &&
            normalizeEmail(v) === emailNorm
          ) {
            matchedPath = p;
            emailValue = v.trim();
            break;
          }
        }
        if (!matchedPath) {
          if (doc.email) {
            matchedPath = "email";
            emailValue = String(doc.email).trim();
          } else if (doc.data && doc.data.email) {
            matchedPath = "data.email";
            emailValue = String(doc.data.email).trim();
          } else emailValue = emailNorm;
        }

        return {
          id: doc._id ? String(doc._id) : null,
          ticket_code: doc.ticket_code || null,
          emailColumn: matchedPath || null,
          emailValue: emailValue || null,
          name: doc.name || (doc.data && doc.data.name) || null,
          mobile: doc.mobile || (doc.data && doc.data.mobile) || null,
          collection: colName,
          role: doc.role || role || null,
        };
      } catch (e) {
        console.warn(
          `[otp] findExistingByEmailMongo: collection ${colName} check failed:`,
          e && e.message ? e.message : e,
        );
        continue;
      }
    }
    return null;
  } catch (err) {
    console.error(
      "[otp] findExistingByEmailMongo error:",
      err && (err.stack || err.message || err),
    );
    // Return null instead of throwing - allow registration to proceed
    return null;
  }
}
/* ---------- check-email endpoint ---------- */
router.get("/check-email", async (req, res) => {
  try {
    // Set timeout for the entire request
    req.setTimeout(10000); // 10 second timeout
    res.setTimeout(10000);

    const email = normalizeEmail(req.query.email || "");
    const registrationType = String(req.query.type || "").trim();

    console.log(
      `[otp/check-email] Request: email=${email}, type=${registrationType}`,
    );

    if (!isValidEmail(email)) {
      console.log(`[otp/check-email] Invalid email: ${email}`);
      return res.status(400).json({ success: false, error: "invalid email" });
    }

    if (!registrationType) {
      console.log(`[otp/check-email] Missing registrationType`);
      return res
        .status(400)
        .json({ success: false, error: "missing registrationType" });
    }

    // Add a timeout promise wrapper
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Database query timeout")), 8000);
    });

    const findPromise = findExistingByEmailMongo(email, registrationType);
    const info = await Promise.race([findPromise, timeoutPromise]);

    if (info) {
      console.log(`[otp/check-email] Email found: ${email}`);
      return res.json({ success: true, found: true, info });
    }

    console.log(`[otp/check-email] Email not found: ${email}`);
    return res.json({ success: true, found: false });
  } catch (err) {
    console.error(
      "[otp/check-email] error:",
      err && (err.stack || err.message || err),
    );
    // Don't return 500 - return a graceful error that frontend can handle
    return res.status(200).json({
      success: false,
      found: false,
      error: "Service temporarily unavailable, please try again",
      fallback: true,
    });
  }
});

/* ---------- POST /api/otp/send ---------- */
router.post("/send", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { value, registrationType } = req.body || {};
    if (!isValidEmail(value))
      return res
        .status(400)
        .json({ success: false, error: "Provide a valid email" });
    if (!registrationType || typeof registrationType !== "string")
      return res
        .status(400)
        .json({ success: false, error: "registrationType required" });

    const emailNorm = normalizeEmail(value);
    const regTypeRaw = String(registrationType).trim();
    const role = normalizeToRole(regTypeRaw);
    if (!role)
      return res
        .status(400)
        .json({ success: false, error: "invalid registrationType" });

    // check existing in registrants/per-role collections
    const existing = await findExistingByEmailMongo(emailNorm, role);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: "Email already exists",
        existing,
        registrationType: role,
      });
    }

    // enforce resend cooldown
    const key = `${role}::${emailNorm}`;
    const now = Date.now();
    const prev = otpStore.get(key);
    if (prev && prev.cooldownUntil && prev.cooldownUntil > now) {
      const wait = Math.ceil((prev.cooldownUntil - now) / 1000);
      return res.status(429).json({
        success: false,
        error: `Please wait ${wait}s before requesting another OTP`,
      });
    }

    // generate OTP and store
    const otp = genOtp();
    otpStore.set(key, {
      otp,
      expires: now + OTP_TTL_MS,
      attempts: 0,
      lastSentAt: now,
      cooldownUntil: now + RESEND_COOLDOWN_MS,
    });

    // build email template (text + html) per user's requested content
    const subject = "RailTrans Expo — One-Time Password (OTP)";
    const text = [
      "Dear User,",
      "",
      "Greetings from RailTrans Expo Support.",
      "",
      "To proceed with your request, please use the following One-Time Password (OTP) for verification:",
      "",
      `OTP: ${otp}`,
      "",
      "This OTP is valid for 5 minutes only.",
      "For security reasons, please do not share this OTP with anyone.",
      "",
      "If you did not initiate this request or need any assistance, please contact us immediately at support@railtransexpo.com.",
      "",
      "Thank you for choosing RailTrans Expo.",
      "",
      "Warm regards,",
      "RailTrans Expo Support Team",
      "Urban Infra Group",
      "support@railtransexpo.com",
      "https://www.railtransexpo.com",
    ].join("\n");

    const html = `<!doctype html>
<html>
  <body style="font-family:Arial,Helvetica,sans-serif;color:#111;">
    <p>Dear User,</p>

    <p>Greetings from <strong>RailTrans Expo Support</strong>.</p>

    <p>To proceed with your request, please use the following One-Time Password (OTP) for verification:</p>

    <h2 style="letter-spacing:2px;">OTP: <span style="color:#c8102e;">${otp}</span></h2>

    <p><strong>This OTP is valid for 5 minutes only.</strong><br/>
    For security reasons, please do not share this OTP with anyone.</p>

    <p>If you did not initiate this request or need any assistance, please contact us immediately at <a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a>.</p>

    <p>Thank you for choosing RailTrans Expo.</p>

    <p>Warm regards,<br/>
    RailTrans Expo Support Team<br/>
    Urban Infra Group<br/>
    📧 <a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a><br/>
    🌐 <a href="https://www.railtransexpo.com" target="_blank" rel="noopener noreferrer">www.railtransexpo.com</a></p>
  </body>
</html>`;

    // send email (may be jsonTransport in dev)
    const from =
      process.env.MAIL_FROM ||
      process.env.SMTP_USER ||
      "no-reply@railtransexpo.com";
    try {
      console.log("MAIL_FROM:", process.env.MAIL_FROM);
      console.log("SMTP_USER:", process.env.SMTP_USER);
      console.log("SMTP_HOST:", process.env.SMTP_HOST);
      const result = await sendMail({
        to: value,
        subject,
        text,
        html,
      });

      if (!result.success) {
        throw new Error(result.error);
      }
    } catch (mailErr) {
      console.error(
        "[otp/send] mail send failed:",
        mailErr && (mailErr.stack || mailErr.message || mailErr),
      );
      otpStore.delete(key);
      return res
        .status(500)
        .json({ success: false, error: "Failed to send OTP" });
    }

    return res.json({
      success: true,
      email: emailNorm,
      registrationType: role,
      otpSent: true,
      expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    });
  } catch (err) {
    console.error(
      "[otp/send] unexpected:",
      err && (err.stack || err.message || err),
    );
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- POST /api/otp/verify ---------- */
router.post("/verify", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { value, otp, registrationType } = req.body || {};
    if (!isValidEmail(value)) {
      return res
        .status(400)
        .json({ success: false, error: "Provide a valid email" });
    }
    if (!registrationType || typeof registrationType !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "registrationType required" });
    }

    const emailKey = normalizeEmail(value);
    const regTypeRaw = String(registrationType).trim();
    const role = normalizeToRole(regTypeRaw);
    if (!role)
      return res
        .status(400)
        .json({ success: false, error: "invalid registrationType" });

    const key = `${role}::${emailKey}`;
    const rec = otpStore.get(key);

    if (!rec)
      return res.json({ success: false, error: "OTP not found or expired" });

    if (rec.expires < Date.now()) {
      otpStore.delete(key);
      return res.json({ success: false, error: "OTP expired" });
    }

    if ((rec.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
      otpStore.delete(key);
      return res
        .status(429)
        .json({ success: false, error: "Too many attempts" });
    }

    const input = String(otp || "").trim();
    if (input.length !== 6 || rec.otp !== input) {
      rec.attempts = (rec.attempts || 0) + 1;
      otpStore.set(key, rec);
      return res.json({ success: false, error: "Incorrect OTP" });
    }

    // ✅ consume OTP
    otpStore.delete(key);

    // ✅ generate verification token
    const verificationToken = crypto.randomUUID();

    const db = await obtainDb();
    await storeOtpToken(db, role, emailKey, verificationToken, OTP_TTL_MS);
    console.log("[otp] Token stored in MongoDB for:", `${role}::${emailKey}`);

    try {
      const existing = await findExistingByEmailMongo(emailKey, role);

      if (existing) {
        return res.json({
          success: true,
          email: emailKey,
          registrationType: role,
          verificationToken,
          existing,
        });
      }

      return res.json({
        success: true,
        email: emailKey,
        registrationType: role,
        verificationToken,
      });
    } catch (dbErr) {
      console.error("[otp/verify] DB error:", dbErr);
      return res
        .status(500)
        .json({ success: false, error: "Server error during verification" });
    }
  } catch (err) {
    // ✅ OUTER CATCH (THIS WAS MISSING)
    console.error("[otp/verify] unexpected:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- health check ---------- */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    storeSize: otpStore.size,
    mongoAvailable: !!mongoClient,
  });
});
module.exports = router;
