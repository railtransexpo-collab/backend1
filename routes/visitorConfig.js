const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient");

/**
 * Helper: obtain a connected MongoDB Db instance.
 * Accepts both sync (mongo.db) and async (mongo.getDb()) client shapes.
 */
async function obtainDb() {
  if (!mongo) return null;

  if (typeof mongo.getDb === "function") {
    try {
      return mongo.getDb(); // sync, may throw
    } catch (e) {
      console.warn("[visitor-config] mongo.getDb failed:", e.message);
      return null;
    }
  }

  if (mongo.db) return mongo.db;
  return null;
}

/**
 * Canonicalize admin config payload into a stable shape used by UI and storage.
 */
function canonicalizeConfig(cfg = {}) {
  const config = { ...(typeof cfg === "object" && cfg !== null ? cfg : {}) };

  config.fields = Array.isArray(config.fields)
    ? config.fields
        .map((f) => {
          const ff = typeof f === "object" && f !== null ? { ...f } : {};
          ff.name = String(ff.name || "").trim();
          ff.label = String(ff.label || ff.name || "").trim();
          ff.type = String(ff.type || "text").trim();
          ff.options = Array.isArray(ff.options)
            ? ff.options.map((o) =>
                o === null || o === undefined ? "" : String(o)
              )
            : [];
          ff.visible = typeof ff.visible === "boolean" ? ff.visible : true;
          ff.required = !!ff.required;
          return ff;
        })
        .filter((f) => f && f.name) // only keep fields that have a name
    : [];

  // images: accept a single url or an array
  if (Array.isArray(config.images)) {
    config.images = config.images.map((i) =>
      i === null || i === undefined ? "" : String(i)
    );
  } else if (config.images) {
    config.images = [String(config.images)];
  } else {
    config.images = [];
  }

  config.eventDetails =
    typeof config.eventDetails === "object" && config.eventDetails !== null
      ? config.eventDetails
      : {};

  // backgroundMedia handling: prefer standardized object { type, url }
  if (
    config.backgroundMedia &&
    typeof config.backgroundMedia === "object" &&
    config.backgroundMedia.url
  ) {
    config.backgroundMedia = {
      type: config.backgroundMedia.type || "image",
      url: String(config.backgroundMedia.url),
    };
  } else if (config.backgroundVideo && config.backgroundVideo) {
    config.backgroundMedia = {
      type: "video",
      url: String(config.backgroundVideo),
    };
  } else if (config.backgroundImage && config.backgroundImage) {
    config.backgroundMedia = {
      type: "image",
      url: String(config.backgroundImage),
    };
  } else {
    config.backgroundMedia = { type: "image", url: "" };
  }

  config.termsUrl = config.termsUrl || config.terms || config.terms_url || "";
  config.termsLabel =
    config.termsLabel || config.terms_label || "Terms & Conditions";
  config.termsRequired = !!config.termsRequired;

  config.backgroundColor =
    config.backgroundColor || config.background_color || "#ffffff";
  config.badgeTemplateUrl =
    config.badgeTemplateUrl || config.badge_template_url || "";

  return config;
}

/**
 * GET /api/visitor-config
 * Returns canonicalized visitor registration page config from Mongo.
 */
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    const configs = db.collection("registration_configs");
    const doc = await configs.findOne({ page: "visitor" });
    if (!doc || !doc.config) {
      return res.json({ fields: [], images: [] });
    }
    const canonical = canonicalizeConfig(doc.config || {});
    return res.json(canonical);
  } catch (err) {
    console.error(
      "[visitor-config-mongo] GET error",
      err && (err.stack || err)
    );
    return res.status(500).json({ fields: [], images: [] });
  }
});

/**
 * POST /api/visitor-config/config
 * Upsert canonicalized config into registration_configs collection.
 * Uses express.json() to ensure body is parsed.
 */
router.post("/config", express.json(), async (req, res) => {
  try {
    const incoming = req.body || {};
    const canonical = canonicalizeConfig(incoming);
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "database not available",
      });
    }
    const configs = db.collection("registration_configs");
    const now = new Date();
    await configs.updateOne(
      { page: "visitor" },
      {
        $set: { config: canonical, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // NOTE: If you want to automatically add/remove fields from registrants collection
    // (e.g. create indexes or remove stored keys), do it here by calling your sync helper.

    return res.json({ success: true, config: canonical });
  } catch (err) {
    console.error(
      "[visitor-config-mongo] POST error",
      err && (err.stack || err)
    );
    return res
      .status(500)
      .json({ success: false, error: "Database update failed" });
  }
});

module.exports = router;
