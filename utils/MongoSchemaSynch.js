/**
 * utils/mongoSchemaSync.js
 *
 * Tracks dynamic fields and creates per-collection indexes.
 * Does NOT require registrations to avoid circular dependency.
 */

const mongo = require('./mongoClient');

function safeFieldName(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;
  s = s.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z_]/.test(s)) s = `f_${s}`;
  return s;
}

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

async function ensureTrackingCollection(db) {
  const col = db.collection('dynamic_fields');
  try {
    await col.createIndex({ collectionName: 1, fieldName: 1 }, { unique: true, background: true });
  } catch (e) {}
  return col;
}

function normalizeCollectionNameToPlural(collectionName) {
  if (!collectionName) return null;
  let s = String(collectionName).trim().toLowerCase();
  s = s.replace(/[^a-z0-9_\-]/g, '_').replace(/_+/g, '_');
  if (!s.endsWith('s')) s = `${s}s`;
  return s;
}

async function syncFieldsToCollection(collectionName, fields = []) {
  if (!collectionName) throw new Error('collectionName required');

  const db = await obtainDb();
  const tracker = await ensureTrackingCollection(db);

  const target = normalizeCollectionNameToPlural(collectionName);
  const targetCol = db.collection(target);

  const desired = [];
  for (const f of fields) {
    if (!f?.name) continue;
    const fn = safeFieldName(f.name);
    if (!fn) continue;
    desired.push({
      fieldName: fn,
      origName: String(f.name),
      type: String(f.type || 'text'),
    });
  }

  const trackedRows = await tracker.find({ collectionName: target }).toArray();
  const trackedNames = new Set(trackedRows.map(r => r.fieldName));
  const desiredNames = new Set(desired.map(d => d.fieldName));

  const toAdd = desired.filter(d => !trackedNames.has(d.fieldName));
  const toRemove = trackedRows.filter(t => !desiredNames.has(t.fieldName));

  const added = [];
  const removed = [];
  const errors = [];

  for (const d of toAdd) {
    try {
      await tracker.updateOne(
        { collectionName: target, fieldName: d.fieldName },
        { $set: { collectionName: target, fieldName: d.fieldName, origName: d.origName, fieldType: d.type, createdAt: new Date() } },
        { upsert: true }
      );
      const idx = {}; idx[d.fieldName] = 1;
      await targetCol.createIndex(idx, { name: `dyn_${d.fieldName}_idx`, sparse: true, background: true });
      added.push(d.fieldName);
    } catch (e) {
      errors.push({ add: d.fieldName, error: e && e.message ? e.message : String(e) });
    }
  }

  for (const t of toRemove) {
    try {
      const idxName = `dyn_${t.fieldName}_idx`;
      const indexes = await targetCol.indexes();
      if (indexes.find(i => i.name === idxName)) {
        await targetCol.dropIndex(idxName);
      }
      await tracker.deleteOne({ _id: t._id });
      removed.push(t.fieldName);
    } catch (e) {
      errors.push({ remove: t.fieldName, error: e && e.message ? e.message : String(e) });
    }
  }

  return { added, removed, errors };
}

module.exports = {
  syncFieldsToCollection,
  safeFieldName,
  normalizeCollectionNameToPlural
};