/**
 * utils/registrations.js
 *
 * Ensures role-specific collections (visitors, exhibitors, partners, speakers, awardees).
 * - No 'registrants' central collection.
 * - Upserts by email within the target collection (if email present).
 * - Generates ticket_code and retries on collision.
 * - Logs mapping decisions for debugging.
 */

const mongo = require('./mongoClient');
const { safeFieldName } = require('./mongoSchemaSync'); // reuse normalization

async function obtainDb() {
  if (!mongo) throw new Error('mongoClient not available');
  if (typeof mongo.getDb === 'function') {
    const maybe = mongo.getDb();
    if (maybe && typeof maybe.then === 'function') return await maybe;
    return maybe;
  }
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient has no getDb/db');
}

function normalizeCollectionName(name = '') {
  if (!name) return null;
  let s = String(name).trim().toLowerCase();
  s = s.replace(/[^a-z0-9_\-]/g, '_').replace(/_+/g, '_');
  if (!s.endsWith('s')) s = `${s}s`;
  return s;
}

function mapTargetCollection(collectionName) {
  // Always map known roles to their own plural collection.
  const knownRoles = new Set(['visitor', 'exhibitor', 'partner', 'speaker', 'awardee']);
  if (!collectionName) return { target: 'visitors', role: 'visitor' };
  const raw = String(collectionName).trim().toLowerCase();
  if (!raw) return { target: 'visitors', role: 'visitor' };

  const singular = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  if (knownRoles.has(singular)) {
    return { target: `${singular}s`, role: singular };
  }

  // fallback: normalized plural of provided name
  return { target: normalizeCollectionName(raw) || raw, role: null };
}

/* ---------------- utilities ---------------- */

function generateTicketCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TICK-${code}`;
}

async function ensureTicketCodeUniqueIndex(db, collectionName = 'visitors') {
  try {
    const col = db.collection(collectionName);
    await col.createIndex({ ticket_code: 1 }, { unique: true, sparse: true, name: 'unique_ticket_code', background: true });
  } catch (err) {
    console.warn(`[registrations] ensureTicketCodeUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}
async function ensureEmailUniqueIndex(db, collectionName = 'visitors') {
  try {
    const col = db.collection(collectionName);
    await col.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'unique_email_sparse', background: true });
  } catch (err) {
    console.warn(`[registrations] ensureEmailUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

/* ---------------- core: saveRegistration ---------------- */

async function saveRegistration(collectionName, form = {}, options = {}) {
  if (!collectionName) throw new Error('collectionName required');
  const db = options.db || await obtainDb();
  if (!db) throw new Error('db not available');

  const { target: targetCollectionName, role } = mapTargetCollection(collectionName);

  // Debug/logging to confirm mapping at runtime
  if (process.env.DEBUG_REGISTRATIONS === 'true') {
    console.log(`[registrations] saveRegistration: requested='${collectionName}' -> target='${targetCollectionName}' role='${role}'`);
  }

  const allowedFields = Array.isArray(options.allowedFields) ? options.allowedFields : null;

  const mapped = {};
  const raw = form || {};
  let whitelist = null;
  if (Array.isArray(allowedFields)) {
    whitelist = new Set(allowedFields.map(f => (f && f.name ? safeFieldName(f.name) : null)).filter(Boolean));
  }

  for (const [k, v] of Object.entries(raw)) {
    if (k === '_rawForm') continue;
    const safe = (typeof safeFieldName === 'function')
      ? safeFieldName(k)
      : String(k).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!safe) continue;
    if (whitelist && !whitelist.has(safe)) continue;
    mapped[safe] = v === undefined ? null : v;
  }

  if (raw._rawForm && typeof raw._rawForm === 'object') {
    for (const [k, v] of Object.entries(raw._rawForm || {})) {
      const safe = (typeof safeFieldName === 'function') ? safeFieldName(k) : String(k).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
      if (!safe) continue;
      if (mapped[safe] === undefined) {
        if (whitelist && !whitelist.has(safe)) continue;
        mapped[safe] = v === undefined ? null : v;
      }
    }
  }

  const now = new Date();
  const baseDoc = { ...mapped, _rawForm: raw, updatedAt: now, createdAt: now };

  if (role) baseDoc.role = role;

  const col = db.collection(targetCollectionName);

  // best-effort index creation for this collection
  await ensureTicketCodeUniqueIndex(db, targetCollectionName);
  if (baseDoc.email) await ensureEmailUniqueIndex(db, targetCollectionName);

  // normalize email
  let emailNorm = null;
  const emailCandidates = ['email', 'email_address', 'emailAddress', 'contactEmail'];
  for (const k of emailCandidates) {
    if (baseDoc[k] && typeof baseDoc[k] === 'string') {
      emailNorm = baseDoc[k].trim().toLowerCase();
      baseDoc.email = emailNorm;
      break;
    }
  }

  // Upsert by email within the target collection if email present
  if (emailNorm) {
    const filter = { email: emailNorm };
    const setOnInsertDoc = { ...baseDoc };
    const update = { $setOnInsert: setOnInsertDoc, $set: { updatedAt: now } };

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!setOnInsertDoc.ticket_code) setOnInsertDoc.ticket_code = generateTicketCode();
      try {
        const opts = { upsert: true, returnDocument: 'after' };
        const result = await col.findOneAndUpdate(filter, update, opts);
        const finalDoc = result && result.value ? result.value : null;
        const insertedId = finalDoc && finalDoc._id ? String(finalDoc._id) : null;
        const existed = finalDoc && finalDoc.createdAt && finalDoc.createdAt < now;
        return { insertedId, doc: finalDoc, existed: !!existed };
      } catch (err) {
        const isDup = err && (err.code === 11000 || (err.errmsg && err.errmsg.indexOf('E11000') !== -1));
        if (isDup && attempt < maxAttempts) {
          setOnInsertDoc.ticket_code = generateTicketCode();
          continue;
        }
        if (isDup) {
          try {
            const existing = await col.findOne(filter);
            if (existing) return { insertedId: existing && existing._id ? String(existing._id) : null, doc: existing, existed: true };
          } catch (e2) {}
        }
        throw err;
      }
    }
    throw new Error('Failed to upsert registration after multiple attempts');
  }

  // No email => insert
  const maxAttemptsNoEmail = 6;
  for (let attempt = 1; attempt <= maxAttemptsNoEmail; attempt++) {
    if (!baseDoc.ticket_code) baseDoc.ticket_code = generateTicketCode();
    try {
      const r = await col.insertOne(baseDoc);
      const stored = await col.findOne({ _id: r.insertedId });
      const insertedId = r && r.insertedId ? String(r.insertedId) : null;
      return { insertedId, doc: stored || baseDoc, existed: false };
    } catch (err) {
      const isDup = err && (err.code === 11000 || (err.errmsg && err.errmsg.indexOf('E11000') !== -1));
      if (isDup && attempt < maxAttemptsNoEmail) {
        baseDoc.ticket_code = generateTicketCode();
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to save registration after attempts');
}

async function ensureIndexes(dbArg) {
  const db = dbArg || await obtainDb();
  try {
    const knownCollections = ['visitors', 'exhibitors', 'partners', 'speakers', 'awardees'];
    for (const coll of knownCollections) {
      await ensureTicketCodeUniqueIndex(db, coll);
      await ensureEmailUniqueIndex(db, coll);
    }
  } catch (e) {
    console.warn('ensureIndexes error', e && e.message);
  }
}

module.exports = {
  saveRegistration,
  mapTargetCollection,
  ensureEmailUniqueIndex,
  ensureTicketCodeUniqueIndex,
  generateTicketCode,
  ensureIndexes,
};