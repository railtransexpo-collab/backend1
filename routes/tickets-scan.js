/**
 * backend/routes/tickets.js
 *
 * FINAL FIXED VERSION
 * - Reliable ticket scan across ALL role collections
 * - Works with numeric ticket_code like "433702"
 * - Uses indexed exact match first
 * - Simple, fast, production-safe
 */

const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

// optional QR
let QRCode = null;
try { QRCode = require("qrcode"); } catch (e) {}

// optional badge generator
let generateVisitorBadgePDF = null;
try {
  generateVisitorBadgePDF =
    require("../utils/pdfGenerator").generateVisitorBadgePDF;
} catch (e) {}

/* ---------- MongoDB helper ---------- */
async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") {
    throw new Error("mongoClient not available");
  }
  const maybe = mongo.getDb();
  if (maybe && typeof maybe.then === "function") return await maybe;
  return maybe;
}

/* ---------- Helpers ---------- */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTicketId(raw) {
  if (raw === null || raw === undefined) return null;

  // If scanner sends JSON
  if (typeof raw === "object") {
    if (raw.ticket_code) return String(raw.ticket_code).trim();
    if (raw.ticketCode) return String(raw.ticketCode).trim();
  }

  const s = String(raw).trim();
  if (!s) return null;

  // numeric or alphanumeric ticket
  if (/^[A-Za-z0-9\-_.]{3,64}$/.test(s)) return s;

  // fallback: extract digits
  const digits = s.match(/\d{4,12}/);
  if (digits) return digits[0];

  return null;
}

/* ---------- CORE LOOKUP (FIXED) ---------- */
async function findTicketInCollection(collectionName, ticketKey) {
  const db = await getDb();
  const col = db.collection(collectionName);

  const keyStr = String(ticketKey).trim();
  const keyNum = Number(ticketKey);

  const orQuery = [
    { ticket_code: keyStr }
  ];

  if (!isNaN(keyNum)) {
    orQuery.push({ ticket_code: keyNum });
  }

  // 🔑 THIS MATCHES BOTH STRING + NUMBER
  const row = await col.findOne({ $or: orQuery });
  return row || null;
}


/* ---------- Collections to search ---------- */
const COLLECTIONS = [
  "visitors",
  "speakers",
  "partners",
  "exhibitors",
  "awardees"
];

/* ---------- /validate ---------- */
router.post("/validate", express.json(), async (req, res) => {
  const { ticketId, raw } = req.body || {};
  const incoming = ticketId || raw;

  if (!incoming) {
    return res.status(400).json({
      success: false,
      error: "ticketId or raw payload required"
    });
  }

  const ticketKey = extractTicketId(incoming);
  if (!ticketKey) {
    return res.status(400).json({
      success: false,
      error: "Invalid ticket code"
    });
  }

  try {
    let found = null;
    let entityType = null;

    for (const coll of COLLECTIONS) {
      const row = await findTicketInCollection(coll, ticketKey);
      if (row) {
        found = row;
        entityType = coll.slice(0, -1);
        break;
      }
    }

    if (!found) {
      return res.status(404).json({
        success: false,
        error: "Ticket not found"
      });
    }

    return res.json({
      success: true,
      ticket: {
        ticket_code: found.ticket_code,
        entity_type: entityType,
        entity_id: found._id,
        name: found.name || null,
        email: found.email || null,
        company: found.company || null,
        category: found.ticket_category || null,
        payment_status: found.status || null,
        raw_row: found
      }
    });
  } catch (err) {
    console.error("tickets/validate error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});

/* ---------- /scan ---------- */
router.post("/scan", express.json(), async (req, res) => {
  const { ticketId, raw } = req.body || {};
  const incoming = ticketId || raw;

  if (!incoming) {
    return res.status(400).json({
      success: false,
      error: "ticketId or raw payload required"
    });
  }

  const ticketKey = extractTicketId(incoming);
  if (!ticketKey) {
    return res.status(400).json({
      success: false,
      error: "Invalid ticket code"
    });
  }

  try {
    let found = null;
    let entityType = null;

    for (const coll of COLLECTIONS) {
      const row = await findTicketInCollection(coll, ticketKey);
      if (row) {
        found = row;
        entityType = coll.slice(0, -1);
        console.log(`[tickets.scan] ${coll} matched ticket=${ticketKey}`);
        break;
      }
    }

    if (!found) {
      return res.status(404).json({
        success: false,
        error: "Ticket not found"
      });
    }

    return await respondWithPdf({
      ticket_code: found.ticket_code,
      entity_type: entityType,
      entity_id: found._id,
      name: found.name || "",
      email: found.email || "",
      company: found.company || "",
      category: found.ticket_category || "",
      payment_status: found.status || "",
      raw_row: found
    }, res);

  } catch (err) {
    console.error("tickets/scan error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});

/* ---------- PDF ---------- */
async function respondWithPdf(ticket, res) {
  const category = (ticket.category || "").toLowerCase();
  const isFree = category.includes("free");

  if (!isFree && ticket.payment_status !== "paid") {
    return res.status(402).json({
      success: false,
      error: "Ticket not paid"
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=ticket-${ticket.ticket_code}.pdf`
  );

  const doc = new PDFDocument({ size: [300, 450], margin: 12 });
  doc.pipe(res);

  doc.fontSize(16).text(process.env.EVENT_NAME || "Event", { align: "center" });
  doc.moveDown(1);
  doc.fontSize(14).text(ticket.name || "", { align: "center" });
  doc.moveDown(1);

  if (QRCode) {
    const qr = await QRCode.toDataURL(ticket.ticket_code);
    const buf = Buffer.from(qr.split(",")[1], "base64");
    doc.image(buf, (doc.page.width - 120) / 2, doc.y, { width: 120 });
  }

  doc.moveDown(2);
  doc.fontSize(10).text(`Ticket: ${ticket.ticket_code}`, { align: "center" });
  doc.end();
}

module.exports = router;
