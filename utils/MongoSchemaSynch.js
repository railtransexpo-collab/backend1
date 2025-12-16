// utils/mongoSchemaSync.js
// Sync admin-managed fields into MongoDB environment.
// - Tracks dynamic fields in "dynamic_fields" collection.
// - Creates sparse indexes on target collections for newly-added fields (helps queries/filters).
// - Drops those indexes when an admin removes fields from config.
//
// Note: This does NOT enforce schema (Mongo is schemaless). It only tracks and indexes fields
// created via admin UI so they can be cleaned up later.

const mongo = require('./mongoClient'); // must expose getDb()

function safeFieldName(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;
  // normalize: lower-case, replace spaces and hyphens with underscore, remove invalid chars
  s = s.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z_]/.test(s)) s = `f_${s}`;
  return s;
}

async function obtainDb() {
  if (!mongo) throw new Error('mongoClient not available');
  if (typeof mongo.getDb === 'function') return await mongo.getDb();
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient has no getDb/db');
}

async function ensureTrackingCollection(db) {
  const col = db.collection('dynamic_fields');
  // create index for quick lookups
  try {
    await col.createIndex({ collectionName: 1, fieldName: 1 }, { unique: true, background: true });
  } catch (e) {
    // ignore
  }
  return col;
}

/**
 * Ensure a unique sparse index on 'ticket_code' for the given collection.
 * - sparse:true so legacy docs without ticket_code won't block index creation.
 * - background:true so index build doesn't block primary.
 *
 * db: MongoDB Db instance (optional) - if omitted we'll obtain a db from mongo client.
 */
async function ensureTicketCodeUniqueIndex(dbOrName, maybeCollectionName) {
  let db = null;
  let collectionName = null;

  if (typeof dbOrName === 'string' && maybeCollectionName === undefined) {
    // called as ensureTicketCodeUniqueIndex(collectionName)
    collectionName = dbOrName;
    db = await obtainDb();
  } else if (dbOrName && typeof dbOrName.collection === 'function' && typeof maybeCollectionName === 'string') {
    db = dbOrName;
    collectionName = maybeCollectionName;
  } else if (dbOrName && typeof dbOrName === 'object' && maybeCollectionName) {
    // fallback: treat first param as db
    db = dbOrName;
    collectionName = String(maybeCollectionName);
  } else {
    // try to obtain db and collection param from maybeCollectionName
    db = await obtainDb();
    collectionName = maybeCollectionName || dbOrName;
  }

  if (!db) return;
  if (!collectionName) return;

  try {
    const col = db.collection(collectionName);
    await col.createIndex(
      { ticket_code: 1 },
      { unique: true, sparse: true, name: 'unique_ticket_code', background: true }
    );
  } catch (err) {
    // best-effort: log but don't throw
    console.warn(`[mongoSchemaSync] ensureTicketCodeUniqueIndex failed for ${collectionName}:`, err && (err.message || err));
  }
}

/**
 * syncFieldsToCollection(collectionName, fields)
 * - collectionName: the target data collection (e.g. "visitors")
 * - fields: array of admin field objects, expecting at least .name and optional .type
 *
 * Returns { added: [fieldName], removed: [fieldName], tracked: [..] }
 */
async function syncFieldsToCollection(collectionName, fields = []) {
  if (!collectionName) throw new Error('collectionName required');

  const db = await obtainDb();
  const tracker = await ensureTrackingCollection(db);

  const { target } = mapTargetCollection(collectionName);
  const targetCol = db.collection(target);

  const desired = [];
  for (const f of fields || []) {
    if (!f || !f.name) continue;
    const fn = safeFieldName(f.name);
    if (!fn) continue;
    desired.push({
      fieldName: fn,
      origName: String(f.name),
      type: String(f.type || 'text'),
    });
  }

  // load tracked fields for this collection
  const trackedRows = await tracker.find({ collectionName: target }).toArray();
  const tracked = trackedRows.map(r => ({ fieldName: r.fieldName, origName: r.origName, _id: r._id }));

  const trackedNames = new Set(tracked.map(t => t.fieldName));
  const desiredNames = new Set(desired.map(d => d.fieldName));

  const toAdd = desired.filter(d => !trackedNames.has(d.fieldName));
  const toRemove = tracked.filter(t => !desiredNames.has(t.fieldName));

  const added = [];
  const removed = [];
  const errors = [];

  // Add: insert tracking doc and create sparse index on collection
  for (const d of toAdd) {
    try {
      await tracker.updateOne(
        { collectionName, fieldName: d.fieldName },
        { $set: { collectionName, fieldName: d.fieldName, origName: d.origName, fieldType: d.type, createdAt: new Date() } },
        { upsert: true }
      );
      // create sparse index so queries can use it; named with prefix to identify
      const idxName = `dyn_${d.fieldName}_idx`;
      try {
        const idxSpec = {};
        idxSpec[d.fieldName] = 1;
        await targetCol.createIndex(idxSpec, { name: idxName, sparse: true, background: true });
      } catch (ie) {
        // ignore index errors but record
        errors.push({ action: 'createIndex', field: d.fieldName, error: String(ie && ie.message ? ie.message : ie) });
      }
      added.push(d.fieldName);
    } catch (e) {
      errors.push({ action: 'trackAdd', field: d.fieldName, error: String(e && e.message ? e.message : e) });
    }
  }

  // Remove: drop index (if created) and remove tracker doc
  for (const t of toRemove) {
    try {
      const idxName = `dyn_${t.fieldName}_idx`;
      try {
        // drop index if exists
        const existingIndexes = await targetCol.indexes();
        const found = existingIndexes.find(ix => ix.name === idxName);
        if (found) {
          await targetCol.dropIndex(idxName);
        }
      } catch (ie) {
        // ignore
      }
      await tracker.deleteOne({ _id: t._id });
      removed.push(t.fieldName);
    } catch (e) {
      errors.push({ action: 'remove', field: t.fieldName, error: String(e && e.message ? e.message : e) });
    }
  }

  return { added, removed, errors };
}

module.exports = { syncFieldsToCollection, safeFieldName, ensureTicketCodeUniqueIndex };