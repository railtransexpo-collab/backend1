const express = require('express');
const router = express.Router();
const mongo = require('../utils/mongoClient'); // expects getDb() or .db

// Default speaker fields to show if admin config is empty or missing fields
const DEFAULT_SPEAKER_FIELDS = [
  { name: "name", label: "Full name", type: "text", required: true, visible: true },
  { name: "email", label: "Email", type: "email", required: true, visible: true, meta: { useOtp: true } },
  { name: "mobile", label: "Mobile", type: "text", required: false, visible: true },
  { name: "designation", label: "Designation", type: "text", required: false, visible: true },
  { name: "company", label: "Company / Organisation", type: "text", required: false, visible: true },
  { name: "topic", label: "Talk / Topic", type: "text", required: false, visible: true },
  { name: "bio", label: "Short bio", type: "textarea", required: false, visible: true }
];

/**
 * Helper: obtain a connected Db instance from utils/mongoClient
 */
async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === 'function') {
    const db = await mongo.getDb();
    return db;
  }
  if (mongo.db) return mongo.db;
  return null;
}


/**
 * Normalize admin config into a stable canonical shape used by the UI and stored in DB.
 * - Ensures fields array is normalized (name, label, type, options, visible, required)
 * - Removes any "accept_terms" style fields (these are handled centrally)
 * - Normalizes images/background/terms keys
 */
function canonicalizeConfig(cfg = {}) {
  const config = { ...(typeof cfg === 'object' && cfg !== null ? cfg : {}) };

  // Normalize fields
  config.fields = Array.isArray(config.fields)
    ? config.fields.map((f) => {
        const ff = typeof f === 'object' && f !== null ? { ...f } : {};
        ff.name = String(ff.name || '').trim();
        ff.label = String(ff.label || ff.name || '').trim();
        ff.type = String(ff.type || 'text').trim();
        ff.options = Array.isArray(ff.options) ? ff.options.map(o => (o === null || o === undefined) ? '' : String(o)) : [];
        ff.visible = typeof ff.visible === 'boolean' ? ff.visible : true;
        ff.required = !!ff.required;
        ff.meta = typeof ff.meta === 'object' && ff.meta !== null ? ff.meta : {};
        return ff;
      }).filter(Boolean)
    : [];

  // strip accept_terms / "I agree" checkbox defensively
  function isAcceptTermsField(f) {
    if (!f || !f.name && !f.label) return false;
    const name = String(f.name || '').toLowerCase().replace(/\s+/g, '');
    const label = String(f.label || '').toLowerCase();
    if (["accept_terms","acceptterms","i_agree","agree"].includes(name)) return true;
    if (f.type === "checkbox" && (label.includes("i agree") || label.includes("accept the terms") || label.includes("terms & conditions") || label.includes("terms and conditions"))) return true;
    return false;
  }
  config.fields = config.fields.filter(f => !isAcceptTermsField(f));

  // Ensure we always have an images array
  if (Array.isArray(config.images)) {
    config.images = config.images.map(i => (i === null || i === undefined) ? '' : String(i));
  } else if (config.images) {
    config.images = [String(config.images)];
  } else {
    config.images = [];
  }

  // Event details object
  config.eventDetails = typeof config.eventDetails === 'object' && config.eventDetails !== null ? config.eventDetails : {};

  // Background media normalization
  if (config.backgroundMedia && typeof config.backgroundMedia === 'object' && config.backgroundMedia.url) {
    config.backgroundMedia = { type: config.backgroundMedia.type || 'image', url: String(config.backgroundMedia.url) };
  } else if (config.backgroundVideo && config.backgroundVideo) {
    config.backgroundMedia = { type: 'video', url: String(config.backgroundVideo) };
  } else if (config.backgroundImage && config.backgroundImage) {
    config.backgroundMedia = { type: 'image', url: String(config.backgroundImage) };
  } else {
    config.backgroundMedia = { type: 'image', url: '' };
  }

  // Terms
  config.termsUrl = config.termsUrl || config.terms || config.terms_url || '';
  config.termsLabel = config.termsLabel || config.terms_label || 'Terms & Conditions';
  config.termsRequired = !!config.termsRequired;

  // Misc
  config.banner = config.banner || config.bannerUrl || config.banner_url || '';
  config.hostedByLogo = config.hostedByLogo || config.hosted_by_logo || '';
  config.backgroundColor = config.backgroundColor || config.background_color || '#ffffff';
  config.badgeTemplateUrl = config.badgeTemplateUrl || config.badge_template_url || '';

  return config;
}

/**
 * GET /api/speaker-config
 */
router.get('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      console.warn('[speaker-config] mongo db not available');
      // return a minimal canonical object including default fields
      const fallback = canonicalizeConfig({ fields: DEFAULT_SPEAKER_FIELDS.slice(), images: [] });
      return res.json(fallback);
    }

    const col = db.collection('registration_configs');
    const doc = await col.findOne({ page: 'speaker' });

    if (!doc || !doc.config) {
      // return defaults so admin UI shows fields
      const fallback = canonicalizeConfig({ fields: DEFAULT_SPEAKER_FIELDS.slice(), images: [] });
      return res.json(fallback);
    }

    const cfg = doc.config || {};
    const canonical = canonicalizeConfig(cfg);

    // Merge defaults for any missing commonly expected fields (non-destructive)
    try {
      const existing = new Set((canonical.fields || []).map(f => (f && f.name) ? f.name : ''));
      for (const def of DEFAULT_SPEAKER_FIELDS) {
        if (!existing.has(def.name)) canonical.fields.push({ ...def });
      }
    } catch (e) {
      // ignore merge errors
    }

    return res.json(canonical);
  } catch (err) {
    console.error('[speaker-config] GET error', err && (err.stack || err));
    const fallback = canonicalizeConfig({ fields: DEFAULT_SPEAKER_FIELDS.slice(), images: []  });
    return res.status(500).json(fallback);
  }
});

/**
 * POST /api/speaker-config/config
 * Upsert the speaker page config
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
      { page: 'speaker' },
      { $set: { config: canonical, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    return res.json({ success: true, config: canonical });
  } catch (err) {
    console.error('[speaker-config] POST error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database update failed' });
  }
});

/**
 * DELETE /api/speaker-config
 */
router.delete('/', async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) return res.status(500).json({ success: false, error: 'database not available' });
    const col = db.collection('registration_configs');
    await col.deleteOne({ page: 'speaker' });
    return res.json({ success: true, message: 'Speaker config deleted.' });
  } catch (err) {
    console.error('[speaker-config] DELETE error', err && (err.stack || err));
    return res.status(500).json({ success: false, error: 'Database delete failed' });
  }
});

module.exports = router;