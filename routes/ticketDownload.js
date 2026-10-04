const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const mongo = require("../utils/mongoClient");

// Safe import for badgeGenerator
let generateBadgePDF;
try {
  const badgeGen = require("../utils/badgeGenerator");
  generateBadgePDF = badgeGen.generateBadgePDF || badgeGen;
  if (typeof generateBadgePDF !== "function") {
    throw new Error("generateBadgePDF is not a function");
  }
} catch (e) {
  console.error("❌ Failed to load badgeGenerator:", e. message);
  generateBadgePDF = null;
}

async function obtainDb() {
  try {
    if (mongo.getDb) return await mongo.getDb();
    return mongo.db;
  } catch (e) {
    console.error("[ticketDownload] DB error:", e.message);
    return null;
  }
}

function resolveRecordId(input) {
  if (!input) return null;

  if (typeof input === "string") {
    const value = input.trim();
    return value || null;
  }

  if (typeof input === "object") {
    const candidate =
      input._id ||
      input.id ||
      input.ticket_code ||
      input.ticketCode ||
      input.data?._id ||
      input.data?.ticket_code ||
      input.data?.ticketCode;

    if (!candidate) return null;
    return String(candidate);
  }

  return String(input);
}

/**
 * ✅ Changed to query params to match frontend/email usage
 * 
 * GET ? entity=visitors&id=xxxxx
 */
router.get("/", async (req, res) => {
  try {
    console.log("[ticketDownload] Request:", req.query);

    const { entity, id } = req.query;
    const bodyId = req.body && typeof req.body === "object" ? req.body.id || req.body._id || req.body.ticket_code || req.body.ticketCode || req.body.record : null;
    const resolvedId = resolveRecordId(id || bodyId || req.body || null);

    // Validate required params
    if (!entity || !resolvedId) {
      console.error("[ticketDownload] Missing params:", { entity, id, bodyId, resolvedId });
      return res.status(400).json({ 
        error: "Missing required parameters",
        required: ["entity", "id"],
        received: { entity:  !!entity, id: !!resolvedId }
      });
    }

    // Normalize entity (accept singular/plural + capitalization)
    const entityKeyRaw = String(entity).trim().toLowerCase();
    const entityKey = entityKeyRaw.endsWith("s")
      ? entityKeyRaw
      : `${entityKeyRaw}s`;

    // Safe collection mapping (plural keys)
    const collectionMap = {
      visitors: "visitors",
      speakers: "speakers",
      exhibitors: "exhibitors",
      partners: "partners",
      awardees: "awardees",
    };

    const allowed = Object.keys(collectionMap);
    if (!allowed.includes(entityKey)) {
      console.error("[ticketDownload] Invalid entity:", entityKeyRaw);
      return res.status(400).json({ 
        error: "Invalid ticket type",
        allowed,
        received: entityKeyRaw
      });
    }

    // Accept either Mongo _id OR ticket_code (6-digit etc.). Prefer _id when valid.
    const idStr = String(resolvedId);
    const isObjectId = ObjectId.isValid(idStr);

    const db = await obtainDb();
    if (!db) {
      console.error("[ticketDownload] Database not available");
      return res.status(500).json({ error: "Database not available" });
    }

    const collectionName = collectionMap[entityKey];
    const collection = db.collection(collectionName);

    console.log("[ticketDownload] Finding document:", { entity: entityKey, id: idStr, collection: collectionName });

    let doc;
    try {
      doc = isObjectId
        ? await collection.findOne({ _id: new ObjectId(idStr) })
        : await collection.findOne({ ticket_code: idStr });
    } catch (dbErr) {
      console.error("[ticketDownload] DB query error:", dbErr.message);
      return res.status(500).json({ error: "Database query failed" });
    }

    if (!doc) {
      console.error("[ticketDownload] Document not found:", { entity, id });
      return res.status(404).json({ 
        error: "Ticket not found",
        entity,
        id
      });
    }

    console.log("[ticketDownload] Document found:", doc.ticket_code || doc._id);

    // Check if badge generator is available
    if (!generateBadgePDF) {
      console.error("[ticketDownload] Badge generator not available");
      return res.status(500).json({ error: "Badge generator not configured" });
    }

    // Generate PDF
    console.log("[ticketDownload] Generating PDF...");
    let pdfBuffer;
    try {
      pdfBuffer = await generateBadgePDF(entityKey, doc);
    } catch (pdfErr) {
      console.error("[ticketDownload] PDF generation error:", pdfErr.stack || pdfErr);
      return res.status(500).json({ 
        error: "Failed to generate badge PDF",
        details: pdfErr.message
      });
    }

    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      console.error("[ticketDownload] Invalid PDF buffer returned");
      return res.status(500).json({ error: "Invalid PDF generated" });
    }

    console.log("[ticketDownload] ✅ PDF generated successfully, size:", pdfBuffer.length);

    const filename = `RailTrans-${entityKey}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);

    res.send(pdfBuffer);
    console.log("[ticketDownload] ✅ PDF sent successfully");
  } catch (err) {
    console.error("[ticketDownload] Unexpected error:", err.stack || err);
    res.status(500).json({ 
      error: "Failed to generate ticket",
      message: err.message
    });
  }
});

/**
 * Also support old URL format for backward compatibility
 * GET /:entity/:id
 */
router.get("/:entity/:id", async (req, res) => {
  console.log("[ticketDownload] Legacy URL format, redirecting to query params");
  const { entity, id } = req. params;
  return res.redirect(`/api/tickets/download?entity=${entity}&id=${id}`);
});

module.exports = router;