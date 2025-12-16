// utils/registrations.js
// Centralized registration save helper that:
// - Normalizes entity collection names (visitors/exhibitors/partners/speakers/awardees)
//   to a single 'registrants' collection (role: singular).
// - Generates a ticket_code for new records (TICK-<6 alnum>), retries on duplicate key.
// - Uses idempotent upsert when email present (filter includes role to avoid cross-role collisions).
// - Creates best-effort unique sparse indexes on email and ticket_code.
//
// Usage:
//   const { saveRegistration, ensureIndexes } = require('./utils/registrations');
//   await saveRegistration('visitors', form, { allowedFields, db }); // returns { insertedId, doc, existed }
//   await ensureIndexes(db); // optional at startup

const mongo = require('./mongoClient');
const { safeFieldName } = require('./mongoSchemaSync'); // reuse normalization if available

async function obtainDb() {
  if (!mongo) throw new Error('mongoClient not available');
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient has no getDb/db');
}

function singularizeRole(collName = '') {
  if (!collName) return 'visitor';
  const s = String(collName).trim().toLowerCase();
  if (s.endsWith('s')) return s.slice(0, -1);
  return s;
}

function mapTargetCollection(collectionName) {
  const name = (collectionName || '').toString().trim().toLowerCase();
  const singular = name.endsWith('s') ? name.slice(0, -1) : name;

  const knownRoles = new Set(['visitor','exhibitor','partner','speaker','awardee']);

  if (!name) return { target: 'registrants', role: 'visitor' };
  if (name === 'registrants' || singular === 'registrant') return { target: 'registrants', role: 'visitor' };
  if (knownRoles.has(singular)) return { target: 'registrants', role: singular };

  // fallback: keep original name
  return { target: name, role: null };
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

async function ensureTicketCodeUniqueIndex(db, collectionName = 'registrants') {
  try {
    const col = db.collection(collectionName);
    await col.createIndex(
      { ticket_code: 1 },
      { unique: true, sparse: true, name: 'unique_ticket_code', background: true }
    );
  } catch (err) {
    console.warn(`[registrations] ensureTicketCodeUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

async function ensureEmailUniqueIndex(db, collectionName = 'registrants') {
  try {
    const col = db.collection(collectionName);
    await col.createIndex(
      { email: 1 },
      { unique: true, sparse: true, name: 'unique_email_sparse', background: true }
    );
  } catch (err) {
    console.warn(`[registrations] ensureEmailUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

/* ---------------- core: saveRegistration ---------------- */
/**
 * saveRegistration(collectionName, form, options)
 * - collectionName: desired logical collection (visitors, exhibitors, partners, speakers, awardees, registrants, tickets)
 * - form: object with submitted fields
 * - options:
 *      { allowedFields: array } optional admin fields to whitelist (names expected un-normalized)
 *      { db }    optional Mongo Db instance (if caller has one)
 *
 * Behavior:
 * - If collectionName maps to 'registrants' (common case), we store documents in that collection
 *   and set doc.role to the singular role (visitor/exhibitor/...).
 * - If email present, do idempotent upsert on { email, role } for registrants target.
 * - New documents get ticket_code generated (TICK-xxxxxx) and createdAt/updatedAt set.
 *
 * Returns: { insertedId, doc, existed } where doc is the document from DB after save.
 */
async function saveRegistration(collectionName, form = {}, options = {}) {
  if (!collectionName) throw new Error('collectionName required');
  const db = options.db || await obtainDb();
  if (!db) throw new Error('db not available');

  // Map logical collection name to physical collection and role
  const { target: targetCollectionName, role } = mapTargetCollection(collectionName);

  const allowedFields = Array.isArray(options.allowedFields) ? options.allowedFields : null;

  // Map form to normalized doc (reuse safeFieldName if present)
  const mapped = {};
  const raw = form || {};
  // whitelist if provided
  let whitelist = null;
  if (Array.isArray(allowedFields)) {
    whitelist = new Set(allowedFields.map(f => (f && f.name ? safeFieldName(f.name) : null)).filter(Boolean));
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_rawForm') continue;
    const safe = (typeof safeFieldName === 'function') ? safeFieldName(k) : String(k).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!safe) continue;
    if (whitelist && !whitelist.has(safe)) continue;
    mapped[safe] = v === undefined ? null : v;
  }
  // nested _rawForm merge
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

  // Base doc
  const now = new Date();
  const baseDoc = { ...mapped, _rawForm: raw, updatedAt: now, createdAt: now };

  // Attach role if target is registrants
  if (role) baseDoc.role = role;

  const col = db.collection(targetCollectionName);

  // Ensure indexes for registrants target (best-effort)
  if (targetCollectionName === 'registrants') {
    await ensureTicketCodeUniqueIndex(db, 'registrants');
    if (baseDoc.email) await ensureEmailUniqueIndex(db, 'registrants');
  } else {
    // ensure ticket_code index on other collections if you expect codes there
    await ensureTicketCodeUniqueIndex(db, targetCollectionName).catch(()=>{});
  }

  // Normalize email if present in common keys
  let emailNorm = null;
  const emailCandidates = ['email', 'email_address', 'emailAddress', 'contactEmail'];
  for (const k of emailCandidates) {
    if (baseDoc[k] && typeof baseDoc[k] === 'string') {
      emailNorm = baseDoc[k].trim().toLowerCase();
      baseDoc.email = emailNorm;
      break;
    }
  }

  // If we have email and target is registrants -> idempotent upsert using (email + role)
  if (emailNorm && targetCollectionName === 'registrants') {
    const filter = { email: emailNorm, role: baseDoc.role };
    // Prepare $setOnInsert doc: don't include updatedAt (we set later)
    const setOnInsertDoc = { ...baseDoc };
    // Remove fields we don't want to set on insert via $setOnInsert if necessary (keep createdAt/ticket_code etc)
    const update = { $setOnInsert: setOnInsertDoc, $set: { updatedAt: now } };
    // Try upsert with retry on ticket_code collisions
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // ensure a ticket_code exists in $setOnInsert
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
          // regenerate ticket_code and retry
          setOnInsertDoc.ticket_code = generateTicketCode();
          continue;
        }
        // if it's a duplicate on email/role (unlikely), try to return existing
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

  // No email or not registrants target -> do a single insert (but guard ticket_code uniqueness)
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
        // try again with different code
        baseDoc.ticket_code = generateTicketCode();
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to save registration after attempts');
}

/**
 * ensureIndexes(db)
 * - convenience helper to create best-effort indexes on registrants collection.
 * - call once at app startup if desired.
 */
async function ensureIndexes(dbArg) {
  const db = dbArg || await obtainDb();
  try {
    await ensureTicketCodeUniqueIndex(db, 'registrants');
    await ensureEmailUniqueIndex(db, 'registrants');
  } catch (e) {
    console.warn('ensureIndexes error', e && e.message);
  }
}

module.exports = {
  saveRegistration,
  mapFormToDoc, // keep for compatibility (mapFormToDoc inlined earlier; reuse if you prefer)
  ensureEmailUniqueIndex,
  ensureTicketCodeUniqueIndex,
  generateTicketCode,
  ensureIndexes,
};