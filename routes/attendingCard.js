"use strict";

const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");

const mongo = require("../utils/mongoClient");
const {
  generateAttendingCardPDF,
} = require("../utils/attendingCardGenerator");

const COLLECTIONS = {
  visitors: "visitors",
  exhibitors: "exhibitors",
  partners: "partners",
  speakers: "speakers",
  awardees: "awardees",
};

async function obtainDb() {
  try {
    if (typeof mongo.getDb === "function") {
      return await mongo.getDb();
    }

    return mongo.db;
  } catch (err) {
    console.error("[attendingCard] DB error:", err.message);
    return null;
  }
}

function normalizeEntity(entity) {
  const value = String(entity || "").trim().toLowerCase();

  if (value.endsWith("s")) {
    return value;
  }

  return `${value}s`;
}

/**
 * GET
 * /api/attending-card/:entity/:id
 *
 * Examples:
 *
 * /api/attending-card/visitors/xxxxxxxx
 * /api/attending-card/exhibitors/xxxxxxxx
 */
router.get("/:entity/:id", async (req, res) => {
  try {
    const { entity, id } = req.params;

    const entityKey = normalizeEntity(entity);

    console.log("[attendingCard] Request:", {
      entity: entityKey,
      id,
    });

    const collectionName = COLLECTIONS[entityKey];

    if (!collectionName) {
      return res.status(400).json({
        success: false,
        error: "Invalid participant type",
        allowed: Object.keys(COLLECTIONS),
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid participant ID",
      });
    }

    const db = await obtainDb();

    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Database not available",
      });
    }

    const collection = db.collection(collectionName);

    const doc = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (!doc) {
      return res.status(404).json({
        success: false,
        error: "Participant not found",
      });
    }

    console.log(
      "[attendingCard] Participant found:",
      doc.ticket_code || doc._id,
    );

    const pdfBuffer = await generateAttendingCardPDF(doc);

    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      throw new Error("Invalid PDF generated");
    }

    const ticketCode = doc.ticket_code || String(doc._id);

    const filename = `RailTrans-Attending-Card-${ticketCode}.pdf`;

    res.setHeader("Content-Type", "application/pdf");

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );

    res.setHeader("Content-Length", pdfBuffer.length);

    return res.send(pdfBuffer);
  } catch (err) {
    console.error(
      "[attendingCard] generation failed:",
      err.stack || err,
    );

    return res.status(500).json({
      success: false,
      error: "Failed to generate attending card",
      details: err.message,
    });
  }
});

module.exports = router;