const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient"); // should export getDb() or .db
const { ObjectId } = require("mongodb");

// reuse safeFieldName if available to normalize admin field names
let safeFieldName = null;
try {
  safeFieldName = require("../utils/mongoSchemaSync").safeFieldName;
} catch (e) {
  /* optional */
}

router.use(express.json({ limit: "5mb" }));

/**
 * obtainDb()
 * Accept both mongo.getDb() (async) and mongo.db sync shapes.
 */
async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") {
    const db = await mongo.getDb();
    return db;
  }
  if (mongo.db) return mongo.db;
  return null;
}

function pick(v, keys) {
  for (const k of keys)
    if (v && Object.prototype.hasOwnProperty.call(v, k)) return v[k];
  return undefined;
}

function generateTicketCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * loadAdminFields(pageName)
 * Loads admin configured fields from registration_configs collection and
 * returns a Set of safe (normalized) names and the original fields array.
 */
async function loadAdminFields(db, pageName = "visitor") {
  try {
    const col = db.collection("registration_configs");
    const doc = await col.findOne({ page: pageName });
    const fields =
      doc && doc.config && Array.isArray(doc.config.fields)
        ? doc.config.fields
        : [];
    const safeNames = new Set();
    for (const f of fields) {
      if (!f || !f.name) continue;
      const name = String(f.name).trim();
      if (!name) continue;
      const sn =
        typeof safeFieldName === "function"
          ? safeFieldName(name)
          : name
              .toLowerCase()
              .replace(/[\s-]+/g, "_")
              .replace(/[^a-z0-9_]/g, "");
      if (sn) safeNames.add(sn);
    }
    return { fields, safeNames };
  } catch (e) {
    return { fields: [], safeNames: new Set() };
  }
}

/**
 * POST /api/visitors
 * Save a visitor into registrants collection (role: 'visitor')
 * - stores raw form under data
 * - promotes admin-configured fields to top-level normalized keys for easy querying
 */
router.post("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, message: "database not available" });

    const coll = db.collection("visitors");
    const body = req.body || {};
    const form = body._rawForm || body.form || body || {};

    const nameRaw =
      body.name ??
      form.name ??
      (form.firstName && form.lastName
        ? `${form.firstName} ${form.lastName}`
        : "");

    const name =
      typeof nameRaw === "string"
        ? nameRaw.trim()
        : String(nameRaw || "").trim();

    const emailRaw = body.email ?? form.email ?? form.emailAddress ?? "";
    const email =
      typeof emailRaw === "string"
        ? emailRaw.trim()
        : String(emailRaw || "").trim();

    const mobileRaw = body.mobile ?? form.mobile ?? form.phone ?? "";
    const mobile =
      typeof mobileRaw === "string"
        ? mobileRaw.trim()
        : String(mobileRaw || "").trim();

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res
        .status(400)
        .json({ success: false, message: "Valid email is required." });
    }

    const ticket_code =
      body.ticket_code || form.ticket_code || generateTicketCode();

    // Base document
    const doc = {
      role: "visitor",
      data: form, // preserve full raw form
      name: name || null,
      email: email || null,
      mobile: mobile || null,
      ticket_code: ticket_code || null,
      ticket_category: body.ticket_category || form.ticket_category || null,
      ticket_price: Number(body.ticket_price || form.ticket_price || 0) || 0,
      ticket_gst: Number(body.ticket_gst || form.ticket_gst || 0) || 0,
      ticket_total: Number(body.ticket_total || form.ticket_total || 0) || 0,
      txId: body.txId || form.txId || null,
      payment_proof_url:
        body.payment_proof_url || form.payment_proof_url || null,
      status: "new",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Promote admin-configured fields to top-level normalized keys if present in submission
    try {
      const { safeNames } = await loadAdminFields(db, "visitor");
      for (const [k, v] of Object.entries(form || {})) {
        if (!k) continue;
        const sn =
          typeof safeFieldName === "function"
            ? safeFieldName(k)
            : String(k)
                .trim()
                .toLowerCase()
                .replace(/[\s-]+/g, "_")
                .replace(/[^a-z0-9_]/g, "");
        if (!sn) continue;
        // only promote keys that are in admin configured safe names
        if (safeNames.has(sn)) {
          // avoid clobbering reserved top-level fields
          if (["role", "data", "createdAt", "updatedAt", "_id"].includes(sn))
            continue;
          doc[sn] = v === undefined ? null : v;
        }
      }
    } catch (e) {
      // non-fatal: if admin-config load fails, we still insert raw form
      console.warn(
        "[visitors] failed to promote admin fields:",
        e && (e.stack || e)
      );
    }

    const r = await coll.insertOne(doc);
    const insertedId = r && r.insertedId ? String(r.insertedId) : null;

    return res.json({
      success: true,
      message: "Visitor registered successfully.",
      insertedId,
      ticket_code: doc.ticket_code || null,
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

router.post("/step", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const col = db.collection("steps");
    const payload = { ...req.body, createdAt: new Date() };
    try {
      await col.insertOne(payload);
    } catch (e) {
      console.warn("[visitors] step insert failed", e && e.message);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("[visitors] /step error", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to save step" });
  }
});

/**
 * GET /api/visitors
 * Query params: q (search), limit, skip
 */
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });

    const coll = db.collection("visitors");
    const q = (req.query.q || "").trim();
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(req.query.limit || "200", 10))
    );
    const skip = Math.max(0, parseInt(req.query.skip || "0", 10));

    const filter = { role: "visitor" };
    if (q) {
      filter.$or = [
        { email: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { ticket_code: { $regex: q, $options: "i" } },
        { "data.email": { $regex: q, $options: "i" } },
        { "data.name": { $regex: q, $options: "i" } },
      ];
    }

    const cursor = coll
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const rows = await cursor.toArray();
    const out = rows.map((r) => {
      const copy = { ...r };
      if (copy._id) {
        copy.id = String(copy._id);
        delete copy._id;
      }
      return copy;
    });
    return res.json(out);
  } catch (err) {
    console.error("[visitors] GET error", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch visitors" });
  }
});

/**
 * GET /api/visitors/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });

    const coll = db.collection("visitors");
    const id = req.params.id;
    const q = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    q.role = "visitor";
    const doc = await coll.findOne(q);
    if (!doc) return res.status(404).json({ error: "Visitor not found" });
    const copy = { ...doc };
    if (copy._id) {
      copy.id = String(copy._id);
      delete copy._id;
    }
    return res.json(copy);
  } catch (err) {
    console.error("[visitors] GET/:id error", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch visitor" });
  }
});

/**
 * DELETE /api/visitors/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    const coll = db.collection("visitors");
    const id = req.params.id;
    const q = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    q.role = "visitor";
    const r = await coll.deleteOne(q);
    if (!r.deletedCount)
      return res
        .status(404)
        .json({ success: false, error: "Visitor not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("[visitors] DELETE error", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to delete visitor" });
  }
});

/**
 * POST /api/visitors/:id/confirm
 * Update allowed fields; do NOT overwrite ticket_code unless force=true
 * Also accepts admin-configured normalized fields (safe names).
 */
router.post("/:id/confirm", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    const coll = db.collection("visitors");
    const id = req.params.id;
    const payload = { ...(req.body || {}) };
    const force = !!payload.force;
    delete payload.force;

    const q = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    q.role = "visitor";
    const doc = await coll.findOne(q);
    if (!doc)
      return res
        .status(404)
        .json({ success: false, error: "Visitor not found" });

    // base whitelist
    const baseWhitelist = new Set([
      "ticket_code",
      "ticket_category",
      "txId",
      "email",
      "name",
      "company",
      "mobile",
      "designation",
      "slots",
    ]);

    // include admin-configured safe names
    try {
      const { safeNames } = await loadAdminFields(db, "visitor");
      for (const sn of safeNames) baseWhitelist.add(sn);
    } catch (e) {
      // ignore
    }

    const update = {};
    for (const k of Object.keys(payload || {})) {
      // accept if in whitelist or if normalized safeName is in whitelist
      if (baseWhitelist.has(k)) {
        update[k] = payload[k];
        continue;
      }
      const sn =
        typeof safeFieldName === "function"
          ? safeFieldName(k)
          : String(k)
              .trim()
              .toLowerCase()
              .replace(/[\s-]+/g, "_")
              .replace(/[^a-z0-9_]/g, "");
      if (sn && baseWhitelist.has(sn)) {
        update[sn] = payload[k];
      }
    }

    // ticket_code defensive handling
    if ("ticket_code" in update) {
      const incoming = update.ticket_code
        ? String(update.ticket_code).trim()
        : "";
      const existingCode = doc.ticket_code
        ? String(doc.ticket_code).trim()
        : "";
      if (!incoming) delete update.ticket_code;
      else if (existingCode && !force && incoming !== existingCode)
        delete update.ticket_code;
    }

    if (Object.keys(update).length === 0) {
      const copy = { ...doc };
      if (copy._id) {
        copy.id = String(copy._id);
        delete copy._id;
      }
      return res.json({
        success: true,
        updated: copy,
        note: "No changes applied (ticket_code protected)",
      });
    }

    update.updatedAt = new Date();
    await coll.updateOne({ _id: doc._id }, { $set: update });
    const after = await coll.findOne({ _id: doc._id });
    const copyAfter = { ...after };
    if (copyAfter._id) {
      copyAfter.id = String(copyAfter._id);
      delete copyAfter._id;
    }
    return res.json({ success: true, updated: copyAfter });
  } catch (err) {
    console.error("[visitors] POST confirm error", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to update visitor" });
  }
});

module.exports = router;
