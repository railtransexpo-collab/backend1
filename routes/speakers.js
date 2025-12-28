const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const mongo = require('../utils/mongoClient'); // must expose getDb() or .db
const mailer = require('../utils/mailer'); // expects sendMail(opts) -> { success, info?, error?, dbRecordId? }

// parse JSON bodies for routes in this router
router.use(express.json({ limit: '6mb' }));

/* ---------- helpers ---------- */
async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function toIsoMysqlLike(val) {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(val)) return val;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace('T', ' ').substring(0, 19);
  } catch {
    return null;
  }
}

function docToOutput(doc) {
  if (!doc) return null;
  const out = { ...doc };
  if (out._id) {
    out.id = String(out._id);
    delete out._id;
  } else {
    out.id = null;
  }
  return out;
}

function generateTicketCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

/* Try to require server-side buildTicketEmail if present (your frontend template supports Node) */
let serverBuildTicketEmail = null;
try {
  const tmpl = require('../utils/emailTemplate');
  if (tmpl && typeof tmpl.buildTicketEmail === 'function') serverBuildTicketEmail = tmpl.buildTicketEmail;
} catch (e) {
  serverBuildTicketEmail = null;
}

/* Minimal server-side email builder fallback for speakers */
function buildSimpleSpeakerEmail({ frontendBase = '', id = '', name = '', ticket_code = '' } = {}) {
  const fb = String(frontendBase || process.env.FRONTEND_BASE || '').replace(/\/$/, '');
  const downloadUrl = fb
    ? `${fb}/ticket-download?entity=${encodeURIComponent('speakers')}&${id ? `id=${encodeURIComponent(String(id))}` : `ticket_code=${encodeURIComponent(String(ticket_code || ''))}`}`
    : 'ticket_download_unavailable';

  const subject = `RailTrans Expo — Thank you for registering as a Speaker`;
  const text = [
    `Hello ${name || 'Speaker'},`,
    '',
    `Thank you for registering for RailTrans Expo.`,
    ticket_code ? `Your registration code: ${ticket_code}` : '',
    `Download your e-badge: ${downloadUrl}`,
    '',
    'Regards,',
    'RailTrans Expo Team',
  ].filter(Boolean).join('\n');

  const html = `<p>Hello ${name || 'Speaker'},</p>
<p>Thank you for registering for RailTrans Expo.</p>
${ticket_code ? `<p><strong>Your registration code:</strong> ${ticket_code}</p>` : ''}
<p><a href="${downloadUrl}" target="_blank" rel="noopener noreferrer">Download your e-badge</a></p>
<p>Regards,<br/>RailTrans Expo Team</p>`;

  return { subject, text, html };
}

/* ---------- Routes ---------- */

/**
 * POST /api/speakers
 * Create new speaker and attempt to send confirmation email server-side.
 * Response includes { success, insertedId, ticket_code, saved, mail }
 */
router.post('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const payload = { ...(req.body || {}) };

    // normalize slots if provided as JSON string
    if (typeof payload.slots === 'string') {
      try { payload.slots = JSON.parse(payload.slots); } catch { /* keep as string */ }
    }

    // Build document (keep minimal top-level fields)
    const doc = {
      name: payload.name || payload.fullName || '',
      email: (payload.email || '').toString().trim(),
      mobile: payload.mobile || payload.phone || '',
      designation: payload.designation || '',
      company: payload.company || '',
      ticket_category: payload.ticket_category || payload.ticketCategory || '',
      slots: Array.isArray(payload.slots) ? payload.slots : [],
      category: payload.category || '',
      txId: payload.txId || payload.txid || null,
      other_details: payload.other_details || payload.otherDetails || '',
      created_at: new Date(),
      registered_at: payload.registered_at ? new Date(payload.registered_at) : new Date(),
      // preserve admin flag if present
      added_by_admin: !!payload.added_by_admin,
      admin_created_at: payload.added_by_admin ? (payload.admin_created_at || new Date().toISOString()) : undefined,
    };

    // ticket_code: allow incoming, else generate
    doc.ticket_code = payload.ticket_code || payload.ticketCode || generateTicketCode();

    // Insert document
    const col = db.collection('speakers');
    const r = await col.insertOne(doc);
    const insertedId = r.insertedId ? String(r.insertedId) : null;

    // ensure ticket_code persisted
    if (doc.ticket_code && r && r.insertedId) {
      try { await col.updateOne({ _id: r.insertedId }, { $set: { ticket_code: doc.ticket_code } }); } catch (e) { /* ignore */ }
    }

    // prepare response object
    const saved = await col.findOne({ _id: r.insertedId });
    const output = docToOutput(saved);

    // Attempt to send confirmation email server-side (best-effort)
    let mailResult = null;
    try {
      const frontendBase = process.env.FRONTEND_BASE || '';
      if (serverBuildTicketEmail) {
        // server-side HTML template available — use it
        try {
          const model = {
            frontendBase,
            entity: 'speakers',
            id: insertedId,
            name: doc.name || '',
            company: doc.company || '',
            ticket_category: doc.ticket_category || '',
            badgePreviewUrl: '',
            downloadUrl: '',
            logoUrl: '',
            form: doc || {},
            pdfBase64: null,
          };
          const tpl = await serverBuildTicketEmail(model);
          const sendRes = await mailer.sendMail({
            to: doc.email,
            subject: tpl.subject || 'RailTrans Expo — Registration',
            text: tpl.text || '',
            html: tpl.html || '',
            attachments: tpl.attachments || [],
          });
          if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
          else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : 'send failed', dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
        } catch (e) {
          // fallback to simple email if template build or send fails
          const minimal = buildSimpleSpeakerEmail({ frontendBase, id: insertedId, name: doc.name || '', ticket_code: doc.ticket_code || '' });
          const sendRes = await mailer.sendMail({ to: doc.email, subject: minimal.subject, text: minimal.text, html: minimal.html, attachments: [] });
          if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
          else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : 'send failed', dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
        }
      } else {
        // no server template — use simple fallback
        const minimal = buildSimpleSpeakerEmail({ frontendBase, id: insertedId, name: doc.name || '', ticket_code: doc.ticket_code || '' });
        const sendRes = await mailer.sendMail({ to: doc.email, subject: minimal.subject, text: minimal.text, html: minimal.html, attachments: [] });
        if (sendRes && sendRes.success) mailResult = { ok: true, info: sendRes.info, dbRecordId: sendRes.dbRecordId };
        else mailResult = { ok: false, error: sendRes && sendRes.error ? sendRes.error : 'send failed', dbRecordId: sendRes && sendRes.dbRecordId ? sendRes.dbRecordId : null };
      }
    } catch (mailErr) {
      mailResult = { ok: false, error: String(mailErr && (mailErr.message || mailErr)) };
    }

    // return saved document and mail result
    return res.json({
      success: true,
      insertedId,
      ticket_code: doc.ticket_code,
      saved: output,
      mail: mailResult,
    });
  } catch (err) {
    console.error('POST /api/speakers (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to create speaker' });
  }
});

/**
 * POST /api/speakers/:id/resend-email
 * Resend confirmation email for speaker using server template if available
 */

/* ---------- Existing speaker CRUD routes (list, get, confirm, put, delete) ---------- */

/**
 * GET /api/speakers
 * Get all speakers (limit 1000)
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ error: 'database not available' });

    const col = db.collection('speakers');
    const cursor = col.find({}).sort({ created_at: -1 }).limit(1000);
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
 * POST /api/speakers/:id/confirm
 * Defensive confirm endpoint - does not overwrite ticket_code unless force=true
 */
router.post('/:id/confirm', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'Missing speaker id' });

    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    let oid;
    try { oid = new ObjectId(id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const col = db.collection('speakers');
    const existing = await col.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ success: false, error: 'Speaker not found' });

    const payload = { ...(req.body || {}) };
    const force = !!payload.force;
    delete payload.force;

    // whitelist of fields allowed to update
    const whitelist = new Set(['ticket_code', 'ticket_category', 'txId', 'email', 'name', 'company', 'mobile', 'designation', 'slots', 'other_details']);

    const updateData = {};
    for (const k of Object.keys(payload || {})) {
      if (!whitelist.has(k)) continue;
      updateData[k] = payload[k];
    }

    // defensive ticket_code handling
    if ('ticket_code' in updateData) {
      const incoming = updateData.ticket_code ? String(updateData.ticket_code).trim() : '';
      const existingCode = existing.ticket_code ? String(existing.ticket_code).trim() : '';
      if (!incoming) {
        delete updateData.ticket_code;
      } else if (existingCode && !force && incoming !== existingCode) {
        // keep existing unless force true
        delete updateData.ticket_code;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.json({ success: true, updated: docToOutput(existing), note: 'No changes applied (ticket_code protected)' });
    }

    // normalize slots
    if (updateData.slots && typeof updateData.slots === 'string') {
      try { updateData.slots = JSON.parse(updateData.slots); } catch { /* leave as-is */ }
    }

    updateData.updated_at = new Date();

    await col.updateOne({ _id: oid }, { $set: updateData });

    const after = await col.findOne({ _id: oid });
    return res.json({ success: true, updated: docToOutput(after) });
  } catch (err) {
    console.error('POST /api/speakers/:id/confirm (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to update speaker' });
  }
});

/**
 * PUT /api/speakers/:id
 * General update
 */
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let oid;
    try { oid = new ObjectId(id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const payload = { ...(req.body || {}) };
    delete payload.id;
    delete payload.title;

    // Allowed fields - mirror DB columns you had previously
    const allowed = new Set(['name','email','mobile','designation','company','company_type','other_details','purpose','ticket_category','ticket_label','ticket_price','ticket_gst','ticket_total','slots','category','txId','ticket_code','registered_at','created_at']);

    const updateData = {};
    for (const k of Object.keys(payload)) {
      if (!allowed.has(k)) continue;
      updateData[k] = payload[k];
    }

    if ('registered_at' in updateData) {
      const v = toIsoMysqlLike(updateData.registered_at);
      if (v) updateData.registered_at = new Date(v.replace(' ', 'T'));
      else delete updateData.registered_at;
    }
    if ('created_at' in updateData) {
      const v = toIsoMysqlLike(updateData.created_at);
      if (v) updateData.created_at = new Date(v.replace(' ', 'T'));
      else delete updateData.created_at;
    }

    if (Object.keys(updateData).length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update.' });

    updateData.updated_at = new Date();

    // normalize slots if string
    if (updateData.slots && typeof updateData.slots === 'string') {
      try { updateData.slots = JSON.parse(updateData.slots); } catch { /* ignore */ }
    }

    const col = db.collection('speakers');
    await col.updateOne({ _id: oid }, { $set: updateData });

    return res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/speakers/:id (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to update speaker', details: err && err.message });
  }
});

/**
 * DELETE /api/speakers/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let oid;
    try { oid = new ObjectId(id); } catch { return res.status(400).json({ success: false, error: 'invalid id' }); }

    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const col = db.collection('speakers');
    await col.deleteOne({ _id: oid });
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/speakers/:id (mongo) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to delete speaker' });
  }
});

module.exports = router;