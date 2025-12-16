// registrations.js
// saveRegistration + helpers with ticket_code generation and uniqueness retry

const mongo = require('./mongoClient');
const { safeFieldName } = require('./mongoSchemaSync'); // re-use the same normalization

async function obtainDb() {
  if (!mongo) throw new Error('mongoClient not available');
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient has no getDb/db');
}

/**
 * mapFormToDoc(form, allowedFields)
 * - form: object (raw submitted form)
 * - allowedFields: optional array of admin field objects (with .name) to whitelist only fields admin configured
 *
 * Returns an object with mapped normalized field names and _rawForm preserved.
 */
function mapFormToDoc(form = {}, allowedFields = null) {
  const doc = {};
  const raw = form || {};

  // build whitelist set of safe names if allowedFields provided
  let whitelist = null;
  if (Array.isArray(allowedFields)) {
    whitelist = new Set(
      allowedFields
        .map(f => (f && f.name ? safeFieldName(f.name) : null))
        .filter(Boolean)
    );
  }

  for (const [k, v] of Object.entries(raw)) {
    if (k === '_rawForm') continue;
    const safe = safeFieldName(k);
    if (!safe) continue;
    // if whitelist exists, skip fields not in it
    if (whitelist && !whitelist.has(safe)) continue;
    // store value as-is (you may sanitize/coerce here)
    doc[safe] = v === undefined ? null : v;
  }

  // Also coerce nested _rawForm keys (if front-end already provided nested)
  // but avoid overwriting mapped keys
  if (raw._rawForm && typeof raw._rawForm === 'object') {
    for (const [k, v] of Object.entries(raw._rawForm || {})) {
      const safe = safeFieldName(k);
      if (!safe) continue;
      if (doc[safe] === undefined) {
        if (whitelist && !whitelist.has(safe)) continue;
        doc[safe] = v === undefined ? null : v;
      }
    }
  }

  // Attach the raw payload for later debugging / email templates / admin
  doc._rawForm = raw;
  return doc;
}

/**
 * Ensure a unique sparse index on 'email' for the given collection.
 * - uses sparse:true so docs without email are allowed.
 */
async function ensureEmailUniqueIndex(db, collectionName) {
  try {
    const col = db.collection(collectionName);
    // create unique sparse index on email (create if not exists)
    await col.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'unique_email_sparse' });
  } catch (err) {
    // log but don't fail the flow; index creation may fail if existing duplicates exist
    console.warn(`[registrations] ensureEmailUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

/**
 * Ensure a unique sparse index on 'ticket_code' for the given collection.
 * - sparse:true so legacy docs without ticket_code won't block index creation.
 */
async function ensureTicketCodeUniqueIndex(db, collectionName) {
  try {
    const col = db.collection(collectionName);
    await col.createIndex({ ticket_code: 1 }, { unique: true, sparse: true, name: 'unique_ticket_code' });
  } catch (err) {
    console.warn(`[registrations] ensureTicketCodeUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

/**
 * Generate a ticket code e.g. TICK-AB12CD
 */
function generateTicketCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TICK-${code}`;
}

/**
 * saveRegistration(collectionName, form, options)
 * - collectionName: e.g. 'visitors', 'exhibitors', 'partners', 'awardees', 'speakers'
 * - form: object submitted from front-end
 * - options: { allowedFields: array } optional admin fields (use to whitelist)
 *
 * Uses idempotent upsert when email is present to avoid duplicates.
 * Adds ticket_code for new documents and ensures uniqueness (with retry).
 * Returns { insertedId, doc, existed }
 */
async function saveRegistration(collectionName, form = {}, options = {}) {
  if (!collectionName) throw new Error('collectionName required');
  const db = await obtainDb();
  const col = db.collection(collectionName);

  const allowedFields = Array.isArray(options.allowedFields) ? options.allowedFields : null;
  const mapped = mapFormToDoc(form, allowedFields);

  // NOTE: Do not set createdAt directly on mapped before deciding insert vs update.
  // We'll prepare docToInsert for $setOnInsert to ensure it only applies on insert.
  const now = new Date();
  const baseDoc = { ...mapped }; // shallow copy
  baseDoc.createdAt = now;
  baseDoc.updatedAt = now;

  // Normalize email field if present
  let emailNorm = null;
  if (baseDoc.email && typeof baseDoc.email === 'string') {
    emailNorm = baseDoc.email.trim().toLowerCase();
    baseDoc.email = emailNorm;
  } else if (baseDoc.email_address && typeof baseDoc.email_address === 'string') {
    emailNorm = baseDoc.email_address.trim().toLowerCase();
    baseDoc.email = emailNorm;
    delete baseDoc.email_address;
  }

  // Ensure ticket_code index exists (best-effort)
  await ensureTicketCodeUniqueIndex(db, collectionName);

  // If we have an email, try an idempotent upsert (atomic) to avoid duplicates
  if (emailNorm) {
    // Ensure there's a unique sparse index on email (best-effort)
    await ensureEmailUniqueIndex(db, collectionName);

    // We'll attempt to upsert with ticket_code generation, retrying on duplicate key (ticket_code) up to maxAttempts.
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // For each attempt generate a fresh ticket code if not already provided in incoming form
      const docToInsert = { ...baseDoc };
      if (!docToInsert.ticket_code) {
        docToInsert.ticket_code = generateTicketCode();
      }

      try {
        // Use findOneAndUpdate with upsert and $setOnInsert to avoid overwriting existing doc
        const filter = { email: emailNorm };
        const update = { $setOnInsert: docToInsert, $set: { updatedAt: now } };
        const opts = { upsert: true, returnDocument: 'after' }; // node-driver v4: returnDocument: 'after'
        const result = await col.findOneAndUpdate(filter, update, opts);

        const finalDoc = result && result.value ? result.value : null;
        const insertedId = finalDoc && finalDoc._id ? String(finalDoc._id) : null;

        // Determine whether the doc existed before (if createdAt older than our now)
        const existed = finalDoc && finalDoc.createdAt && finalDoc.createdAt < now;

        return { insertedId, doc: finalDoc, existed: !!existed };
      } catch (err) {
        // If duplicate key error due to ticket_code collision, retry with a new code.
        const isDup = err && (err.code === 11000 || (err.errmsg && err.errmsg.indexOf('E11000') !== -1));
        if (isDup && attempt < maxAttempts) {
          // continue to next attempt with a new code
          continue;
        }

        // If duplicate and we've exhausted attempts, try to find the existing doc by email and return it
        if (isDup) {
          try {
            const existing = await col.findOne({ email: emailNorm });
            if (existing) {
              return { insertedId: existing && existing._id ? String(existing._id) : null, doc: existing, existed: true };
            }
          } catch (e2) {
            // fallthrough to throw original
          }
        }

        // propagate error
        throw err;
      }
    } // end attempts loop
  }

  // If no email present, we can't upsert idempotently — insert once.
  // We'll attempt to add ticket_code and retry on duplicate ticket_code collisions.
  const maxAttemptsNoEmail = 5;
  for (let attempt = 1; attempt <= maxAttemptsNoEmail; attempt++) {
    const docToInsert = { ...baseDoc };
    if (!docToInsert.ticket_code) {
      docToInsert.ticket_code = generateTicketCode();
    }
    try {
      const r = await col.insertOne(docToInsert);
      const insertedId = r && r.insertedId ? String(r.insertedId) : null;
      // Return the doc as stored (note: inserted doc won't have _id as string here)
      // We can fetch it back to include any DB-generated fields
      const stored = await col.findOne({ _id: r.insertedId });
      return { insertedId, doc: stored || docToInsert, existed: false };
    } catch (err) {
      const isDup = err && (err.code === 11000 || (err.errmsg && err.errmsg.indexOf('E11000') !== -1));
      if (isDup && attempt < maxAttemptsNoEmail) {
        // retry with a fresh ticket_code
        continue;
      }
      // Otherwise propagate
      throw err;
    }
  }

  // Should not reach here; but throw defensively
  throw new Error('Failed to save registration after multiple attempts');
}

module.exports = { saveRegistration, mapFormToDoc, ensureEmailUniqueIndex, ensureTicketCodeUniqueIndex, generateTicketCode };