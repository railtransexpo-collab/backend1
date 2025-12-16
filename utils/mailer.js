const nodemailer = require("nodemailer");
const mongo = require("./mongoClient");

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SERVICE,
  MAIL_FROM = "support@railtransexpo.com",
  MAIL_FROM_NAME = "RailTrans Expo",
  MAIL_REPLYTO = ""
} = process.env;

/* --- helper: obtain DB (supports mongo.getDb() async or mongo.db sync) --- */
async function obtainDb() {
  try {
    if (!mongo) return null;
    if (typeof mongo.getDb === "function") return await mongo.getDb();
    if (mongo.db) return mongo.db;
  } catch (err) {
    console.warn("[mailer] obtainDb failed:", err.message);
  }
  return null;
}


/**
 * Normalize MAIL_FROM and MAIL_FROM_NAME
 */
function parseMailFrom(envFrom, envName) {
  let email = String(envFrom || "").trim();
  let name = String(envName || "").trim();

  const angleMatch = email.match(/^(.*)<\s*([^>]+)\s*>$/);
  if (angleMatch) {
    const maybeName = angleMatch[1].replace(/(^["'\s]+|["'\s]+$)/g, "").trim();
    email = angleMatch[2].trim();
    if (!name && maybeName) name = maybeName;
  } else {
    const parts = email.split(/\s+/);
    if (parts.length === 2 && parts[1].includes("@")) {
      name = name || parts[0];
      email = parts[1];
    }
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.warn(`[mailer] Invalid MAIL_FROM email "${email}"`);
    if (SMTP_USER && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(SMTP_USER)) {
      email = SMTP_USER;
    } else {
      throw new Error("No valid sender email configured");
    }
  }

  return { email, name };
}

/* --- Build nodemailer transporter --- */
function buildTransporter() {
  if (SMTP_HOST) {
    const port = Number(SMTP_PORT || 587);
    const secure = port === 465;
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      tls: { rejectUnauthorized: process.env.NODE_ENV === "production" ? true : false },
    });
  }
  if (SMTP_SERVICE) {
    return nodemailer.createTransport({
      service: SMTP_SERVICE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
    });
  }

  // Fallback: jsonTransport for development/testing instead of throwing
  // This allows sendMail to be called in dev without SMTP configured.
  return nodemailer.createTransport({ jsonTransport: true });
}

const transporter = buildTransporter();
const FROM_INFO = parseMailFrom(MAIL_FROM, MAIL_FROM_NAME);

/**
 * verifyTransport: validate SMTP connectivity
 * returns { ok: boolean, info|error }
 */
async function verifyTransport() {
  try {
    const ok = await transporter.verify();
    console.log("[mailer] SMTP verify success:", ok);
    return { ok: true, info: ok };
  } catch (err) {
    console.error("[mailer] SMTP verify failed:", err && (err.stack || err));
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/* --- helper: reduce attachments metadata for DB --- */
function attachmentsMeta(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map(a => {
    const meta = {};
    if (a.filename) meta.filename = a.filename;
    if (a.contentType) meta.contentType = a.contentType;
    if (a.path) meta.path = a.path;
    if (a.encoding) meta.encoding = a.encoding;
    // do not store full content (could be large); record presence and length where possible
    if (a.content && Buffer.isBuffer(a.content)) meta.size = a.content.length;
    else if (typeof a.content === "string") meta.contentPreview = a.content.length > 256 ? a.content.slice(0, 256) + "..." : a.content;
    return meta;
  });
}

/**
 * Heuristic: does this string look like base64?
 */
function looksLikeBase64(s = "") {
  if (typeof s !== "string") return false;
  const t = s.replace(/\s+/g, "");
  // Basic length and charset check
  return t.length >= 8 && t.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(t);
}

/**
 * sendMail({ to, subject, text, html, attachments })
 * Sends email via nodemailer and logs the attempt into MongoDB mail_logs collection.
 * Returns { success: boolean, info?, error?, dbRecordId? }
 */
async function sendMail(opts = {}) {
  const to = opts.to;
  if (!to) {
    return { success: false, error: "Missing `to` address" };
  }

  const fromHeader = FROM_INFO.name ? `${FROM_INFO.name} <${FROM_INFO.email}>` : FROM_INFO.email;
  const envelopeFrom = FROM_INFO.email;

  // Normalize attachments for nodemailer: ensure base64 strings get encoding set
  const normalizedAttachments = (opts.attachments || []).map(a => {
    const out = {};
    if (a.filename) out.filename = a.filename;
    if (a.path) out.path = a.path;
    if (a.content) out.content = a.content;
    if (a.contentType) out.contentType = a.contentType;
    // if encoding explicitly provided, honor it; otherwise detect base64
    if (a.encoding) out.encoding = a.encoding;
    else if (typeof a.content === "string" && looksLikeBase64(a.content)) out.encoding = "base64";
    return out;
  });

  const message = {
    from: fromHeader,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject: opts.subject || "(no subject)",
    text: opts.text || undefined,
    html: opts.html || undefined,
    replyTo: MAIL_REPLYTO || FROM_INFO.email,
    attachments: normalizedAttachments.length ? normalizedAttachments : undefined,
    envelope: { from: envelopeFrom, to: Array.isArray(to) ? to : [to] },
  };

  // Prepare DB log entry (insert before send to capture intent)
  const logEntry = {
    to: Array.isArray(to) ? to : [to],
    subject: message.subject,
    text: message.text || null,
    html: message.html || null,
    attachments: attachmentsMeta(opts.attachments || []),
    envelope: message.envelope,
    from: envelopeFrom,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    sendResult: null,
  };

  let db = null;
  try {
    db = await obtainDb();
    if (db) {
      try {
        const r = await db.collection("mail_logs").insertOne(logEntry);
        logEntry._id = r.insertedId;
      } catch (e) {
        console.warn("[mailer] failed to insert mail_logs entry:", e && (e.message || e));
      }
    }
  } catch (e) {
    console.warn("[mailer] obtainDb failed for mail logging:", e && (e.message || e));
  }

  // Attempt to send
  try {
    const info = await transporter.sendMail(message);
    const resultInfo = { accepted: info.accepted || [], rejected: info.rejected || [], response: info.response, messageId: info.messageId };
    // update DB log
    try {
      if (db && logEntry._id) {
        await db.collection("mail_logs").updateOne({ _id: logEntry._id }, { $set: { status: "sent", sendResult: resultInfo, updatedAt: new Date() } });
      }
    } catch (e) {
      console.warn("[mailer] failed to update mail_logs after send:", e && (e.message || e));
    }
    console.debug("[mailer] sendMail info:", resultInfo);
    return { success: true, info: resultInfo, dbRecordId: logEntry._id || null };
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err);
    console.error("[mailer] sendMail error:", err && (err.stack || err));

    // update DB log with error
    try {
      if (db && logEntry._id) {
        await db.collection("mail_logs").updateOne({ _id: logEntry._id }, { $set: { status: "failed", sendResult: { error: errMsg }, updatedAt: new Date() } });
      }
    } catch (e) {
      console.warn("[mailer] failed to update mail_logs after error:", e && (e.message || e));
    }

    return { success: false, error: errMsg, dbRecordId: logEntry._id || null };
  }
}

/**
 * queryMailLogs(filter = {}, options = {}) - convenience to fetch logs from DB
 * - filter: Mongo filter
 * - options: { limit, skip, sort }
 */
async function queryMailLogs(filter = {}, options = {}) {
  const db = await obtainDb();
  if (!db) return { success: false, error: "database not available" };
  const col = db.collection("mail_logs");
  const cursor = col.find(filter);
  if (options.sort) cursor.sort(options.sort);
  if (options.skip) cursor.skip(options.skip);
  if (options.limit) cursor.limit(options.limit);
  const rows = await cursor.toArray();
  return { success: true, rows };
}

module.exports = { sendMail, verifyTransport, FROM_INFO, queryMailLogs };