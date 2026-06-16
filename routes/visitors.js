const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient");
const { ObjectId } = require("mongodb");
const mailer = require("../utils/mailer");
const sendTicketEmail = require("../utils/sendTicketEmail");
const { verifyOtpToken } = require("../utils/otpStore");
const { scheduleDynamicReminder } = require("../utils/dynamicReminder");

router.use(express.json({ limit: "6mb" }));

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
  store.delete(key);
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

function buildVisitorAckEmail({ name = "" } = {}) {
  const subject = "Thank You for Your Interest in 6th RailTrans Expo 2026";
  const text = `Dear ${name || "Sir/Ma'am"},

Thank you for registering as a delegate/visitor for the 6th RailTrans Expo 2026.

We are delighted to receive your interest in being a part of this prestigious industry platform.

Your registration is currently under the review process, and our team is carefully evaluating the details submitted by you.

Venue: Bharat Mandapam
Event Dates: 3rd & 4th July 2026

Our team will get in touch with you shortly regarding the next steps and further coordination.

Thank you once again for your interest and support. We look forward to the opportunity of welcoming you to the event.

Warm regards,
Team RailTrans Expo
support@railtransexpo.com
+91 9211675505, +91 8527599895
www.railtransexpo.com`;

  const html = `<p>Dear ${name || "Sir/Ma'am"},</p>
<p>Thank you for registering as a <strong>delegate/visitor</strong> for the <strong>6th RailTrans Expo 2026</strong>.</p>
<p>We are delighted to receive your interest in being a part of this prestigious industry platform.</p>
<p>Your registration is currently under the review process, and our team is carefully evaluating the details submitted by you.</p>
<p><strong>Venue:</strong> Bharat Mandapam<br/><strong>Event Dates:</strong> 3rd & 4th July 2026</p>
<p>Our team will get in touch with you shortly regarding the next steps and further coordination.</p>
<p>Thank you once again for your interest and support. We look forward to the opportunity of welcoming you to the event.</p>
<p>Warm regards,<br/><strong>Team RailTrans Expo</strong><br/>
<a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a><br/>
+91 9211675505, +91 8527599895<br/>
<a href="https://www.railtransexpo.com">www.railtransexpo.com</a></p>`;

  const from =
    process.env.MAIL_FROM || "RailTrans Expo <support@railtransexpo.com>";
  return { subject, text, html, from };
}

/* ========== GET / ========== */
router.get("/", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });
  try {
    const rows = await db
      .collection("visitors")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    const flattened = rows.map((r) => {
      const flat = { ...r };
      if (flat.data && typeof flat.data === "object") {
        for (const [key, value] of Object.entries(flat.data)) {
          if (!(key in flat) || flat[key] === undefined || flat[key] === null)
            flat[key] = value;
        }
      }
      if (flat._id) flat.id = String(flat._id);
      return flat;
    });
    return res.json({ success: true, data: flattened });
  } catch (err) {
    console.error("[visitors] list error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to list visitors" });
  }
});

/* ========== GET /:id ========== */
router.get("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });
  const id = req.params.id;
  let doc = null;
  const coll = db.collection("visitors");
  const oid = toObjectId(id);
  if (oid) doc = await coll.findOne({ _id: oid }).catch(() => null);
  if (!doc) doc = await coll.findOne({ ticket_code: id }).catch(() => null);
  if (!doc)
    return res.status(404).json({ success: false, error: "Visitor not found" });
  const flat = { ...doc };
  if (flat.data && typeof flat.data === "object") {
    for (const [key, value] of Object.entries(flat.data)) {
      if (!(key in flat) || flat[key] === undefined || flat[key] === null)
        flat[key] = value;
    }
  }
  if (flat._id) flat.id = String(flat._id);
  return res.json(flat);
});

/* ========== POST / ========== */
router.post("/", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });

  try {
    const body = req.body || {};
    const form = body.form || body || {};
    const email = String(form.email || "").trim();
    if (!isEmailLike(email))
      return res
        .status(400)
        .json({ success: false, message: "Valid email required" });

    const isAdminCreate = !!body.added_by_admin;
    const verificationToken = body.verificationToken || form.verificationToken;

    if (!isAdminCreate) {
      const isValid = await verifyOtpToken(
        db,
        "visitor",
        email,
        verificationToken,
      );
      if (!isValid)
        return res
          .status(403)
          .json({ success: false, error: "Email not verified via OTP" });
    }

    const coll = db.collection("visitors");
    let ticket_code = form.ticket_code;
    if (!ticket_code) {
      do {
        ticket_code = String(Math.floor(100000 + Math.random() * 900000));
      } while (await coll.findOne({ ticket_code }));
    }

    let company = "";
    if (form.company) company = form.company;
    else if (form.organization) company = form.organization;
    else if (form.companyName) company = form.companyName;
    else if (form.employer) company = form.employer;
    else if (form.affiliation) company = form.affiliation;
    if (!company && form.data && form.data.company) company = form.data.company;

    const doc = {
      role: "visitor",
      name: form.name || null,
      email,
      mobile: form.mobile || null,
      company: company || null,
      ticket_code,
      txId: form.txId || null,
      ticket_price: Number(form.ticket_price || 0),
      ticket_gst: Number(form.ticket_gst || 0),
      ticket_total: Number(form.ticket_total || 0),
      data: form,
      createdAt: new Date(),
      updatedAt: new Date(),
      added_by_admin: !!body.added_by_admin,
      admin_created_at: body.added_by_admin
        ? new Date(body.admin_created_at || Date.now())
        : undefined,
    };

    const r = await coll.insertOne(doc);
    const insertedId = r.insertedId ? String(r.insertedId) : null;

    res.json({
      success: true,
      insertedId,
      ticket_code,
      mail: { queued: true },
    });

    // Schedule dynamic reminder
    scheduleDynamicReminder(db, "visitors", insertedId).catch((e) =>
      console.error("[visitors] Reminder schedule failed:", e.message),
    );

 // ✅ Send TICKET email to registrant (NO ACK email, NO admin notification)
(async () => {
  try {
    const savedDoc = await coll.findOne({ _id: r.insertedId });
    if (!savedDoc || !isEmailLike(savedDoc.email)) return;

    console.log(
      `[DEBUG] Visitor created. Admin: ${isAdminCreate}, Ticket Total: ${savedDoc.ticket_total}, TxId: ${savedDoc.txId}`,
    );

    // ✅ ALWAYS send TICKET email for admin-created visitors
    // For non-admin (user) registrations:
    // - Free (ticket_total = 0) → Send TICKET
    // - Paid without txId → Send ACK (waiting for payment)
    // - Paid with txId → Send TICKET
    
    const isUserRegistration = !isAdminCreate;
    const isPaidTicket = savedDoc.ticket_total > 0;
    const hasPaymentProof = !!savedDoc.txId;
    
    // ✅ Only send ACK for user-paid without proof
    const shouldSendAck = isUserRegistration && isPaidTicket && !hasPaymentProof;

    if (shouldSendAck) {
      // Paid ticket without proof from user → Send ACK email (waiting for verification)
      const mail = buildVisitorAckEmail({ name: savedDoc.name });
      await mailer.sendMail({
        to: savedDoc.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        from: mail.from,
      });
      console.log("[visitors] ACK mail sent to", savedDoc.email);
      await coll.updateOne(
        { _id: r.insertedId },
        {
          $unset: { email_failed: "", email_failed_at: "" },
          $set: { email_sent_at: new Date() },
        },
      );
    } else {
      // Send TICKET email for:
      // - ✅ Admin created (ANY ticket type)
      // - ✅ Free registrations (ticket_total = 0)
      // - ✅ Paid with proof (txId exists)
      const result = await sendTicketEmail({
        entity: "visitors",
        record: savedDoc,
        options: { forceSend: true, includeBadge: true },
      });

      if (result?.success) {
        console.log("[visitors] ✅ Ticket email sent to", savedDoc.email);
        await coll.updateOne(
          { _id: r.insertedId },
          {
            $set: { ticket_email_sent_at: new Date() },
            $unset: { email_failed: "", ticket_email_failed: "" },
          },
        );
      } else {
        console.error("[visitors] ❌ Ticket email failed");
        await coll.updateOne(
          { _id: r.insertedId },
          {
            $set: {
              ticket_email_failed: true,
              ticket_email_failed_at: new Date(),
            },
          },
        );
      }
    }
  } catch (e) {
    console.error("[visitors] background email error:", e);
  }
})();

    return;
  } catch (err) {
    console.error("[visitors] create error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Failed to create visitor" });
  }
});
/* ========== PUT /:id ========== */
router.put("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });
  const id = req.params.id;
  const oid = toObjectId(id);
  if (!oid)
    return res.status(400).json({ success: false, error: "Invalid id" });
  try {
    const fields = { ...(req.body || {}) };
    delete fields._id;
    delete fields.id;
    if (Object.keys(fields).length === 0)
      return res
        .status(400)
        .json({ success: false, error: "No fields to update" });
    const update = { ...fields, updatedAt: new Date() };
    const coll = db.collection("visitors");
    const r = await coll.updateOne({ _id: oid }, { $set: update });
    if (r.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Visitor not found" });
    const updated = await coll.findOne({ _id: oid });
    return res.json({ success: true, saved: updated });
  } catch (err) {
    console.error("[visitors] update error:", err && (err.stack || err));
    return res
      .status(500)
      .json({ success: false, error: "Failed to update visitor" });
  }
});

/* ========== POST /:id/resend-email ========== */
router.post("/:id/resend-email", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });
  const oid = toObjectId(req.params.id);
  if (!oid)
    return res.status(400).json({ success: false, error: "Invalid ID" });
  const coll = db.collection("visitors");
  const doc = await coll.findOne({ _id: oid });
  if (!doc)
    return res.status(404).json({ success: false, error: "Visitor not found" });
  if (!isEmailLike(doc.email))
    return res.status(400).json({ success: false, error: "Invalid email" });
  try {
    const result = await sendTicketEmail({ entity: "visitors", record: doc });
    if (result?.success) {
      await coll.updateOne(
        { _id: oid },
        { $set: { email_sent_at: new Date() }, $unset: { email_failed: "" } },
      );
      return res.json({ success: true });
    }
    await coll.updateOne(
      { _id: oid },
      { $set: { email_failed: true, email_failed_at: new Date() } },
    );
    return res
      .status(500)
      .json({ success: false, error: result?.error || "Failed to send email" });
  } catch (err) {
    console.error("[visitors] resend mail error:", err);
    await coll
      .updateOne(
        { _id: oid },
        { $set: { email_failed: true, email_failed_at: new Date() } },
      )
      .catch(() => {});
    return res.status(500).json({ success: false, error: "Mail send failed" });
  }
});

/* ========== POST /:id/send-ticket ========== */
router.post("/:id/send-ticket", async (req, res) => {
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
    const col = db.collection("visitors");
    const doc = await col.findOne({ _id: oid });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, error: "Visitor not found" });
    if (!isEmailLike(doc.email))
      return res.status(400).json({ success: false, error: "No valid email" });
    const result = await sendTicketEmail({
      entity: "visitors",
      record: doc,
      options: { forceSend: true, includeBadge: true },
    });
    if (result?.success) {
      await col.updateOne(
        { _id: oid },
        {
          $set: { ticket_email_sent_at: new Date() },
          $unset: { ticket_email_failed: "" },
        },
      );
      return res.json({ success: true, mail: { ok: true } });
    }
    return res
      .status(500)
      .json({ success: false, error: "Failed to send ticket" });
  } catch (e) {
    console.error("[visitors] send-ticket error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ========== DELETE /:id ========== */
router.delete("/:id", async (req, res) => {
  const db = await obtainDb();
  if (!db)
    return res.status(500).json({ success: false, error: "DB not ready" });
  const id = req.params.id;
  try {
    let result = null;
    if (ObjectId.isValid(id))
      result = await db
        .collection("visitors")
        .deleteOne({ _id: new ObjectId(id) });
    if (!result || result.deletedCount === 0)
      result = await db.collection("visitors").deleteOne({ ticket_code: id });
    if (!result?.deletedCount) return res.status(404).json({ success: false });
    return res.json({ success: true });
  } catch (err) {
    console.error("[visitors] delete error:", err);
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
});

module.exports = router;
