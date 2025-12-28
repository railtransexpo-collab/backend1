const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient"); // should export getDb() or .db
const { ObjectId } = require("mongodb");
const mailer = require("../utils/mailer"); // expects sendMail(opts) -> { success, info?, error?, dbRecordId? }

// optional safeFieldName from your schema utils
let safeFieldName = null;
try {
  safeFieldName = require("../utils/mongoSchemaSync").safeFieldName;
} catch (e) {
  /* optional */
}

router.use(express.json({ limit: "6mb" }));

/* ---------- helpers ---------- */
async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function generateTicketCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function loadAdminFields(db, pageName = "visitor") {
  try {
    const col = db.collection("registration_configs");
    const doc = await col.findOne({ page: pageName });
    const fields = doc && doc.config && Array.isArray(doc.config.fields) ? doc.config.fields : [];
    const safeNames = new Set();
    for (const f of fields) {
      if (!f || !f.name) continue;
      const raw = String(f.name).trim();
      if (!raw) continue;
      const sn = typeof safeFieldName === "function"
        ? safeFieldName(raw)
        : raw.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
      if (sn) safeNames.add(sn);
    }
    return { fields, safeNames };
  } catch (e) {
    return { fields: [], safeNames: new Set() };
  }
}

/* pick first sensible string from object using candidate keys */
function pickFirstString(obj, candidates = []) {
  if (!obj || typeof obj !== "object") return "";
  for (const cand of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, cand)) {
      const v = obj[cand];
      if (typeof v === "string" && v.trim()) return v.trim();
      if ((typeof v === "number" || typeof v === "boolean") && String(v).trim()) return String(v).trim();
    }
    // case-insensitive key match
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === String(cand).toLowerCase()) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
        if ((typeof v === "number" || typeof v === "boolean") && String(v).trim()) return String(v).trim();
      }
    }
  }
  // deep scan
  for (const v of Object.values(obj)) {
    if (!v) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      if (typeof v.email === "string" && v.email.trim()) return v.email.trim();
      if (typeof v.mobile === "string" && v.mobile.trim()) return v.mobile.trim();
      if (typeof v.phone === "string" && v.phone.trim()) return v.phone.trim();
      if (typeof v.name === "string" && v.name.trim()) return v.name.trim();
      if (typeof v.company === "string" && v.company.trim()) return v.company.trim();
    }
  }
  return "";
}

/* Try to require server-side buildTicketEmail if present */
let serverBuildTicketEmail = null;
try {
  const tmpl = require("../utils/emailTemplate");
  if (tmpl && typeof tmpl.buildTicketEmail === "function") serverBuildTicketEmail = tmpl.buildTicketEmail;
} catch (e) {
  serverBuildTicketEmail = null;
}

/* Minimal server-side email builder fallback */
function buildSimpleTicketEmail({ frontendBase = "", entity = "visitors", id = "", name = "", ticket_code = "" } = {}) {
  const fb = String(frontendBase || process.env.FRONTEND_BASE || "").replace(/\/$/, "");
  const downloadUrl = fb
    ? `${fb}/ticket-download?entity=${encodeURIComponent(entity)}&${id ? `id=${encodeURIComponent(String(id))}` : `ticket_code=${encodeURIComponent(String(ticket_code || ""))}`}`
    : `ticket_download_unavailable`;

  const subject = `RailTrans Expo — Your e-badge & ticket`;
  const text = [
    `Hello ${name || "Participant"},`,
    "",
    `Thank you for registering for RailTrans Expo.`,
    ticket_code ? `Your ticket code: ${ticket_code}` : "",
    `Download your e-badge: ${downloadUrl}`,
    "",
    "Regards,",
    "RailTrans Expo Team",
  ].filter(Boolean).join("\n");

  const html = `<p>Hello ${name || "Participant"},</p>
<p>Thank you for registering for RailTrans Expo.</p>
${ticket_code ? `<p><strong>Your ticket code:</strong> ${ticket_code}</p>` : ""}
<p><a href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download your e-badge</a></p>
<p>Regards,<br/>RailTrans Expo Team</p>`;

  return { subject, text, html };
}

/* ---------- Routes ---------- */

/**
 * POST /api/visitors
 * Save visitor dynamically based on admin-configured fields,
 * preserve raw form at data, generate ticket_code if needed,
 * attempt to send email server-side (prefer serverBuildTicketEmail if available),
 * return saved doc + mail result.
 */

// GET /api/visitors
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, message: "Database not available" });

    const coll = db.collection("visitors");

    // Optionally: add filters / pagination
    const visitors = await coll
      .find({})
      .sort({ createdAt: -1 }) // latest first
      .toArray();

    return res.json({ success: true, data: visitors });
  } catch (err) {
    console.error("[visitors] GET error", err);
    return res.status(500).json({ success: false, message: "Database error", details: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, message: "database not available" });

    const coll = db.collection("visitors");
    const body = req.body || {};
    const form = body._rawForm || body.form || body || {};

    // determine friendly name / email / mobile from common keys (dynamic)
    const name = body.name || pickFirstString(form, ["name", "fullName", "contactName", "firstName", "first_name", "firstname"]) || "";
    const email = String(body.email || form.email || form.emailAddress || pickFirstString(form, ["email", "emailAddress", "contactEmail"])) || "";
    const mobile = body.mobile || form.mobile || form.phone || pickFirstString(form, ["mobile", "phone", "contact", "contactNumber", "mobileNumber"]) || "";

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Valid email is required." });
    }

    // generate or pick ticket code
    const ticket_code = body.ticket_code || form.ticket_code || generateTicketCode();

    // base doc: minimal top-level fixed fields only
    const doc = {
      role: "visitor",
      data: form,
      name: name || null,
      email: email || null,
      mobile: mobile || null,
      ticket_code: ticket_code || null,
      status: "new",
      createdAt: new Date(),
      updatedAt: new Date(),
      // preserve admin marker if admin added it
      added_by_admin: !!body.added_by_admin,
      admin_created_at: body.added_by_admin ? (body.admin_created_at || new Date().toISOString()) : undefined,
    };

    // Promote only admin-configured fields (dynamic)
    try {
      const { safeNames } = await loadAdminFields(db, "visitor");
      for (const [k, v] of Object.entries(form || {})) {
        if (!k) continue;
        const sn = typeof safeFieldName === "function"
          ? safeFieldName(k)
          : String(k).trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
        if (!sn) continue;
        if (safeNames.has(sn)) {
          // avoid reserved keys
          if (["role", "data", "createdAt", "updatedAt", "_id"].includes(sn)) continue;
          doc[sn] = v === undefined ? null : v;
        }
      }
    } catch (e) {
      console.warn("[visitors] promote admin fields error:", e && (e.stack || e));
    }

    // insert into DB
    const result = await coll.insertOne(doc);
    const insertedId = result && result.insertedId ? String(result.insertedId) : null;

    // ensure ticket_code persisted
    if (doc.ticket_code && result && result.insertedId) {
      try {
        await coll.updateOne({ _id: result.insertedId }, { $set: { ticket_code: doc.ticket_code } });
      } catch (e) { /* ignore */ }
    }

    // build createdDoc to return (include promoted keys for UI convenience)
    const createdDoc = {
      id: insertedId,
      _id: insertedId,
      name: doc.name,
      email: doc.email,
      ticket_code: doc.ticket_code,
      added_by_admin: !!doc.added_by_admin,
      // include promoted fields (choose to return only safe promoted names)
    };

    // attach promoted fields to createdDoc for immediate UI use
    try {
      const { safeNames } = await loadAdminFields(db, "visitor");
      for (const sn of safeNames) {
        if (Object.prototype.hasOwnProperty.call(doc, sn)) createdDoc[sn] = doc[sn];
      }
    } catch (e) {
      // ignore
    }

    // Attempt to send email server-side (try serverBuildTicketEmail if available)
    let mailResult = null;
    try {
      const frontendBase = process.env.FRONTEND_BASE || "";
      if (serverBuildTicketEmail) {
        // build full template server-side if available
        try {
          const model = {
            frontendBase,
            entity: "visitors",
            id: insertedId,
            name: doc.name || "",
            company: doc.company || doc.org || "",
            ticket_category: doc.ticket_category || "",
            badgePreviewUrl: "",
            downloadUrl: "",
            logoUrl: "",
            form: doc.data || {},
            pdfBase64: null,
          };
          const tpl = await serverBuildTicketEmail(model);
          const mailOpts = { to: email, subject: tpl.subject || "RailTrans Expo", text: tpl.text || "", html: tpl.html || "", attachments: tpl.attachments || [] };
          const sendRes = await mailer.sendMail(mailOpts);
          if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
          else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : "send failed", dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
        } catch (e) {
          // fallback to simple send
          const minimal = buildSimpleTicketEmail({ frontendBase, entity: "visitors", id: insertedId, name: doc.name || "", ticket_code: doc.ticket_code || "" });
          const sendRes = await mailer.sendMail({ to: email, subject: minimal.subject, text: minimal.text, html: minimal.html, attachments: [] });
          if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
          else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : "send failed", dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
        }
      } else {
        const minimal = buildSimpleTicketEmail({ frontendBase, entity: "visitors", id: insertedId, name: doc.name || "", ticket_code: doc.ticket_code || "" });
        const sendRes = await mailer.sendMail({ to: email, subject: minimal.subject, text: minimal.text, html: minimal.html, attachments: [] });
        if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
        else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : "send failed", dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
      }
    } catch (mailErr) {
      mailResult = { ok: false, error: String(mailErr && (mailErr.message || mailErr)) };
    }

    return res.json({
      success: true,
      message: "Visitor registered successfully.",
      insertedId,
      ticket_code: doc.ticket_code || null,
      saved: createdDoc,
      mail: mailResult,
    });
  } catch (err) {
    console.error("[visitors] POST error", err && (err.stack || err));
    return res.status(500).json({
      success: false,
      message: "Database error",
      details: String(err && err.message ? err.message : err),
    });
  }
});



module.exports = router;