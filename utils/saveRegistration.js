// utils/registrations.js
// ALL registrations go into ONE collection: registrants

const mongo = require('./mongoClient');
const { safeFieldName } = require('./mongoSchemaSync');

async function obtainDb() {
  if (typeof mongo.getDb === 'function') return mongo.getDb();
  if (mongo.db) return mongo.db;
  throw new Error('mongoClient not available');
}

/**
 * Maps any role-based collection to ONE physical collection
 */
function mapTargetCollection(name = '') {
  const n = name.toLowerCase().trim();
  const singular = n.endsWith('s') ? n.slice(0, -1) : n;

  const roles = new Set([
    'visitor',
    'exhibitor',
    'partner',
    'speaker',
    'awardee',
  ]);

  if (!n || n === 'registrants') {
    return { target: 'registrants', role: 'visitor' };
  }

  if (roles.has(singular)) {
    return { target: 'registrants', role: singular };
  }

  return { target: n, role: null };
}

function generateTicketCode(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return `TICK-${s}`;
}

async function ensureIndexes(db) {
  const col = db.collection('registrants');
  try {
    await col.createIndex(
      { ticket_code: 1 },
      { unique: true, sparse: true, background: true }
    );
    await col.createIndex(
      { email: 1, role: 1 },
      { unique: true, sparse: true, background: true }
    );
  } catch {}
}

/**
 * Save registration (idempotent)
 */
async function saveRegistration(collectionName, form = {}, options = {}) {
  const db = options.db || (await obtainDb());
  await ensureIndexes(db);

  const { target, role } = mapTargetCollection(collectionName);
  const col = db.collection(target);

  const mapped = {};
  for (const [k, v] of Object.entries(form)) {
    const safe = safeFieldName(k);
    if (safe) mapped[safe] = v ?? null;
  }

  const now = new Date();
  mapped.updatedAt = now;
  mapped.createdAt = now;
  mapped.role = role;

  if (mapped.email) {
    mapped.email = String(mapped.email).toLowerCase().trim();
  }

  const filter =
    mapped.email && role
      ? { email: mapped.email, role }
      : null;

  if (filter) {
    for (let i = 0; i < 5; i++) {
      try {
        mapped.ticket_code ||= generateTicketCode();
        const res = await col.findOneAndUpdate(
          filter,
          {
            $setOnInsert: mapped,
            $set: { updatedAt: now },
          },
          { upsert: true, returnDocument: 'after' }
        );
        return { doc: res.value, existed: !!res.value?.createdAt };
      } catch (e) {
        if (e.code !== 11000) throw e;
        mapped.ticket_code = generateTicketCode();
      }
    }
  }

  mapped.ticket_code ||= generateTicketCode();
  const r = await col.insertOne(mapped);
  return { doc: await col.findOne({ _id: r.insertedId }), existed: false };
}

module.exports = {
  saveRegistration,
  mapTargetCollection,
};
