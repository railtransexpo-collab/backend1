const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient");
const { ObjectId } = require("mongodb");
const sendTicketEmail = require("../utils/sendTicketEmail"); // centralized email + badge sender
const { verifyOtpToken } = require('../utils/otpStore');


router.use(express.json({ limit: "6mb" }));
// OTP verification helper (shared global store from otp.js)
function checkOtpToken(role, email, token) {
  if (!role || !email || !token) return false;

  const store = global._otpVerifiedStore;
  if (!store) return false;

  const key = `verified::${role}::${email.toLowerCase()}`;
  const info = store.get(key);

  if (!info || info.token !== token) return false;
  if (info.expires < Date.now()) {
    store.delete(key);
    return false;
  }

  store.delete(key); // ✅ single-use
  return true;
}

async function obtainDb() {
  try {
    if (!mongo) return null;
    if (typeof mongo.getDb === "function") return await mongo.getDb();
    if (mongo.db) return mongo.db;
    return null;
  } catch {
    return null;
  }
}

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function isEmailLike(v) {
  return typeof v === "string" && /\S+@\S+\.\S+/.test(v);
}

router.get("/", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  try {
    const rows = await db.collection("visitors").find({}).sort({ createdAt: -1 }).toArray();
    
    // ✅ Flatten: merge data object fields to root level
    const flattened = rows.map(r => {
      const flat = { ...r };
      if (flat.data && typeof flat.data === 'object') {
        for (const [key, value] of Object.entries(flat.data)) {
          if (!(key in flat) || flat[key] === undefined || flat[key] === null) {
            flat[key] = value;
          }
        }
      }
      if (flat._id) flat.id = String(flat._id);
      return flat;
    });
    
    return res.json({ success: true, data: flattened });
  } catch (err) {                                          // ✅ ADD THIS
    console.error("[visitors] list error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Failed to list visitors" });
  }
});

/**
 * GET /api/visitors/:id
 *
 * Accept ObjectId or ticket_code
 */
/**
 * GET /api/visitors/:id
 *
 * Accept ObjectId or ticket_code
 */
router.get("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  const id = req.params.id;
  let doc = null;
  const coll = db.collection("visitors");

  const oid = toObjectId(id);
  if (oid) {
    doc = await coll.findOne({ _id: oid }).catch(() => null);
  }

  if (!doc) {
    doc = await coll.findOne({ ticket_code: id }).catch(() => null);
  }
  if (!doc) return res.status(404).json({ success: false, error: "Visitor not found" });

  // ✅ Flatten data fields to root
  const flat = { ...doc };
  if (flat.data && typeof flat.data === 'object') {
    for (const [key, value] of Object.entries(flat.data)) {
      if (!(key in flat) || flat[key] === undefined || flat[key] === null) {
        flat[key] = value;
      }
    }
  }
  if (flat._id) flat.id = String(flat._id);

  return res.json(flat);
});

/**
 * POST /api/visitors
 * Create visitor and send email in background (unless added_by_admin is true).
 */
/**
 * POST /api/visitors
 * Create visitor and send email in background (ALWAYS, even if added_by_admin).
 */
router.post("/", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  try {
    const body = req.body || {};
    const form = body.form || body || {};

    const email = String(form.email || "").trim();
    if (!isEmailLike(email)) {
      return res.status(400).json({ success: false, message: "Valid email required" });
    }

    // OTP verification (SKIP for admin-created records)
    const isAdminCreate = !!body.added_by_admin;
    const verificationToken = body.verificationToken || form.verificationToken;

    if (!isAdminCreate) {
      const isValid = await verifyOtpToken(db, 'visitor', email, verificationToken);
      if (!isValid) {
        return res.status(403).json({
          success: false,
          error: "Email not verified via OTP",
        });
      }
    }

    // Generate unique ticket_code
    const coll = db.collection("visitors");
    let ticket_code = form.ticket_code;
    if (!ticket_code) {
      do {
        ticket_code = String(Math.floor(100000 + Math.random() * 900000));
      } while (await coll.findOne({ ticket_code }));
    }

    // ✅ Extract company from multiple possible locations
    let company = "";
    if (form.company) {
      company = form.company;
    } else if (form.organization) {
      company = form.organization;
    } else if (form.companyName) {
      company = form.companyName;
    } else if (form.employer) {
      company = form.employer;
    } else if (form.affiliation) {
      company = form.affiliation;
    }

    // Also check in data field if present
    if (!company && form.data && form.data.company) {
      company = form.data.company;
    }

    const doc = {
      role: "visitor",
      name: form.name || null,
      email,
      mobile: form.mobile || null,
      company: company || null,  // ✅ Root level company
      ticket_code,

      // Required for badge
      txId: form.txId || null,
      ticket_price: Number(form.ticket_price || 0),
      ticket_gst: Number(form.ticket_gst || 0),
      ticket_total: Number(form.ticket_total || 0),

      data: form,
      createdAt: new Date(),
      updatedAt: new Date(),
      added_by_admin: !!body.added_by_admin,
      admin_created_at: body.added_by_admin ? new Date(body.admin_created_at || Date.now()) : undefined,
    };

    const r = await coll.insertOne(doc);
    const insertedId = r.insertedId ? String(r.insertedId) : null;

    res.json({
      success: true,
      insertedId,
      ticket_code,
      mail: { queued: true },
    });

    // Background email send (fire-and-forget)
    (async () => {
      try {
        const savedDoc = await coll.findOne({ _id: r.insertedId });
        if (!savedDoc || !isEmailLike(savedDoc.email)) return;

        console.log(`[DEBUG] Visitor created with company: "${savedDoc.company}"`);

        const result = await sendTicketEmail({
          entity: "visitors",
          record: savedDoc,
          options: { forceSend: false, includeBadge: true },
        });

        if (result && result.success) {
          await coll.updateOne({ _id: r.insertedId }, {
            $set: { email_sent_at: new Date() },
            $unset: { email_failed: "" }
          });
        } else {
          await coll.updateOne({ _id: r.insertedId }, {
            $set: { email_failed: true, email_failed_at: new Date() }
          });
        }
      } catch (e) {
        console.error("[visitors] background email error:", e);
      }
    })();

    return;
  } catch (err) {
    console.error("[visitors] create error:", err);
    return res.status(500).json({ success: false, error: "Failed to create visitor" });
  }
});

/**
 * PUT /api/visitors/:id
 * Update visitor fields (admin/front-end edits). Returns updated doc. 
 */
router.put("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  const id = req.params.id;
  const oid = toObjectId(id);
  if (!oid) return res.status(400).json({ success: false, error: "Invalid id" });

  try {
    const fields = { ...(req.body || {}) };
    delete fields._id;
    delete fields.id;

    if (Object.keys(fields).length === 0) return res.status(400).json({ success: false, error: "No fields to update" });

    const update = {};
    for (const [k, v] of Object.entries(fields)) update[k] = v;
    update.updatedAt = new Date();

    const coll = db.collection("visitors");
    const r = await coll.updateOne({ _id: oid }, { $set: update });
    if (r.matchedCount === 0) return res.status(404).json({ success: false, error: "Visitor not found" });

    const updated = await coll.findOne({ _id: oid });
    return res.json({ success: true, saved: updated });
  } catch (err) {
    console.error("[visitors] update error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Failed to update visitor" });
  }
});

/**
 * POST /api/visitors/:id/resend-email
 *
 * IMPORTANT: this route delegates the email + badge generation to a centralized util
 * `utils/sendTicketEmail.js`. That util handles role-specific templates, attachments,
 * PDF badge generation, retries and returns a standardized result.
 *
 * The handler here updates email_sent_at/email_failed flags based on that result.
 */
router.post("/:id/resend-email", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  const oid = toObjectId(req.params.id);
  if (!oid) return res.status(400).json({ success: false, error: "Invalid ID" });

  const coll = db.collection("visitors");
  const doc = await coll.findOne({ _id: oid });
  if (!doc) return res.status(404).json({ success: false, error: "Visitor not found" });

  if (!isEmailLike(doc.email)) return res.status(400).json({ success: false, error: "Invalid email" });

  try {
    const result = await sendTicketEmail({
      entity: "visitors",
      record: doc,
    });

    if (result && result.success) {
      await coll.updateOne({ _id: oid }, { $set: { email_sent_at: new Date() }, $unset: { email_failed: "" } });
      return res.json({ success: true });
    }

    // send failed
    await coll.updateOne({ _id: oid }, { $set: { email_failed: true, email_failed_at: new Date() } });
    console.error("[visitors] resend-email failed result:", result);
    return res.status(500).json({ success: false, error: result && result.error ? result.error : "Failed to send email" });
  } catch (err) {
    console.error("[visitors] resend mail error:", err && (err.stack || err));
    await coll.updateOne({ _id: oid }, { $set: { email_failed: true, email_failed_at: new Date() } }).catch(() => { });
    return res.status(500).json({ success: false, error: "Mail send failed" });
  }
});

/**
 * DELETE /api/visitors/: id
 */
router.delete("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db) return res.status(500).json({ success: false, error: "DB not ready" });

  const id = req.params.id;
  let result = null;

  try {
    if (ObjectId.isValid(id)) result = await db.collection("visitors").deleteOne({ _id: new ObjectId(id) });
    if (!result || result.deletedCount === 0) result = await db.collection("visitors").deleteOne({ ticket_code: id });
    if (!result?.deletedCount) return res.status(404).json({ success: false });
    return res.json({ success: true });
  } catch (err) {
    console.error("[visitors] delete error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
});

module.exports = router;