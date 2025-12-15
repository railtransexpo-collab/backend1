const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongoClient');

// Optional sync helper to create/drop sparse indexes & track dynamic fields
let syncFieldsToCollection = null;
try { syncFieldsToCollection = require('../utils/mongoSchemaSync').syncFieldsToCollection; } catch (e) { /* optional */ }

// sensible default awardee fields (used when config is empty or to fill missing fields)
const DEFAULT_AWARDEE_FIELDS = [
  { name: "nomination_for", label: "I would like to nominate for:", type: "select", options: ["Corporate Awards", "Individual Awards"], required: true, visible: true },
  { name: "name", label: "Full name", type: "text", required: true, visible: true },
  { name: "email", label: "Email", type: "email", required: true, visible: true },
  { name: "mobile", label: "Mobile No.", type: "text", required: true, visible: true, meta: { useOtp: true } },
  { name: "designation", label: "Designation", type: "text", required: false, visible: true },
  { name: "organization", label: "Organization / Company", type: "text", required: false, visible: true },
  { name: "awardType", label: "Award Type", type: "text", required: false, visible: true },
  { name: "awardOther", label: "Other (if selected)", type: "textarea", required: false, visible: true },
  { name: "bio", label: "Short Bio", type: "textarea", required: false, visible: true },
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
        ff.options = Array.isArray(ff.options) ? ff.options.map(o => (o == null ? '' : String(o))) : [];
        ff.visible = typeof ff.visible === 'boolean' ? ff.visible : true;
        ff.required = !!ff.required;
        ff.meta = typeof ff.meta === 'object' && ff.meta !== null ? ff.meta : {};
        return ff;
      }).filter(f => f && f.name)
    : [];

  // Merge defaults (non-destructive) so UI always shows sensible fields
  try {
    const existing = new Set((config.fields || []).map(f => f.name));
    for (const def of DEFAULT_AWARDEE_FIELDS) {
      if (!existing.has(def.name)) config.fields.push({ ...def });
    }
  } catch (e) {
    // ignore
  }

  config.images = Array.isArray(config.images) ? config.images.map(i => (i == null ? '' : String(i))) : (config.images ? [String(config.images)] : []);
  config.eventDetails = typeof config.eventDetails === 'object' && config.eventDetails !== null ? config.eventDetails : {};

  // background media normalization
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
 * GET /api/awardee-config
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.json({ fields: DEFAULT_AWARDEE_FIELDS.slice(), images: [] });

    const col = db.collection('registration_configs');
    const doc = await col.findOne({ page: 'awardee' });
    if (!doc || !doc.config) {
      const fallback = canonicalizeConfig({ fields: DEFAULT_AWARDEE_FIELDS.slice(), images: [] });
      return res.json(fallback);
    }
    const canonical = canonicalizeConfig(doc.config || {});
    return res.json(canonical);
  } catch (err) {
    console.error('[awardee-config-mongo] GET error', err && (err.stack || err));
    const fallback = canonicalizeConfig({ fields: DEFAULT_AWARDEE_FIELDS.slice(), images: [] });
    return res.status(500).json(fallback);
  }
});

/**
 * POST /api/awardee-config/config
 * Upsert awardee config and optionally sync dynamic fields into awardees collection
 */
router.post('/config', express.json(), async (req, res) => {
  try {
    const incoming = req.body || {};
    const canonical = canonicalizeConfig(incoming);

    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });

    const col = db.collection('registration_configs');
    const now = new Date();
    await col.updateOne(
      { page: 'awardee' },
      { $set: { config: canonical, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    let syncResult = null;
    if (typeof syncFieldsToCollection === 'function') {
      try {
        syncResult = await syncFieldsToCollection('awardees', canonical.fields || []);
        console.log('[awardee-config-mongo] syncFieldsToCollection result:', syncResult);
      } catch (syncErr) {
        console.warn('[awardee-config-mongo] field sync failed:', syncErr && (syncErr.stack || syncErr));
      }
    }

    return res.json({ success: true, config: canonical, sync: syncResult });
  } catch (err) {
    console.error('[awardee-config-mongo] POST error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database update failed' });
  }
});

/**
 * DELETE /api/awardee-config
 */
router.delete('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('registration_configs');
    await col.deleteOne({ page: 'awardee' });
    return res.json({ success: true, message: 'Awardee config deleted.' });
  } catch (err) {
    console.error('[awardee-config-mongo] DELETE error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database delete failed' });
  }
});

module.exports = router;