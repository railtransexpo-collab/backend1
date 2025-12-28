const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const mongo = require('../utils/mongoClient'); // must provide getDb() or .db

// parse JSON bodies for all routes in this router
router.use(express.json({ limit: '5mb' }));

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function toObjectId(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

function generateCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid similar-looking characters
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * GET /api/coupons
 * Query:
 *   status=all|used|unused (default: all)
 *   limit, skip optional
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');

    const status = (req.query.status || 'all').toLowerCase();
    const filter = {};
    if (status === 'used') filter.used = true;
    else if (status === 'unused') filter.used = { $ne: true };

    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10)));
    const skip = Math.max(0, parseInt(req.query.skip || '0', 10));

    const rows = await col.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray();
    const out = rows.map(r => {
      const copy = { ...r };
      if (copy._id) { copy.id = String(copy._id); delete copy._id; }
      return copy;
    });

    return res.json({ success: true, coupons: out });
  } catch (err) {
    console.error('GET /api/coupons error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to list coupons' });
  }
});

/**
 * POST /api/coupons
 * Body: { code?: string, discount: number } discount is percent e.g. 10 for 10%
 */
router.post('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const body = req.body || {};
    let code = body.code ? String(body.code).trim() : '';
    if (!code) {
      // try to generate unique code (try a few times)
      for (let i = 0; i < 6; i++) {
        const cand = generateCode(8);
        const exists = await col.findOne({ code: cand });
        if (!exists) { code = cand; break; }
      }
      if (!code) code = generateCode(10);
    } else code = code.toUpperCase();

    const discount = (typeof body.discount === 'number') ? body.discount : Number(body.discount || 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      return res.status(400).json({ success: false, error: 'invalid discount percent' });
    }

    const doc = {
      code,
      discount,
      created_at: new Date(),
      used: false,
      used_at: null,
      used_by: null,
      meta: body.meta || {}
    };

    const r = await col.insertOne(doc);
    const inserted = { ...doc, id: String(r.insertedId) };

    // log
    try {
      await logs.insertOne({ type: 'create', code, discount, created_at: new Date(), by: req.user ? req.user.id : 'admin' });
    } catch (e) { console.warn('coupon_logs insert failed', e && e.message); }

    return res.status(201).json({ success: true, coupon: inserted, insertedId: String(r.insertedId) });
  } catch (err) {
    console.error('POST /api/coupons error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to create coupon' });
  }
});

/**
 * POST /api/coupons/generate
 * Bulk generate coupons
 * Body: { count: number, discount: number }
 */
router.post('/generate', async (req, res) => {
  try {
    const { count = 10, discount = 10 } = req.body || {};
    const cnt = Math.max(1, Math.min(500, parseInt(count, 10) || 10));
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const out = [];
    for (let i = 0; i < cnt; i++) {
      let code;
      for (let t = 0; t < 8; t++) {
        const cand = generateCode(8);
        // quick uniqueness check
        // don't await many times; keep it simple
        const exists = await col.findOne({ code: cand });
        if (!exists) { code = cand; break; }
      }
      if (!code) code = generateCode(10);
      const doc = { code, discount: Number(discount), created_at: new Date(), used: false, used_at: null, used_by: null, meta: {} };
      const r = await col.insertOne(doc);
      out.push({ ...doc, id: String(r.insertedId) });

      try {
        await logs.insertOne({ type: 'generate', code, discount: Number(discount), created_at: new Date(), by: req.user ? req.user.id : 'admin' });
      } catch (e) {}
    }

    return res.json({ success: true, coupons: out, count: out.length });
  } catch (err) {
    console.error('POST /api/coupons/generate error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to generate coupons' });
  }
});

/**
 * DELETE /api/coupons/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const oid = toObjectId(id);
    if (!oid) return res.status(400).json({ success: false, error: 'invalid id' });
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const r = await col.deleteOne({ _id: oid });
    if (r.deletedCount === 0) return res.status(404).json({ success: false, error: 'coupon not found' });

    try { await logs.insertOne({ type: 'delete', couponId: String(id), created_at: new Date(), by: req.user ? req.user.id : 'admin' }); } catch (e) {}

    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/coupons/:id error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to delete coupon' });
  }
});

/**
 * POST /api/coupons/:id/use
 * Body: { used_by?: string } -- marks coupon as used
 */
router.post('/:id/use', async (req, res) => {
  try {
    const id = req.params.id;
    const oid = toObjectId(id);
    if (!oid) return res.status(400).json({ success: false, error: 'invalid id' });
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const coupon = await col.findOne({ _id: oid });
    if (!coupon) return res.status(404).json({ success: false, error: 'coupon not found' });
    if (coupon.used) return res.status(400).json({ success: false, error: 'coupon already used' });

    const usedBy = req.body && req.body.used_by ? String(req.body.used_by) : null;
    const update = { $set: { used: true, used_at: new Date(), used_by: usedBy } };
    await col.updateOne({ _id: oid }, update);

    try { await logs.insertOne({ type: 'use', couponId: String(id), code: coupon.code, used_by: usedBy, created_at: new Date(), by: req.user ? req.user.id : 'admin' }); } catch (e) {}

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/coupons/:id/use error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to mark coupon used' });
  }
});

/**
 * POST /api/coupons/:id/unuse
 * Unmark used (admin only)
 */
router.post('/:id/unuse', async (req, res) => {
  try {
    const id = req.params.id;
    const oid = toObjectId(id);
    if (!oid) return res.status(400).json({ success: false, error: 'invalid id' });
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const coupon = await col.findOne({ _id: oid });
    if (!coupon) return res.status(404).json({ success: false, error: 'coupon not found' });
    if (!coupon.used) return res.status(400).json({ success: false, error: 'coupon is not used' });

    await col.updateOne({ _id: oid }, { $set: { used: false, used_at: null, used_by: null } });

    try { await logs.insertOne({ type: 'unuse', couponId: String(id), code: coupon.code, created_at: new Date(), by: req.user ? req.user.id : 'admin' }); } catch (e) {}

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/coupons/:id/unuse error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to unmark coupon' });
  }
});

/**
 * POST /api/coupons/validate
 * Body: { code: string, price?: number, markUsed?: boolean, used_by?: string }
 * Returns: { valid: boolean, discount: number, reducedPrice?: number, details: {...} }
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, price, markUsed = false, used_by = null } = req.body || {};
    if (!code || !String(code).trim()) return res.status(400).json({ valid: false, error: 'code required' });
    const db = await obtainDb();
    if (!db) return res.status(500).json({ valid: false, error: 'database not available' });
    const col = db.collection('coupons');
    const logs = db.collection('coupon_logs');

    const coupon = await col.findOne({ code: String(code).trim().toUpperCase() });
    if (!coupon) return res.json({ valid: false, error: 'invalid code' });
    if (coupon.used) return res.json({ valid: false, error: 'coupon already used', coupon: { id: String(coupon._id), code: coupon.code, used: true } });

    const discount = Number(coupon.discount || 0);
    let reducedPrice = undefined;
    if (typeof price === 'number' && Number.isFinite(price)) {
      reducedPrice = Math.max(0, +(price - (price * (discount / 100))).toFixed(2));
    }

    if (markUsed) {
      await col.updateOne({ _id: coupon._id }, { $set: { used: true, used_at: new Date(), used_by: used_by || 'admin' } });
      try { await logs.insertOne({ type: 'use-from-validate', couponId: String(coupon._id), code: coupon.code, used_by: used_by || 'admin', created_at: new Date() }); } catch (e) {}
    }

    return res.json({ valid: true, discount, reducedPrice, coupon: { id: String(coupon._id), code: coupon.code, used: !!coupon.used } });
  } catch (err) {
    console.error('POST /api/coupons/validate error', err && (err.stack || err));
    return res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

/**
 * GET /api/coupons/logs
 */
router.get('/logs', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(200).json({ success: true, logs: [] });
    const col = db.collection('coupon_logs');
    const rows = await col.find({}).sort({ created_at: -1 }).limit(1000).toArray();
    return res.json({ success: true, logs: rows });
  } catch (err) {
    console.error('GET /api/coupons/logs error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

module.exports = router;