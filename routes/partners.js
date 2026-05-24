const express = require("express");
const router = express.Router();
const mailer = require("../utils/mailer");
const { ObjectId } = require("mongodb");
const mongo = require("../utils/mongoClient");
const { sendMail } = require("../utils/mailer");
const sendTicketEmail = require("../utils/sendTicketEmail"); // centralized ticket email + badge sender
const { verifyOtpToken } = require("../utils/otpStore");
// parse JSON bodies for this router
router.use(express.json({ limit: "5mb" }));
function generateTicketCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function buildPartnerAckEmail({ name = "", company = "" } = {}) {
  const subject = "RailTrans Expo — Partner Request Received";

  const text = `Hello ${name || company || "Partner"},

Thank you for your interest in partnering with RailTrans Expo. 

We have received your details and our team will review your request. 
You will hear from us shortly.

Regards,
RailTrans Expo Team
support@railtransexpo.com
`;

  const html = `
<p>Hello ${name || company || "Partner"},</p>
<p>Thank you for your interest in partnering with <strong>RailTrans Expo</strong>.</p>
<p>We have received your details and our team will review your request.  You will hear from us shortly.</p>
<p>Regards,<br/>
<strong>RailTrans Expo Team</strong><br/>
<a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a>
</p>`;

  return {
    subject,
    text,
    html,
    from: process.env.MAIL_FROM || "RailTrans Expo <support@railtransexpo.com>",
  };
}

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function isEmailLike(v) {
  return typeof v === "string" && /\S+@\S+\.\S+/.test(v);
}

function docToOutput(doc) {
  if (!doc) return null;
  const out = { ...(doc || {}) };
  if (out._id) {
    out.id = String(out._id);
  }
  return out;
}

/* BigInt-safe JSON conversion (keeps interface compatibility) */
function convertBigIntForJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(convertBigIntForJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = convertBigIntForJson(v);
    return out;
  }
  return value;
}

/* ---------------- routes ---------------- */

/**
 * POST /api/partners/step
 */
router.post("/step", async (req, res) => {
  try {
    console.debug("[partners] step snapshot:", req.body);
    return res.json({ success: true });
  } catch (err) {
    console.error("[partners] step error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to record step" });
  }
});

/**
 * POST /api/partners
 * Register partner (Mongo-backed)
 *
 * IMPORTANT: Default ACK email is sent in background ONLY if added_by_admin is false.
 * This is the "DEFAULT ACK EMAIL" (no ticket, no badge).
 */

router.post("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    const body = req.body || {};

    const pick = (cands) => {
      for (const k of cands) {
        if (
          Object.prototype.hasOwnProperty.call(body, k) &&
          body[k] !== undefined &&
          body[k] !== null
        )
          return body[k];
      }
      for (const bk of Object.keys(body)) {
        for (const k of cands) {
          if (bk.toLowerCase() === String(k).toLowerCase()) return body[bk];
        }
      }
      return undefined;
    };

    const name = String(
      pick(["name", "fullName", "full_name", "firstName", "first_name"]) || "",
    ).trim();
    const mobile = String(
      pick(["mobile", "phone", "contact", "whatsapp"]) || "",
    ).trim();
    const email = String(
      pick(["email", "mail", "emailId", "email_id", "contactEmail"]) || "",
    ).trim();

    if (!body.added_by_admin) {
      if (!isEmailLike(email)) {
        return res
          .status(400)
          .json({ success: false, error: "Valid email required" });
      }
      const verificationToken = body.verificationToken;
      const isValid = await verifyOtpToken(
        db,
        "partner",
        email,
        verificationToken,
      );
      if (!isValid) {
        return res
          .status(403)
          .json({ success: false, error: "Email not verified via OTP" });
      }
    }

    const designation = String(
      pick(["designation", "role", "title"]) || "",
    ).trim();

    // ✅ Extract company from various fields
    const company = String(
      pick(["companyName", "company", "organization", "org"]) || "",
    ).trim();
    const businessType = String(
      pick(["businessType", "business_type", "companyType"]) || "",
    ).trim();
    const partnership = String(
      pick(["partnership", "partnershipType", "partnership_type"]) || "",
    ).trim();

    if (!mobile) {
      return res
        .status(400)
        .json({ success: false, error: "mobile is required" });
    }

    const doc = {
      name: name || null,
      mobile: mobile || null,
      email: email || null,
      designation: designation || null,
      company: company || null,
      businessType: businessType || null,
      partnership: partnership || null,
      added_by_admin: !!body.added_by_admin,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (!!body.added_by_admin) {
      doc.admin_created_at = body.admin_created_at
        ? new Date(body.admin_created_at)
        : new Date();
    }

    const col = db.collection("partners");

    let ticket_code = body.ticket_code;
    if (!ticket_code) {
      do {
        ticket_code = generateTicketCode();
      } while (await col.findOne({ ticket_code }));
    }
    doc.ticket_code = ticket_code;

    const r = await col.insertOne(doc);
    const insertedId = r && r.insertedId ? String(r.insertedId) : null;

    res.status(201).json({
      success: true,
      insertedId,
      id: insertedId,
      mail: { queued: true },
    });

    // ✅ Send notification to admin
    (async () => {
      try {
        const allFields = JSON.stringify(doc, null, 2);
        await mailer.sendMail({
          to: "railtransexpo@gmail.com",
          subject: `New Partner Registration - ${doc.name || doc.company || "Unknown"}`,
          text: `New partner registration received:\n\n${allFields}`,
          html: `<h3>New Partner Registration</h3><pre style="background:#f5f5f5;padding:10px;border-radius:5px;">${allFields}</pre>`,
        });
      } catch (e) {
        console.error("[partners] Notification email failed:", e);
      }
    })();

    // Background email
    (async () => {
      try {
        if (!insertedId) return;
        const saved = await col.findOne({ _id: r.insertedId });
        if (!saved) return;

        console.log(`[DEBUG] Partner created with company: "${saved.company}"`);

        const to = saved.email || null;
        if (to && isEmailLike(to)) {
          const mail = buildPartnerAckEmail({
            name: saved.name,
            company: saved.company,
          });
          try {
            await mailer.sendMail({
              to: saved.email,
              subject: mail.subject,
              text: mail.text,
              html: mail.html,
              from: mail.from,
            });
            console.log("[partners] ack mail sent to", saved.email);
            await col.updateOne(
              { _id: r.insertedId },
              {
                $unset: { email_failed: "", email_failed_at: "" },
                $set: { email_sent_at: new Date() },
              },
            );
          } catch (e) {
            console.error("[partners] ack mail failed:", e && (e.message || e));
            await col.updateOne(
              { _id: r.insertedId },
              {
                $set: { email_failed: true, email_failed_at: new Date() },
              },
            );
          }
        }
      } catch (e) {
        console.error("[partners] background email error:", e);
      }
    })();

    return;
  } catch (err) {
    console.error("[partners] register error:", err);
    return res
      .status(500)
      .json({
        success: false,
        error: err && err.message ? err.message : String(err),
      });
  }
});
/* ---------- Read / Update / Delete endpoints ---------- */

/**
 * GET /api/partners
 */
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });

    const rows = await db
      .collection("partners")
      .find({})
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();
    const flattened = rows.map((r) => {
      const output = docToOutput(r);
      ["createdAt", "updatedAt"].forEach((field) => {
        if (output[field] instanceof Date) {
          output[field] = output[field].toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        }
      });
      return output;
    });
    return res.json(convertBigIntForJson(flattened));
  } catch (err) {
    console.error("[partners] fetch error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch partners" });
  }
});

/**
 * GET /api/partners/: id
 */
router.get("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: "database not available" });
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "invalid id" });
    }
    const doc = await db.collection("partners").findOne({ _id: oid });
    return res.json(convertBigIntForJson(docToOutput(doc) || {}));
  } catch (err) {
    console.error("[partners] fetch by id error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch partner" });
  }
});

/**
 * PUT /api/partners/:id
 * Accepts fields in body (except id/_id), updates, and returns saved document.
 */
router.put("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }

    const fields = { ...(req.body || {}) };
    delete fields.id;
    delete fields._id;

    if (Object.keys(fields).length === 0)
      return res
        .status(400)
        .json({ success: false, error: "No fields to update" });

    const updateData = { ...fields, updatedAt: new Date() };

    const r = await db
      .collection("partners")
      .updateOne({ _id: oid }, { $set: updateData });
    if (!r.matchedCount)
      return res
        .status(404)
        .json({ success: false, error: "Partner not found" });

    const saved = await db.collection("partners").findOne({ _id: oid });
    const out = docToOutput(saved);
    return res.json(convertBigIntForJson({ success: true, saved: out }));
  } catch (err) {
    console.error("[partners] update error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to update partner" });
  }
});

/**
 * DELETE /api/partners/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }

    const r = await db.collection("partners").deleteOne({ _id: oid });
    if (!r.deletedCount)
      return res
        .status(404)
        .json({ success: false, error: "Partner not found" });

    return res.json({ success: true });
  } catch (err) {
    console.error("[partners] delete error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to delete partner" });
  }
});

/* ---------- Approve / Cancel endpoints (status emails only, no ticket logic) ---------- */

/**
 * POST /api/partners/:id/approve
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
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }

    const update = {
      status: "approved",
      approved_by: admin,
      approved_at: new Date(),
      updated_at: new Date(),
    };
    const r = await db
      .collection("partners")
      .updateOne({ _id: oid }, { $set: update });
    if (!r.matchedCount)
      return res
        .status(404)
        .json({ success: false, error: "Partner not found" });

    const doc = await db.collection("partners").findOne({ _id: oid });
    const out = docToOutput(doc);

    res.json(convertBigIntForJson({ success: true, id, updated: out }));

    // Background: notify partner & admins (status email, NO ticket, NO badge)
    if (out && isEmailLike(out.email)) {
      (async () => {
        try {
          const to = out.email;
          const subject = `Your partner request has been approved — RailTrans Expo`;
          const text = `Hello ${out.name || out.company || ""},

Good news — your partner registration (ID: ${out.id}) has been approved. Our team will contact you with next steps.

Regards,
RailTrans Expo Team`;
          const html = `<p>Hello ${out.name || out.company || ""},</p><p>Your partner registration (ID: <strong>${out.id}</strong>) has been <strong>approved</strong>.</p>`;
          await sendMail({ to, subject, text, html });
        } catch (mailErr) {
          console.error(
            "[partners] approval email error:",
            mailErr && (mailErr.stack || mailErr),
          );
        }
      })();
    }
  } catch (err) {
    console.error("Approve partner error:", err && (err.stack || err));
    const message =
      (err && (err.sqlMessage || err.message)) ||
      "Server error approving partner";
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/partners/:id/cancel
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
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }

    const update = {
      status: "cancelled",
      cancelled_by: admin,
      cancelled_at: new Date(),
      updated_at: new Date(),
    };
    const r = await db
      .collection("partners")
      .updateOne({ _id: oid }, { $set: update });
    if (!r.matchedCount)
      return res
        .status(404)
        .json({ success: false, error: "Partner not found" });

    const doc = await db.collection("partners").findOne({ _id: oid });
    const out = docToOutput(doc);

    res.json(convertBigIntForJson({ success: true, id, updated: out }));

    // Background: notify partner & admins (status email, NO ticket, NO badge)
    if (out && isEmailLike(out.email)) {
      (async () => {
        try {
          const to = out.email;
          const subject = `Your partner registration has been cancelled — RailTrans Expo`;
          const text = `Hello ${out.name || out.company || ""},

Your partner registration (ID: ${out.id}) has been cancelled. If you believe this is an error, contact support@railtransexpo.com. 

Regards,
RailTrans Expo Team`;
          const html = `<p>Hello ${out.name || out.company || ""},</p><p>Your partner registration (ID: <strong>${out.id}</strong>) has been <strong>cancelled</strong>.</p>`;
          await sendMail({ to, subject, text, html });
        } catch (mailErr) {
          console.error(
            "[partners] cancel email error:",
            mailErr && (mailErr.stack || mailErr),
          );
        }
      })();
    }
  } catch (err) {
    console.error("Cancel partner error:", err && (err.stack || err));
    const message =
      (err && (err.sqlMessage || err.message)) ||
      "Server error cancelling partner";
    return res.status(500).json({ success: false, error: message });
  }
});

/* ---------- Ticket send / resend endpoint ---------- */

/**
 * POST /api/partners/:id/resend-email
 *
 * This endpoint is the ONLY place that sends the "TICKET EMAIL" (badge, QR, ticket).
 * It delegates to utils/sendTicketEmail which centralizes template + badge generation.
 */
router.post("/:id/resend-email", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db)
      return res
        .status(500)
        .json({ success: false, error: "database not available" });

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "invalid id" });
    }

    const col = db.collection("partners");
    const doc = await col.findOne({ _id: oid });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, error: "Partner not found" });
    if (!isEmailLike(doc.email))
      return res
        .status(400)
        .json({ success: false, error: "No valid email found for partner" });

    try {
      const result = await sendTicketEmail({
        entity: "partners",
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
        return res.json({ success: true, mail: { ok: true } });
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
        return res
          .status(500)
          .json({
            success: false,
            error:
              result && result.error
                ? result.error
                : "Failed to send ticket email",
          });
      }
    } catch (e) {
      console.error("[partners] resend ticket failed:", e && (e.stack || e));
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
      return res
        .status(500)
        .json({ success: false, error: "Failed to resend ticket email" });
    }
  } catch (err) {
    console.error("[partners] resend-email error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Server error resending ticket email" });
  }
});

module.exports = router;
