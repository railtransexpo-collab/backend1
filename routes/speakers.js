const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const mongo = require('../utils/mongoClient');
const { sendMail } = require('../utils/mailer');
const mailer = require('../utils/mailer'); // for ACK email
const sendTicketEmail = require('../utils/sendTicketEmail'); // for ticket email with badge
const { verifyOtpToken } = require('../utils/otpStore');
// parse JSON bodies for routes in this router
router.use(express.json({ limit: '6mb' }));
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

  store.delete(key); // single-use
  return true;
}

function generateTicketCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function isEmailLike(v) {
  return typeof v === 'string' && /\S+@\S+\.\S+/.test(v);
}

function docToOutput(doc) {
  if (!doc) return null;
  const out = { ...doc };
  if (out._id) {
    out.id = String(out._id);
  } else {
    out.id = null;
  }
  return out;
}

/**
 * Build the acknowledgement email body (text + html)
 * IMPORTANT: This is the DEFAULT ACK EMAIL (no ticket, no badge).
 * Ticket emails with badges are sent only via POST /: id/send-ticket
 */
function buildSpeakerAckEmail({ name = '' } = {}) {
  const subject = 'Speaker Registration Received — RailTrans Expo';

  const text = `Hello ${name || 'Speaker'},

Thank you for showing your interest and choosing to be a part of RailTrans Expo. We truly appreciate your decision to connect with us and share your expertise at our prestigious platform.

We are pleased to confirm that your speaker registration has been successfully received. Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps. 

Regards,
RailTrans Expo Team
support@railtransexpo.com
`;

  const html = `<p>Hello ${name || 'Speaker'},</p>
<p>Thank you for showing your interest and choosing to be a part of <strong>RailTrans Expo</strong>. <br> We truly appreciate your decision to connect with us and share your expertise at our prestigious platform.</p>

<p>We are pleased to confirm that your speaker registration has been <strong>successfully received</strong>. <br> Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps. </p>

<p>Regards,<br/>
<strong>RailTrans Expo Team</strong><br/>
<a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a>
</p>`;

  const from = process.env.MAIL_FROM || 'RailTrans Expo <support@railtransexpo.com>';
  return { subject, text, html, from };
}

/**
 * POST /api/speakers
 * Create new speaker and respond immediately.  If added_by_admin === true, skip background ACK email.
 * NOTE: This sends ONLY the ACK email (no ticket/badge). Ticket emails are sent via /send-ticket endpoint.
 */

router.post('/', async (req, res) => {
  let db;
  let col;
  let r;
  try {
    db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const payload = { ...(req.body || {}) };

    // normalize slots if provided as JSON string
    if (typeof payload.slots === 'string') {
      try { payload.slots = JSON.parse(payload.slots); } catch { /* keep as string */ }
    }

    const email = (payload.email || '').toString().trim();
    if (!isEmailLike(email)) {
      return res.status(400).json({ success: false, error: 'Valid email required' });
    }

    if (!payload.added_by_admin) {
      const verificationToken = payload.verificationToken;
      const isValid = await verifyOtpToken(db, 'speaker', email, verificationToken);
      if (!isValid) {
        return res.status(403).json({ success: false, error: 'Email not verified via OTP' });
      }
    }

    // ✅ Extract company from various fields
    const company = payload.company || payload.organization || payload.employer || payload.affiliation || '';

     // ✅ Handle slots - map from slot_duration if slots is empty
    let slotsValue = [];
    if (Array.isArray(payload.slots) && payload.slots.length > 0) {
      slotsValue = payload.slots;
    } else if (payload.slot_duration) {
      // If single value, wrap in array
      slotsValue = Array.isArray(payload.slot_duration) ? payload.slot_duration : [payload.slot_duration];
    }

    const doc = {
      name: payload.name || payload.fullName || '',
      email: email,
      mobile: payload.mobile || payload.phone || '',
      designation: payload.designation || '',
      company: company || '',
      ticket_category: 'speaker',
      slots: slotsValue,
   
   
      other_details: payload.other_details || payload.otherDetails || '',
      createdAt: new Date(),                     // ✅ camelCase
      updatedAt: new Date(),                     // ✅ ADD THIS
      registered_at: payload.registered_at ? new Date(payload.registered_at) : new Date(),
     
      admin_created_at: payload.added_by_admin ? new Date(payload.admin_created_at || Date.now()) : undefined,
    };
    const skipKeys = new Set([
      'name', 'fullName', 'email', 'mobile', 'phone', 'designation',
      'company', 'organization', 'employer', 'affiliation',
      'ticket_category', 'slots', 'slot_duration', 'category', 'txId', 'txid',
      'other_details', 'otherDetails', 'added_by_admin', 'admin_created_at',
      'verificationToken', 'ticket_code', 'ticketCode', 'termsAccepted',
      '_rawForm', 'registered_at'
    ]);

    for (const [key, value] of Object.entries(payload)) {
      if (!skipKeys.has(key) && value !== undefined && value !== null && value !== '') {
        doc[key] = value;
      }
    }

    doc.ticket_code = (payload.ticket_code || payload.ticketCode) ? String(payload.ticket_code || payload.ticketCode) : generateTicketCode();

    col = db.collection('speakers');
    r = await col.insertOne(doc);
    const insertedId = r.insertedId ? String(r.insertedId) : null;

    // ensure ticket_code persisted
    if (doc.ticket_code && r && r.insertedId) {
      try { await col.updateOne({ _id: r.insertedId }, { $set: { ticket_code: doc.ticket_code } }); } catch (e) { /* ignore */ }
    }

    const savedDoc = await col.findOne({ _id: r.insertedId });
    const output = docToOutput(savedDoc);

    res.json({
      success: true,
      insertedId,
      ticket_code: doc.ticket_code,
      saved: output,
      mail: { queued: true },
    });

    // ✅ Send notification to admin
    (async () => {
      try {
        const allFields = JSON.stringify(doc, null, 2);
        await mailer.sendMail({
          to: "railtransexpo@gmail.com",
          subject: `New Speaker Registration - ${doc.name || 'Unknown'}`,
          text: `New speaker registration received:\n\n${allFields}`,
          html: `<h3>New Speaker Registration</h3><pre style="background:#f5f5f5;padding:10px;border-radius:5px;">${allFields}</pre>`
        });
      } catch (e) { console.error('[speakers] Notification email failed:', e); }
    })();

    // Background email
    (async () => {
      try {
        if (!isEmailLike(doc.email)) return;

        console.log(`[DEBUG] Speaker created with company: "${doc.company}"`);

        const mail = buildSpeakerAckEmail({ name: doc.name });
            const mailResult = await mailer.sendMail({
          to: doc.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          from: mail.from,
        });
        if (mailResult && mailResult.success) {
          await col.updateOne({ _id: r.insertedId }, {
            $unset: { email_failed: "", email_failed_at: "" },
            $set: { email_sent_at: new Date() }
          });
        } else {
          await col.updateOne({ _id: r.insertedId }, {
            $set: { email_failed: true, email_failed_at: new Date() }
          });
        }
      } catch (e) {
        console.error('[speakers] background email error:', e);
      }
    })();

    return;
  } catch (err) {
    console.error('POST /api/speakers (mongo) error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create speaker' });
  }
});

/**
 * POST /api/speakers/:id/resend-email
 * 
 * WARNING: This endpoint now only re-sends the ACK email (no ticket).
 * Use POST /api/speakers/:id/send-ticket to send the ticket (badge, QR, etc).
 */
router.post('/:id/resend-email', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const col = db.collection('speakers');
    const doc = await col.findOne({ _id: oid });
    if (!doc) return res.status(404).json({ success: false, error: 'Speaker not found' });
    if (!isEmailLike(doc.email)) return res.status(400).json({ success: false, error: 'No valid email found for speaker' });

    const mail = buildSpeakerAckEmail({ name: doc.name });

    try {
      await sendMail({
        to: doc.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        from: mail.from,
      });
      await col.updateOne({ _id: oid }, { $set: { email_sent_at: new Date() }, $unset: { email_failed: "" } });
      return res.json({ success: true, mail: { ok: true } });
    } catch (e) {
      console.error('[speakers] resend ack failed:', e && (e.message || e));
      try { await col.updateOne({ _id: oid }, { $set: { email_failed: true, email_failed_at: new Date() } }); } catch { }
      return res.status(500).json({ success: false, error: 'Failed to resend ack email' });
    }
  } catch (err) {
    console.error('POST /api/speakers/:id/resend-email error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to resend ack email' });
  }
});

/**
 * POST /api/speakers/: id/send-ticket
 *
 * NEW: This endpoint is the ONLY place that sends the "TICKET EMAIL" (badge, QR, etc).
 * It delegates to utils/sendTicketEmail which centralizes template + badge generation.
 */
router.post('/:id/send-ticket', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const col = db.collection('speakers');
    const doc = await col.findOne({ _id: oid });
    if (!doc) return res.status(404).json({ success: false, error: 'Speaker not found' });
    if (!isEmailLike(doc.email)) return res.status(400).json({ success: false, error: 'No valid email found for speaker' });

    try {
      const result = await sendTicketEmail({
        entity: 'speakers',
        record: doc,
        options: { forceSend: true, includeBadge: true }
      });

      if (result && result.success) {
        await col.updateOne({ _id: oid }, { $set: { ticket_email_sent_at: new Date() }, $unset: { ticket_email_failed: "" } });
        return res.json({ success: true, mail: { ok: true, info: result.info || null } });
      } else {
        await col.updateOne({ _id: oid }, { $set: { ticket_email_failed: true, ticket_email_failed_at: new Date() } });
        return res.status(500).json({ success: false, mail: { ok: false, error: result && result.error ? result.error : 'ticket_send_failed' } });
      }
    } catch (e) {
      console.error('[speakers] send-ticket failed:', e && (e.stack || e));
      try { await col.updateOne({ _id: oid }, { $set: { ticket_email_failed: true, ticket_email_failed_at: new Date() } }); } catch { }
      return res.status(500).json({ success: false, error: 'Failed to send ticket email' });
    }
  } catch (err) {
    console.error('POST /api/speakers/:id/send-ticket error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to send ticket email' });
  }
});

/**
 * GET /api/speakers
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });

    const col = db.collection('speakers');
       const cursor = col.find({}).sort({ createdAt: -1 }).limit(1000);
    const rows = await cursor.toArray();
    return res.json(rows.map(docToOutput));
  } catch (err) {
    console.error('GET /api/speakers (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to fetch speakers' });
  }
});

/**
 * GET /api/speakers/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });

    let q;
    try {
      q = { _id: new ObjectId(id) };
    } catch {
      return res.status(400).json({ error: 'invalid id' });
    }

    const col = db.collection('speakers');
    const doc = await col.findOne(q);
    return res.json(docToOutput(doc) || {});
  } catch (err) {
    console.error('GET /api/speakers/:id (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to fetch speaker' });
  }
});

/**
 * DELETE /api/speakers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ success: false, error: 'database not available' });
    }

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }

    const col = db.collection('speakers');
    const r = await col.deleteOne({ _id: oid });

    if (r.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Speaker not found' });
    }

    return res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('DELETE /api/speakers/:id error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to delete speaker' });
  }
});

/**
 * PUT /api/speakers/:id
 * Accepts fields in body (except id/_id), updates and returns saved document.
 */
router.put('/:id', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const fields = { ...(req.body || {}) };
    delete fields.id;
    delete fields._id;

    if (Object.keys(fields).length === 0) return res.status(400).json({ success: false, error: 'No fields to update' });

       const updateData = { ...fields, updatedAt: new Date() };

    const col = db.collection('speakers');
    const r = await col.updateOne({ _id: oid }, { $set: updateData });
    if (!r.matchedCount) return res.status(404).json({ success: false, error: 'Speaker not found' });

    const saved = await col.findOne({ _id: oid });
    const out = docToOutput(saved);
    return res.json({ success: true, saved: out });
  } catch (err) {
    console.error('PUT /api/speakers/:id error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to update speaker' });
  }
});

module.exports = router;