const { MongoClient, ServerApiVersion } = require("mongodb");

let _client = null;
let _db = null;

async function connect(uri, dbName) {
  if (_client && _db) return { client: _client, db: _db };

  if (!uri) throw new Error("Mongo URI is required");
  if (!dbName) throw new Error("Mongo DB name is required");

  const client = new MongoClient(uri, {
    serverApi: ServerApiVersion.v1,
    serverSelectionTimeoutMS: 10000,  // try connecting for 10s max
    connectTimeoutMS: 10000,
    retryWrites: true,
    appName: "RailTransExpoApp",
  });

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");
    _client = client;
    _db = client.db(dbName);
    return { client: _client, db: _db };
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    throw err;
  }
}

function getDb() {
  if (!_db) throw new Error("MongoDB not connected. Call connect(uri, dbName) first.");
  return _db;
}

function getCollection(name) {
  return getDb().collection(name);
}

async function close() {
  if (_client) await _client.close();
  _client = null;
  _db = null;
}

module.exports = {
  connect,
  getDb,
  getCollection,
  close,
};
