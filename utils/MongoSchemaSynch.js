// utils/mongoSchemaSync.js
// Sync admin-managed dynamic fields
// ALWAYS targets unified `registrants` collection

const mongo = require('./mongoClient');
const { mapTargetCollection } = require('./registrations');

function safeFieldName(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;
  s = s.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z_]/.test(s)) s = `f_${s}`;
  return s;
}

async function obtainDb() {
  if (typeof mongo.getDb === 'function') return mongo.getDb();
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient not available');
}

async function ensureTrackingCollection(db) {
  const col = db.collection('dynamic_fields');
  await col.createIndex(
    { collectionName: 1, fieldName: 1 },
    { unique: true, background: true }
  ).catch(() => {});
  return col;
}

/**
 * Sync dynamic fields to unified collection
 */
async function syncFieldsToCollection(collectionName, fields = []) {
  const db = await obtainDb();
  const tracker = await ensureTrackingCollection(db);

  // 🔑 ALWAYS normalize to registrants
  const { target } = mapTargetCollection(collectionName);
  const targetCol = db.collection(target); // registrants ONLY

  const desired = [];
  for (const f of fields) {
    if (!f?.name) continue;
    const fn = safeFieldName(f.name);
    if (!fn) continue;
    desired.push({
      fieldName: fn,
      origName: f.name,
      type: f.type || 'text',
    });
  }

  // 🔑 TRACK BY TARGET, NOT ROLE
  const tracked = await tracker.find({ collectionName: target }).toArray();
  const trackedNames = new Set(tracked.map(t => t.fieldName));
  const desiredNames = new Set(desired.map(d => d.fieldName));

  const toAdd = desired.filter(d => !trackedNames.has(d.fieldName));
  const toRemove = tracked.filter(t => !desiredNames.has(t.fieldName));

  const added = [];
  const removed = [];

  // ➕ Add new fields
  for (const d of toAdd) {
    await tracker.updateOne(
      { collectionName: target, fieldName: d.fieldName },
      {
        $set: {
          collectionName: target,
          fieldName: d.fieldName,
          origName: d.origName,
          fieldType: d.type,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    const idx = {};
    idx[d.fieldName] = 1;

    await targetCol.createIndex(idx, {
      name: `dyn_${d.fieldName}_idx`,
      sparse: true,
      background: true,
    }).catch(() => {});

    added.push(d.fieldName);
  }

  // ➖ Remove deleted fields
  for (const t of toRemove) {
    const idxName = `dyn_${t.fieldName}_idx`;
    const indexes = await targetCol.indexes();
    if (indexes.find(i => i.name === idxName)) {
      await targetCol.dropIndex(idxName);
    }
    await tracker.deleteOne({ _id: t._id });
    removed.push(t.fieldName);
  }

  return { added, removed };
}

module.exports = {
  syncFieldsToCollection,
  safeFieldName,
};
