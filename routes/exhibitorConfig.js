const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongoClient');

// Optional sync helper to manage dynamic fields (creates sparse indexes & tracks)
let syncFieldsToCollection = null;
try { syncFieldsToCollection = require('../utils/mongoSchemaSync').syncFieldsToCollection; } catch (e) { /* optional */ }

/* sensible default exhibitor fields (merged when admin config is empty) */
const DEFAULT_EXHIBITOR_FIELDS = [
  { name: "name", label: "Name", type: "text", required: true, visible: true },
  { name: "email", label: "Email", type: "email", required: true, visible: true, meta: { useOtp: true } },
  { name: "mobile", label: "Mobile No.", type: "text", required: true, visible: true },
  { name: "designation", label: "Designation", type: "text", required: false, visible: true },
  { name: "company", label: "Company / Organization", type: "text", required: false, visible: true },
  { name: "stall_size", label: "Stall / Booth Size", type: "select", options: ["3x3","3x6","6x6","Custom"], required: false, visible: true },
  { name: "product_category", label: "Product / Service Category", type: "text", required: false, visible: true },
];

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') {
    const db = await mongo.getDb();
    return db;
  }
  if (mongo.db) return mongo.db;
  return null;
}


function canonicalizeConfig(cfg = {}) {
  const config = { ...(typeof cfg === 'object' && cfg !== null ? cfg : {}) };

  config.fields = Array.isArray(config.fields)
    ? config.fields.map(f => {
        const ff = typeof f === 'object' && f !== null ? { ...f } : {};
        ff.name = String(ff.name || '').trim();
        ff.label = String(ff.label || ff.name || '').trim();
        ff.type = String(ff.type || 'text').trim();
        ff.options = Array.isArray(ff.options) ? ff.options.map(o => (o === null || o === undefined) ? '' : String(o)) : [];
        ff.visible = typeof ff.visible === 'boolean' ? ff.visible : true;
        ff.required = !!ff.required;
        ff.meta = typeof ff.meta === 'object' && ff.meta !== null ? ff.meta : {};
        return ff;
      }).filter(f => f && f.name)
    : [];

  // merge sensible defaults if none present
  try {
    if (!config.fields.length) {
      config.fields = DEFAULT_EXHIBITOR_FIELDS.slice();
    } else {
      const existing = new Set(config.fields.map(f => f.name));
      for (const def of DEFAULT_EXHIBITOR_FIELDS) {
        if (!existing.has(def.name)) config.fields.push({ ...def });
      }
    }
  } catch (e) {
    /* ignore merge errors */
  }

  config.images = Array.isArray(config.images) ? config.images.map(i => (i == null ? '' : String(i))) : (config.images ? [String(config.images)] : []);
  config.eventDetails = typeof config.eventDetails === 'object' && config.eventDetails !== null ? config.eventDetails : {};

  // normalize background media
  if (config.backgroundMedia && typeof config.backgroundMedia === 'object' && config.backgroundMedia.url) {
    config.backgroundMedia = { type: config.backgroundMedia.type || 'image', url: String(config.backgroundMedia.url) };
  } else if (config.backgroundVideo && config.backgroundVideo) {
    config.backgroundMedia = { type: 'video', url: String(config.backgroundVideo) };
  } else if (config.backgroundImage && config.backgroundImage) {
    config.backgroundMedia = { type: 'image', url: String(config.backgroundImage) };
  } else {
    config.backgroundMedia = config.backgroundMedia || { type: 'image', url: '' };
  }

  config.banner = config.banner || config.bannerUrl || config.banner_url || '';
  config.hostedByLogo = config.hostedByLogo || config.hosted_by_logo || '';
  config.termsUrl = config.termsUrl || config.terms || config.terms_url || '';
  config.termsLabel = config.termsLabel || config.terms_label || 'Terms & Conditions';
  config.termsRequired = !!config.termsRequired;
  config.backgroundColor = config.backgroundColor || config.background_color || '#ffffff';
  config.badgeTemplateUrl = config.badgeTemplateUrl || config.badge_template_url || '';

  return config;
}

/**
 * GET /api/exhibitor-config
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(200).json({ fields: [], images: []  });

    const col = db.collection('registration_configs');
    const doc = await col.findOne({ page: 'exhibitor' });
    if (!doc || !doc.config) {
      const fallback = canonicalizeConfig({ fields: DEFAULT_EXHIBITOR_FIELDS.slice(), images: [] });
      return res.json(fallback);
    }

    const canonical = canonicalizeConfig(doc.config || {});
    return res.json(canonical);
  } catch (err) {
    console.error('[exhibitor-config-mongo] GET error:', err && (err.stack || err));
    const fallback = canonicalizeConfig({ fields: DEFAULT_EXHIBITOR_FIELDS.slice(), images: []  });
    return res.status(500).json(fallback);
  }
});

/**
 * Internal helper used by POST and PUT
 */
async function upsertConfigAndSync(req, res) {
  try {
    const cfg = req.body || {};
    const canonical = canonicalizeConfig(cfg);

    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const col = db.collection('registration_configs');
    const now = new Date();
    await col.updateOne(
      { page: 'exhibitor' },
      { $set: { config: canonical, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    // attempt to sync dynamic fields into exhibitors collection (indexes & tracking)
    let syncResult = null;
    if (typeof syncFieldsToCollection === 'function') {
      try {
        syncResult = await syncFieldsToCollection('exhibitors', canonical.fields || []);
        console.log('[exhibitor-config-mongo] syncFieldsToCollection result:', syncResult);
      } catch (syncErr) {
        console.warn('[exhibitor-config-mongo] field sync failed:', syncErr && (syncErr.stack || syncErr));
      }
    }

    return res.json({ success: true, config: canonical, sync: syncResult });
  } catch (err) {
    console.error('[exhibitor-config-mongo] upsert error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database update failed' });
  }
}

/**
 * POST /api/exhibitor-config/config
 */
router.post('/config', express.json(), async (req, res) => {
  return upsertConfigAndSync(req, res);
});

/**
 * PUT /api/exhibitor-config
 * Accepts same payload as POST /config
 */
router.put('/', express.json(), async (req, res) => {
  return upsertConfigAndSync(req, res);
});

/**
 * DELETE /api/exhibitor-config
 */
router.delete('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('registration_configs');
    await col.deleteOne({ page: 'exhibitor' });
    return res.json({ success: true, message: 'Exhibitor config deleted.' });
  } catch (err) {
    console.error('[exhibitor-config-mongo] DELETE error:', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database delete failed' });
  }
});

module.exports = router;