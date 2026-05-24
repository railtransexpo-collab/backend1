const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const mongo = require("../utils/mongoClient"); // must expose getDb() or . db
const { sendMail } = require("../utils/mailer"); // keep existing mailer
const sendTicketEmail = require("../utils/sendTicketEmail"); // centralized ticket email + badge sender
const mailer = require("../utils/mailer");
const { verifyOtpToken } = require("../utils/otpStore");

// parse JSON bodies for all routes in this router
router.use(express.json({ limit: "5mb" }));

function generateTicketCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

/**
 * Helper:  safe ObjectId parse
 */
function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Helper: basic email sanity check
 */
function isEmailLike(v) {
  return typeof v === "string" && /\S+@\S+\.\S+/.test(v);
}

/**
 * Build the acknowledgement email body (text + html)
 * and return { subject, text, html, from?  }.
 * This is the DEFAULT ACK EMAIL (no ticket, no badge).
 */
function buildExhibitorAckEmail({ name = "" } = {}) {
  const subject = "Exhibitor request received — RailTrans Expo";
  const text = `Hello ${name},

Thank you for showing your interest and choosing to be a part of RailTrans Expo. We truly appreciate your decision to connect with us and explore exhibiting opportunities at our platform.

We are pleased to confirm that your exhibitor request has been received.  Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps.

Regards,
RailTrans Expo Team
support@railtransexpo. com
`;

  const html = `<p>Hello ${name},</p>
<p>Thank you for showing your interest and choosing to be a part of <strong>RailTrans Expo</strong>. <br> We truly appreciate your decision to connect with us and explore exhibiting opportunities at our platform.</p>

<p>We are pleased to confirm that your exhibitor request has been <strong>successfully received</strong>. <br>Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps.</p>

<p>Regards,<br/>
<strong>RailTrans Expo Team</strong><br/>
<a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a>
</p>`;

  const from =
    process.env.MAIL_FROM || `RailTrans Expo <support@railtransexpo.com>`;
  return { subject, text, html, from };
}

/**
 * POST /api/exhibitors/step
 */
router.post("/step", async (req, res) => {
  try {
    console.debug("[exhibitors] step snapshot:", req.body);
    return res.json({ success: true });
  } catch (err) {
    console.error("[exhibitors] step error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to record step" });
  }
});

/**
 * POST /api/exhibitors
 * Create exhibitor (MongoDB implementation)
 *
 * NOTE: Default ACK EMAIL is sent in background (no ticket, no badge) ALWAYS,
 * even if created by admin. Admin creation is tracked via added_by_admin flag.
 */

router.post("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const col = db.collection("exhibitors");

    const body = req.body || {};

    // OTP verification (skip if admin-created)
    if (!body.added_by_admin) {
      const email = (body.email || "").toString().trim();
      const verificationToken = body.verificationToken;

      console.log("[exhibitors] OTP verification - email:", email);
      console.log("[exhibitors] OTP verification - token:", verificationToken);

      if (!isEmailLike(email)) {
        return res
          .status(400)
          .json({ success: false, error: "Valid email required" });
      }

      // ✅ EXACT same pattern as visitors.js
      const isValid = await verifyOtpToken(
        db,
        "exhibitor",
        email,
        verificationToken,
      );

      if (!isValid) {
        return res
          .status(403)
          .json({ success: false, error: "Email not verified via OTP" });
      }
      console.log("[exhibitors] OTP verification PASSED");
    }

    function pickValue(obj, keys) {
      for (const key of keys) {
        const value = obj[key];
        if (
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ""
        ) {
          return String(value).trim();
        }
      }
      return "";
    }

    const companyVal = pickValue(body, [
      "companyName",
      "company",
      "company_name",
      "companyname",
      "organization",
      "org",
    ]);
    const otherVal = pickValue(body, [
      "other",
      "other_company",
      "otherCompany",
    ]);

    if (!companyVal && !otherVal) {
      return res
        .status(400)
        .json({ success: false, error: "companyName is required" });
    }

    const FIELD_MAP = {
      surname: "surname",
      name: "name",
      email: "email",
      mobile: "mobile",
      designation: "designation",
      category: "category",
      spaceType: "space_type",
      space_size: "space_size",
      stall_size: "stall_size",
      stall_type: "stall_type",
      type_of_space: "type_of_space",
      boothType: "boothType",
      productDetails: "productDetails",
      product_category: "product_category",
      product_details: "product_details",
      notes: "notes",
      address: "address",
    };
    // After the FIELD_MAP loop, add any remaining fields dynamically
    for (const [key, value] of Object.entries(body)) {
      if (
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
      ) {
        // Skip already mapped fields
        const alreadyMapped =
          Object.values(FIELD_MAP).includes(key) ||
          key === "company" ||
          key === "other" ||
          key === "added_by_admin" ||
          key === "verificationToken";
        if (!alreadyMapped && !(key in doc)) {
          doc[key] =
            typeof value === "object"
              ? JSON.stringify(value)
              : String(value).trim();
        }
      }
    }
    const doc = {};
    for (const [inputKey, docKey] of Object.entries(FIELD_MAP)) {
      const val =
        body[inputKey] !== undefined
          ? body[inputKey]
          : body[inputKey.toLowerCase()] !== undefined
            ? body[inputKey.toLowerCase()]
            : undefined;
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        doc[docKey] =
          typeof val === "object" ? JSON.stringify(val) : String(val).trim();
      }
    }

    // ✅ Store company at root level
    doc.company = companyVal || "";
    if (otherVal) doc.other = otherVal;

    doc.added_by_admin = !!body.added_by_admin;
    if (doc.added_by_admin) {
      doc.admin_created_at = body.admin_created_at
        ? new Date(body.admin_created_at)
        : new Date();
    }

    doc.status = "pending";
    doc.created_at = new Date();
    doc.updated_at = new Date();

    let ticket_code = body.ticket_code;
    if (!ticket_code) {
      do {
        ticket_code = generateTicketCode();
      } while (await col.findOne({ ticket_code }));
    }
    doc.ticket_code = ticket_code;

    const insertRes = await col.insertOne(doc);
    const insertedId =
      insertRes && insertRes.insertedId ? String(insertRes.insertedId) : null;

    res.status(201).json({
      success: true,
      insertedId,
      id: insertedId,
      mail: { queued: true },
    });

    // Background email
    (async () => {
      try {
        if (!insertedId) return;
        const saved = await col.findOne({ _id: toObjectId(insertedId) });
        if (!saved) return;

        console.log(
          `[DEBUG] Exhibitor created with company: "${saved.company}"`,
        );

        const to = saved.email || body.email || null;
        if (to && isEmailLike(to)) {
          const mail = buildExhibitorAckEmail({ name: saved.name });
          try {
            await mailer.sendMail({
              to: saved.email,
              subject: mail.subject,
              text: mail.text,
              html: mail.html,
              from: mail.from,
            });
            console.log("[exhibitors] ack mail sent to", saved.email);
            await col.updateOne(
              { _id: toObjectId(insertedId) },
              {
                $unset: { email_failed: "", email_failed_at: "" },
                $set: { email_sent_at: new Date() },
              },
            );
          } catch (e) {
            console.error(
              "[exhibitors] ack mail failed:",
              e && (e.message || e),
            );
            await col.updateOne(
              { _id: toObjectId(insertedId) },
              {
                $set: { email_failed: true, email_failed_at: new Date() },
              },
            );
          }
        }
      } catch (e) {
        console.error("[exhibitors] background email error:", e);
      }
    })();

    return;
  } catch (err) {
    console.error("[exhibitors] register error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Server error registering exhibitor" });
  }
});
/**
 * POST /api/exhibitors/: id/resend-email
 *
 * THIS ENDPOINT MUST ONLY SEND THE TICKET EMAIL (badge, QR, etc).
 * It delegates to utils/sendTicketEmail so template and badge are centralized.
 */
router.post("/:id/resend-email", async (req, res) => {
  try {
    const id = req.params.id;
    console.debug("[exhibitors] resend-email called for id=", id);
    if (!id)
      return res.status(400).json({ success: false, error: "missing id" });

    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    const oid = toObjectId(id);
    if (!oid)
      return res.status(400).json({ success: false, error: "invalid id" });

    const col = db.collection("exhibitors");
    const doc = await col.findOne({ _id: oid });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, error: "exhibitor not found" });

    const email =
      doc.email ||
      (doc.data && (doc.data.email || doc.data.emailAddress)) ||
      "";
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res
        .status(400)
        .json({ success: false, error: "no valid email on record" });
    }

    try {
      const result = await sendTicketEmail({
        entity: "exhibitors",
        record: doc,
        options: { forceSend: true, includeBadge: true },
      });

      if (result && result.success) {
        await col.updateOne(
          { _id: oid },
          {
            $set: { ticket_email_sent_at: new Date() },
            $unset: { ticket_email_failed: "" },
          },
        );
        return res.json({
          success: true,
          mail: { ok: true, info: result.info || null },
        });
      } else {
        await col.updateOne(
          { _id: oid },
          {
            $set: {
              ticket_email_failed: true,
              ticket_email_failed_at: new Date(),
            },
          },
        );
        return res.status(500).json({
          success: false,
          mail: {
            ok: false,
            error: result && result.error ? result.error : "ticket_send_failed",
          },
        });
      }
    } catch (e) {
      console.error(
        "[exhibitors] resend-email send error:",
        e && (e.stack || e),
      );
      try {
        await col.updateOne(
          { _id: oid },
          {
            $set: {
              ticket_email_failed: true,
              ticket_email_failed_at: new Date(),
            },
          },
        );
      } catch {}
      return res.status(500).json({
        success: false,
        mail: { ok: false, error: "Failed to send ticket email" },
      });
    }
  } catch (err) {
    console.error(
      "[exhibitors] resend-email error:",
      err && (err.stack || err),
    );
    return res
      .status(500)
      .json({ success: false, error: "Server error resending email" });
  }
});

/* ---------- Read / Update / Delete ---------- */

/**
 * GET /api/exhibitors
 */
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });
    const col = db.collection("exhibitors");
    const rows = await col
      .find({})
      .sort({ created_at: -1 })
      .limit(2000)
      .toArray();
    return res.json(
      rows.map((r) => {
        const copy = { ...r };
        if (copy._id) {
          copy.id = String(copy._id);
        }
        return copy;
      }),
    );
  } catch (err) {
    console.error("Fetch exhibitors (mongo) error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch exhibitors" });
  }
});

/**
 * GET /api/exhibitors/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ error: "invalid id" });
    const col = db.collection("exhibitors");
    const doc = await col.findOne({ _id: oid });
    if (!doc) return res.status(404).json({ error: "not found" });
    const copy = { ...doc };
    if (copy._id) {
      copy.id = String(copy._id);
    }
    return res.json(copy);
  } catch (err) {
    console.error("Fetch exhibitor (mongo) error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch exhibitor" });
  }
});

/**
 * PUT /api/exhibitors/:id
 */
router.put("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const oid = toObjectId(req.params.id);
    if (!oid)
      return res.status(400).json({ success: false, error: "invalid id" });

    const fields = { ...(req.body || {}) };
    delete fields.id;
    delete fields._id;

    if (Object.keys(fields).length === 0)
      return res
        .status(400)
        .json({ success: false, error: "No fields to update" });

    const update = { ...fields, updated_at: new Date() };

    const col = db.collection("exhibitors");
    const r = await col.updateOne({ _id: oid }, { $set: update });
    if (r.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Exhibitor not found" });

    const saved = await col.findOne({ _id: oid });
    const out = { ...saved };
    if (out._id) out.id = String(out._id);

    return res.json({ success: true, saved: out });
  } catch (err) {
    console.error("Exhibitor update (mongo) error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to update exhibitor" });
  }
});

/**
 * DELETE /api/exhibitors/: id
 */
router.delete("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const oid = toObjectId(req.params.id);
    if (!oid)
      return res.status(400).json({ success: false, error: "invalid id" });
    const col = db.collection("exhibitors");
    const r = await col.deleteOne({ _id: oid });
    if (r.deletedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Exhibitor not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Exhibitor delete (mongo) error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to delete exhibitor" });
  }
});

/* ---------- Approve / Cancel (status emails only) ---------- */

/**
 * POST /api/exhibitors/: id/approve
 */
router.post("/:id/approve", async (req, res) => {
  const id = req.params.id;
  const admin =
    req.body && req.body.admin ? String(req.body.admin) : "web-admin";
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });

  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const col = db.collection("exhibitors");

    const oid = toObjectId(id);
    if (!oid)
      return res.status(400).json({ success: false, error: "invalid id" });

    const updateDoc = {
      status: "approved",
      updated_at: new Date(),
      approved_by: admin,
      approved_at: new Date(),
    };

    const r = await col.updateOne({ _id: oid }, { $set: updateDoc });
    if (r.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Exhibitor not found" });

    const updated = await col.findOne({ _id: oid });
    const copy = { ...updated };
    if (copy._id) {
      copy.id = String(copy._id);
    }

    // respond quickly
    res.json({ success: true, id, updated: copy });

    // Background: send approval status email (NO ticket, NO badge)
    if (copy && isEmailLike(copy.email)) {
      (async () => {
        try {
          const to = copy.email;
          const name = copy.name || copy.company || "";
          const mail = {
            subject: `Your exhibitor request has been approved — RailTrans Expo`,
            text: `Hello ${name},

Your exhibitor registration (ID: ${copy.id}) has been approved. Our team will contact you with next steps. 

Regards,
RailTrans Expo Team
support@railtransexpo.com`,
            html: `<p>Hello ${name},</p><p>Your exhibitor registration (ID:  <strong>${copy.id}</strong>) has been <strong>approved</strong>.</p>`,
          };
          await sendMail({
            to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          });
        } catch (e) {
          console.error(
            "[exhibitors] approval email error:",
            e && (e.stack || e),
          );
        }
      })();
    }

    // notify admins (background)
    (async () => {
      try {
        const adminEnv =
          process.env.EXHIBITOR_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "";
        const toAddrs = adminEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!toAddrs.length) return;
        const subject = `Exhibitor approved — ID: ${updated ? updated._id : id}`;
        const text = `Exhibitor approved\nID: ${updated ? updated._id : id}\nName: ${updated ? updated.name || updated.company || "" : ""}\nEmail: ${updated ? updated.email : ""}`;
        const html = `<p>Exhibitor approved</p><pre>${JSON.stringify(updated || {}, null, 2)}</pre>`;
        await Promise.all(
          toAddrs.map((addr) =>
            sendMail({ to: addr, subject, text, html }).catch((e) =>
              console.error(
                "[exhibitors] admin email error:",
                addr,
                e && (e.message || e),
              ),
            ),
          ),
        );
      } catch (e) {
        console.error("[exhibitors] admin notify error:", e && (e.stack || e));
      }
    })();

    return;
  } catch (err) {
    console.error(
      "Approve exhibitor (mongo) error:",
      err && (err.stack || err),
    );
    return res.status(500).json({
      success: false,
      error:
        err && err.message ? err.message : "Server error approving exhibitor",
    });
  }
});

/**
 * POST /api/exhibitors/: id/cancel
 */
router.post("/:id/cancel", async (req, res) => {
  const id = req.params.id;
  const admin =
    req.body && req.body.admin ? String(req.body.admin) : "web-admin";
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });

  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });
    const col = db.collection("exhibitors");

    const oid = toObjectId(id);
    if (!oid)
      return res.status(400).json({ success: false, error: "invalid id" });

    const updateDoc = {
      status: "cancelled",
      updated_at: new Date(),
      cancelled_by: admin,
      cancelled_at: new Date(),
    };

    const r = await col.updateOne({ _id: oid }, { $set: updateDoc });
    if (r.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Exhibitor not found" });

    const updated = await col.findOne({ _id: oid });
    const copy = { ...updated };
    if (copy._id) {
      copy.id = String(copy._id);
    }

    res.json({ success: true, id, updated: copy });

    // Background: send cancel status email (NO ticket, NO badge)
    if (copy && isEmailLike(copy.email)) {
      (async () => {
        try {
          const to = copy.email;
          const name = copy.name || copy.company || "";
          const mail = {
            subject: `Your exhibitor registration has been cancelled — RailTrans Expo`,
            text: `Hello ${name},

Your exhibitor registration (ID: ${copy.id}) has been cancelled. If you believe this is an error, contact support@railtransexpo. com.

Regards,
RailTrans Expo Team`,
            html: `<p>Hello ${name},</p><p>Your exhibitor registration (ID:  <strong>${copy.id}</strong>) has been <strong>cancelled</strong>.</p>`,
          };
          await sendMail({
            to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          });
        } catch (e) {
          console.error(
            "[exhibitors] cancel email error:",
            e && (e.stack || e),
          );
        }
      })();
    }

    // notify admins (background)
    (async () => {
      try {
        const adminEnv =
          process.env.EXHIBITOR_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "";
        const toAddrs = adminEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!toAddrs.length) return;
        const subject = `Exhibitor cancelled — ID: ${updated ? updated._id : id}`;
        const text = `Exhibitor cancelled\nID: ${updated ? updated._id : id}\nName: ${updated ? updated.name || updated.company || "" : ""}\nEmail: ${updated ? updated.email : ""}`;
        const html = `<p>Exhibitor cancelled</p><pre>${JSON.stringify(updated || {}, null, 2)}</pre>`;
        await Promise.all(
          toAddrs.map((addr) =>
            sendMail({ to: addr, subject, text, html }).catch((e) =>
              console.error(
                "[exhibitors] admin cancel notify error:",
                addr,
                e && (e.message || e),
              ),
            ),
          ),
        );
      } catch (e) {
        console.error(
          "[exhibitors] admin cancel notify error:",
          e && (e.stack || e),
        );
      }
    })();

    return;
  } catch (err) {
    console.error("Cancel exhibitor (mongo) error:", err && (err.stack || err));
    return res.status(500).json({
      success: false,
      error:
        err && err.message ? err.message : "Server error cancelling exhibitor",
    });
  }
});

module.exports = router;
