const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { ObjectId } = require('mongodb');
const mongo = require('../utils/mongoClient');
const mailer = require('../utils/mailer');
const sendTicketEmail = require('../utils/sendTicketEmail');
const { verifyOtpToken } = require('../utils/otpStore');

function isEmailLike(v) {
  return typeof v === 'string' && /\S+@\S+\.\S+/.test(v);
}
let safeFieldName;
try {
  safeFieldName = require('../utils/mongoSchemaSync').safeFieldName;
} catch (e) {
  safeFieldName = function (name) {
    if (!name) return null;
    let s = String(name).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!/^[a-z_]/.test(s)) s = `f_${s}`;
    return s;
  };
}

// body parser for router
router.use(express.json({ limit: '6mb' }));

// Ensure uploads directory exists
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function docToOutput(doc) {
  if (!doc) return null;
  const out = { ...(doc || {}) };
  if (out._id) {
    out.id = String(out._id);
  }
  return out;
}

function extractCompany(form) {
  if (!form) return '';

  const companyFields = [
    'company', 'organization', 'companyName', 'company_name',
    'org', 'employer', 'affiliation', 'business', 'firm'
  ];

  for (const field of companyFields) {
    if (form[field] && typeof form[field] === 'string' && form[field].trim()) {
      return form[field].trim();
    }
  }

  if (form.data) {
    for (const field of companyFields) {
      if (form.data[field] && typeof form.data[field] === 'string' && form.data[field].trim()) {
        return form.data[field].trim();
      }
    }
  }

  return '';
}

function convertBigIntForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(convertBigIntForJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertBigIntForJson(v);
    return out;
  }
  return value;
}

function generateTicketCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

async function loadAdminFields(db, pageName = 'awardee') {
  try {
    const col = db.collection('registration_configs');
    const doc = await col.findOne({ page: pageName });
    const fields = (doc && doc.config && Array.isArray(doc.config.fields)) ? doc.config.fields : [];
    const originalNames = new Set();
    const safeNames = new Set();
    for (const f of fields) {
      if (!f || !f.name) continue;
      const name = String(f.name).trim();
      if (!name) continue;
      originalNames.add(name);
      const sn = safeFieldName(name);
      if (sn) safeNames.add(sn);
    }
    return { originalNames, safeNames, fields };
  } catch (e) {
    return { originalNames: new Set(), safeNames: new Set(), fields: [] };
  }
}

/* ---------- ACK email builder (no ticket info) ---------- */
function buildAwardeeAckEmail({ name = '' } = {}) {
  const subject = 'Awardee Registration Received — RailTrans Expo';

  const text = `Hello ${name || 'Participant'},

Thank you for showing your interest and choosing to be a part of RailTrans Expo. We truly appreciate your decision to connect with us and be recognized at our prestigious platform.

We are pleased to confirm that your awardee registration has been successfully received. Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps. 

Regards,
RailTrans Expo Team
support@railtransexpo.com
`;

  const html = `<p>Hello ${name || 'Participant'},</p>
<p>Thank you for showing your interest and choosing to be a part of <strong>RailTrans Expo</strong>. <br> We truly appreciate your decision to connect with us and be recognized at our prestigious platform.</p>

<p>We are pleased to confirm that your awardee registration has been <strong>successfully received</strong>. <br> Our team is currently reviewing the details shared by you and will get back to you shortly with the next steps. </p>

<p>Regards,<br/>
<strong>RailTrans Expo Team</strong><br/>
<a href="mailto:support@railtransexpo.com">support@railtransexpo.com</a>
</p>`;

  return {
    subject,
    text,
    html,
    from: process.env.MAIL_FROM || 'RailTrans Expo <support@railtransexpo.com>',
  };
}

/* ---------- Routes ---------- */

/**
 * POST /api/awardees
 * Create a new awardee, respond immediately, send ACK confirmation email in background. 
 */
router.post('/', express.json(), async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const body = req.body || {};
    const form = body.form || body || {};

    const addedByAdmin = !!body.added_by_admin;

    if (!addedByAdmin) {
      const email = (form.email || '').toString().trim();
      const verificationToken = body.verificationToken || form.verificationToken;

      console.log('[awardees] OTP verification - email:', email);
      console.log('[awardees] OTP verification - token:', verificationToken);

      if (!isEmailLike(email)) {
        return res.status(400).json({ success: false, error: 'Valid email required' });
      }

      // ✅ EXACT same pattern as visitors.js
      const isValid = await verifyOtpToken(db, 'awardee', email, verificationToken);

      if (!isValid) {
        return res.status(403).json({ success: false, error: 'Email not verified via OTP' });
      }
      console.log('[awardees] OTP verification PASSED');
    }
    // ✅ Extract company
    const companyName = extractCompany(form);
    const doc = {
      name: form.name || null,
      email: form.email || null,
      mobile: form.mobile || null,
      designation: form.designation || null,
      organization: form.organization || companyName || null,
      company: companyName || null,
      awardType: form.awardType || null,
      awardOther: form.awardOther || null,
      bio: form.bio || null,
      ticket_code: form.ticket_code || generateTicketCode(),
      ticket_category: form.ticket_category || form.category || 'general',
      txId: form.txId || null,
      data: form,
      added_by_admin: addedByAdmin,
      createdAt: new Date(),       // ✅
      updatedAt: new Date(),       // ✅
      
    };

    // ✅ ADD ALL DYNAMIC FIELDS from form
    const skipKeys = new Set([
      'name', 'fullName', 'email', 'mobile', 'phone', 'designation',
      'organization', 'company', 'companyName',
      'awardType', 'awardOther', 'bio',
      'ticket_code', 'ticket_category', 'category', 'txId',
      'added_by_admin', 'admin_created_at', 'verificationToken',
      'termsAccepted', '_rawForm', 'registered_at'
    ]);

    for (const [key, value] of Object.entries(form)) {
      if (!skipKeys.has(key) && value !== undefined && value !== null && value !== '') {
        doc[key] = value;
      }
    }
    if (addedByAdmin) {
      doc.admin_created_at = body.admin_created_at ? new Date(body.admin_created_at) : new Date();
    }

    const col = db.collection('awardees');
    const r = await col.insertOne(doc);
    const insertedId = r.insertedId ? String(r.insertedId) : null;

    const saved = await col.findOne({ _id: r.insertedId });

    // ✅ Debug log
    console.log(`[DEBUG] Awardee created with company: "${companyName}"`);

     res.status(201).json(convertBigIntForJson({
      success: true,
      insertedId,
      ticket_code: doc.ticket_code,
      saved: docToOutput(saved),
      mail: { queued: true }
    }));

    // ✅ Send notification to admin
    (async () => {
      try {
        const allFields = JSON.stringify(doc, null, 2);
        await mailer.sendMail({
          to: "railtransexpo@gmail.com",
          subject: `New Awardee Registration - ${doc.name || 'Unknown'}`,
          text: `New awardee registration received:\n\n${allFields}`,
          html: `<h3>New Awardee Registration</h3><pre style="background:#f5f5f5;padding:10px;border-radius:5px;">${allFields}</pre>`
        });
      } catch (e) { console.error('[awardees] Notification email failed:', e); }
    })();

    // Background ACK email
    (async () => {
      try {
        if (!doc.email) return;
        const mail = buildAwardeeAckEmail({
          name: doc.name || doc.organization,
        });
        try {
          await mailer.sendMail({
            to: doc.email,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            from: mail.from,
          });
          console.log('[awardees] ack mail sent to', doc.email);
          try {
            await col.updateOne(
              { _id: r.insertedId },
              { $unset: { email_failed: "", email_failed_at: "" }, $set: { email_sent_at: new Date() } }
            );
          } catch { }
        } catch (e) {
          console.error('[awardees] ack mail failed:', e && (e.message || e));
          try {
            await col.updateOne(
              { _id: r.insertedId },
              { $set: { email_failed: true, email_failed_at: new Date() } }
            );
          } catch { }
        }
      } catch (e) {
        console.error('[awardees] background mail error:', e && (e.stack || e));
      }
    })();

    // Admin notifications
    (async () => {
      try {
        const adminEnv = (process.env.AWARDEE_ADMIN_EMAILS || process.env.ADMIN_EMAILS || '');
        const admins = adminEnv.split(',').map(s => s.trim()).filter(Boolean);
        if (admins.length) {
          const adminSubject = `New awardee registration — ID: ${insertedId || ''}${addedByAdmin ? ' (Admin Created)' : ''}`;
          const adminText = `New awardee:\n${JSON.stringify(doc, null, 2)}`;
          const adminHtml = `<pre>${JSON.stringify(doc, null, 2)}</pre>`;
          await Promise.all(
            admins.map(addr =>
              mailer.sendMail({ to: addr, subject: adminSubject, text: adminText, html: adminHtml })
                .catch(err => console.error('[awardees] admin notify error:', addr, err && (err.message || err)))
            )
          );
        }
      } catch (e) {
        console.error('[awardees] admin notify error (non-fatal):', e && (e.stack || e));
      }
    })();

    return;
  } catch (err) {
    console.error('[awardees] POST (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to create awardee', details: err && err.message });
  }
});

/**
 * POST /api/awardees/: id/resend-email
 * Re-sends the ACK email (no ticket).
 */
router.post('/:id/resend-email', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }

    const doc = await db.collection('awardees').findOne({ _id: oid });
    if (!doc) return res.status(404).json({ success: false, error: 'Awardee not found' });
    if (!doc.email) return res.status(400).json({ success: false, error: 'No email found for awardee' });

    const mail = buildAwardeeAckEmail({
      name: doc.name || doc.organization,
    });

    try {
      await mailer.sendMail({
        to: doc.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        from: mail.from,
      });
      await db.collection('awardees').updateOne({ _id: oid }, { $set: { email_sent_at: new Date() }, $unset: { email_failed: "" } });
      return res.json({ success: true, mail: { ok: true } });
    } catch (e) {
      console.error('[awardees] resend ack failed:', e && (e.message || e));
      try {
        await db.collection('awardees').updateOne({ _id: oid }, { $set: { email_failed: true, email_failed_at: new Date() } });
      } catch { }
      return res.status(500).json({ success: false, error: 'Failed to resend ack email' });
    }
  } catch (e) {
    console.error('[awardees] resend ack error:', e && (e.stack || e));
    return res.status(500).json({ success: false, error: 'Failed to resend ack email' });
  }
});

/**
 * POST /api/awardees/:id/send-ticket
 * Sends the TICKET EMAIL (badge, QR, etc).
 */
router.post('/:id/send-ticket', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }

    const doc = await db.collection('awardees').findOne({ _id: oid });
    if (!doc) return res.status(404).json({ success: false, error: 'Awardee not found' });
    if (!doc.email) return res.status(400).json({ success: false, error: 'No email found for awardee' });

    try {
      const result = await sendTicketEmail({ entity: 'awardees', record: doc, options: { forceSend: true, includeBadge: true } });

      if (result && result.success) {
        await db.collection('awardees').updateOne({ _id: oid }, { $set: { ticket_email_sent_at: new Date() }, $unset: { ticket_email_failed: "" } });
        return res.json({ success: true, mail: { ok: true, info: result.info || null } });
      } else {
        await db.collection('awardees').updateOne({ _id: oid }, { $set: { ticket_email_failed: true, ticket_email_failed_at: new Date() } });
        return res.status(500).json({ success: false, mail: { ok: false, error: result && result.error ? result.error : 'ticket_send_failed' } });
      }
    } catch (e) {
      console.error('[awardees] send-ticket failed:', e && (e.stack || e));
      try {
        await db.collection('awardees').updateOne({ _id: oid }, { $set: { ticket_email_failed: true, ticket_email_failed_at: new Date() } });
      } catch { }
      return res.status(500).json({ success: false, error: 'Failed to send ticket email' });
    }
  } catch (e) {
    console.error('[awardees] send-ticket error:', e && (e.stack || e));
    return res.status(500).json({ success: false, error: 'Failed to send ticket email' });
  }
});

/**
 * GET /api/awardees
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10)));
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });
           const rows = await db.collection('awardees').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    
     const flattened = rows.map(r => {
      const flat = { ...r };
      if (flat.data && typeof flat.data === 'object') {
        for (const [key, value] of Object.entries(flat.data)) {
          if (!(key in flat) || flat[key] === undefined || flat[key] === null) {
            flat[key] = value;
          }
        }
      }
      // ✅ Ensure dates are serialized as ISO strings
      const output = docToOutput(flat);
      if (output.createdAt instanceof Date) output.createdAt = output.createdAt.toISOString();
      if (output.updatedAt instanceof Date) output.updatedAt = output.updatedAt.toISOString();
      return output;
    });
    
    return res.json(convertBigIntForJson(flattened));
  } catch (err) {
    console.error('[awardees] GET (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to fetch awardees' });
  }
});

/**
 * POST /api/awardees/send-reminders
 */
router.post('/send-reminders', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const cursor = db.collection('awardees').find({
      email: { $exists: true, $ne: "" }
    });

    let sent = 0;
    let failed = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      try {
        const subject = `Reminder: RailTrans Expo`;
        const text = `Hello ${doc.name || doc.organization || 'Participant'},

This is a reminder about RailTrans Expo. We will be in touch with further details soon. 

Regards,
RailTrans Expo Team`;

        const html = `
<p>Hello ${doc.name || doc.organization || 'Participant'},</p>
<p>This is a reminder about <strong>RailTrans Expo</strong>.  We will be in touch with further details soon.</p>
<p>Regards,<br/>RailTrans Expo Team</p>
`;

        await mailer.sendMail({
          to: doc.email,
          subject,
          text,
          html,
          from: process.env.MAIL_FROM || 'RailTrans Expo <support@railtransexpo.com>',
        });

        sent++;
      } catch (e) {
        failed++;
        console.error('[awardees] reminder failed for:', doc.email, e && e.message);
      }
    }

    return res.json({ success: true, sent, failed });
  } catch (err) {
    console.error('[awardees] send-reminders error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to send reminders' });
  }
});

/**
 * GET /api/awardees/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });

    const total = await db.collection('awardees').countDocuments({});
    const paid = await db.collection('awardees').countDocuments({ txId: { $exists: true, $ne: null, $ne: "" } });
    const free = await db.collection('awardees').countDocuments({ ticket_category: { $regex: /(free|general|^0$)/i } });

    return res.json({ total, paid, free });
  } catch (err) {
    console.error('[awardees] stats (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to compute stats' });
  }
});

/**
 * GET /api/awardees/: id
 */
router.get('/:id', async (req, res) => {
  try {
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'invalid id' });
    }
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });
      const doc = await db.collection('awardees').findOne({ _id: oid });
  } catch (err) {
    console.error('[awardees] GET/: id (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to fetch awardee' });
  }
});

/**
 * POST /api/awardees/:id/confirm
 */
router.post('/:id/confirm', express.json(), async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const id = req.params.id;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }

    const payload = { ...(req.body || {}) };
    const force = !!payload.force;
    delete payload.force;

    const existing = await db.collection('awardees').findOne({ _id: oid });
    if (!existing) return res.status(404).json({ success: false, error: 'Awardee not found' });


    const baseWhitelist = new Set([
      'ticket_code', 'ticket_category', 'txId', 'email', 'name',
      'organization', 'company', 'mobile', 'designation',
      'awardType', 'awardOther', 'bio'
    ]);

    const { originalNames, safeNames } = await loadAdminFields(db, 'awardee');
    for (const n of originalNames) baseWhitelist.add(n);
    for (const sn of safeNames) baseWhitelist.add(sn);

    const updateData = {};
    for (const k of Object.keys(payload || {})) {
      if (!baseWhitelist.has(k)) {
        const sk = safeFieldName(k);
        if (!sk || !baseWhitelist.has(sk)) continue;
        updateData[sk] = payload[k];
      } else {
        if (originalNames.has(k)) {
          const sn = safeFieldName(k);
          updateData[sn || k] = payload[k];
        } else {
          updateData[k] = payload[k];
        }
      }
    }


    if (updateData.organization && !updateData.company) {
      updateData.company = updateData.organization;
    }
    if (updateData.company && !updateData.organization) {
      updateData.organization = updateData.company;
    }

    if ('ticket_code' in updateData) {
      const incoming = updateData.ticket_code ? String(updateData.ticket_code).trim() : "";
      const existingCode = existing.ticket_code ? String(existing.ticket_code).trim() : "";
      if (!incoming) delete updateData.ticket_code;
      else if (existingCode && !force && incoming !== existingCode) delete updateData.ticket_code;
    }

    if (Object.keys(updateData).length === 0) {
      return res.json({ success: true, updated: docToOutput(existing), note: 'No changes applied (ticket_code protected)' });
    }

      updateData.updatedAt = new Date();
    await db.collection('awardees').updateOne({ _id: oid }, { $set: updateData });
    const after = await db.collection('awardees').findOne({ _id: oid });
    return res.json({ success: true, updated: docToOutput(after) });
  } catch (err) {
    console.error('[awardees] POST /:id/confirm (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to update awardee' });
  }
});
/**
 * PUT /api/awardees/:id
 */
router.put('/:id', express.json(), async (req, res) => {
  try {
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const data = { ...(req.body || {}) };
    delete data.id;
    delete data._id;
    delete data.title;


    const allowedBase = new Set([
      'name', 'email', 'mobile', 'designation', 'organization', 'company',
      'awardType', 'awardOther', 'bio', 'ticket_category', 'ticket_code',
      'txId', 'registered_at', 'created_at', 'status', 'proof_path'
    ]);

    const { originalNames, safeNames } = await loadAdminFields(db, 'awardee');
    for (const n of originalNames) allowedBase.add(n);
    for (const s of safeNames) allowedBase.add(s);

    const updateData = {};
    for (const [k, v] of Object.entries(data)) {
      if (!allowedBase.has(k)) {
        const sk = safeFieldName(k);
        if (!sk || !allowedBase.has(sk)) continue;
        if ((sk === 'registered_at' || sk === 'created_at') && v) {
          const d = new Date(v);
          if (!isNaN(d.getTime())) updateData[sk] = d;
          continue;
        }
        updateData[sk] = v;
        continue;
      }

      if ((k === 'registered_at' || k === 'created_at') && v) {
        const d = new Date(v);
        if (!isNaN(d.getTime())) {
          updateData[k] = d;
          continue;
        }
      }

      if (originalNames.has(k)) {
        const sn = safeFieldName(k);
        updateData[sn || k] = v;
      } else {
        updateData[k] = v;
      }
    }


    if (updateData.organization && !updateData.company) {
      updateData.company = updateData.organization;
    }
    if (updateData.company && !updateData.organization) {
      updateData.organization = updateData.company;
    }

    if (Object.keys(updateData).length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update.' });
    updateData.updatedAt = new Date();
    const r = await db.collection('awardees').updateOne({ _id: oid }, { $set: updateData });
    if (!r.matchedCount) return res.status(404).json({ success: false, error: 'Awardee not found' });

    const saved = await db.collection('awardees').findOne({ _id: oid });
    return res.json({ success: true, saved: docToOutput(saved) });
  } catch (err) {
    console.error('[awardees] PUT (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to update awardee', details: err && err.message });
  }
});

/**
 * POST /api/awardees/: id/upload-proof
 */
router.post('/:id/upload-proof', upload.single('proof'), async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const id = req.params.id;
    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }

    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const proofPath = path.relative(process.cwd(), req.file.path);
    await db.collection('awardees').updateOne({ _id: oid }, { $set: { proof_path: proofPath, updatedAt: new Date() } });

    return res.json({ success: true, file: { filename: req.file.filename, path: proofPath, size: req.file.size } });
  } catch (err) {
    console.error('[awardees] upload-proof (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to upload proof' });
  }
});

/**
 * DELETE /api/awardees/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const r = await db.collection('awardees').deleteOne({ _id: oid });
    if (!r.deletedCount) return res.status(404).json({ success: false, error: 'Awardee not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[awardees] DELETE (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to delete awardee' });
  }
});

module.exports = router;