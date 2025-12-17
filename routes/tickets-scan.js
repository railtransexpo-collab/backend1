/**
 * backend/routes/tickets.js
 *
 * Handles ticket validation and scanning (PDF generation).
 * Looks for ticket_code only at the root level in multiple collections.
 */

const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

/* ---------- DB ---------- */
async function getDb() {
  const db = mongo.getDb();
  return typeof db.then === "function" ? await db : db;
}

/* ---------- Ticket extractor ---------- */
function extractTicketId(raw) {
  if (raw === null || raw === undefined) return null;
  return String(raw).trim();
}

/* ---------- CORE LOOKUP ---------- */
async function findTicket(ticketCode) {
  const db = await getDb();
  const ticketStr = String(ticketCode).trim();
  const ticketNum = Number(ticketCode);

  const collections = ["visitors", "exhibitors", "awardees", "partners", "speakers"];

  for (const coll of collections) {
    const col = db.collection(coll);
    const doc = await col.findOne({
      $or: [
        { ticket_code: ticketStr },
        ...(isNaN(ticketNum) ? [] : [{ ticket_code: ticketNum }])
      ]
    });

    if (doc) {
      return { doc, collection: coll };
    }
  }
  return null;
}

/* ---------- VALIDATE ---------- */
router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  const { ticketId, raw } = req.body || {};
  const incoming = ticketId || raw;
  if (!incoming) return res.status(400).json({ success: false, error: "ticketId or raw payload required" });

  const ticketKey = extractTicketId(incoming);
  if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

  try {
    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc, collection } = found;

    const entityTypeMap = {
      visitors: "visitor",
      exhibitors: "exhibitor",
      awardees: "awardee",
      partners: "partner",
      speakers: "speaker"
    };

    const ticket = {
      ticket_code: doc.ticket_code || ticketKey,
      entity_type: entityTypeMap[collection] || null,
      entity_id: doc._id,
      name: doc.name || null,
      email: doc.email || null,
      company: doc.company || null,
      category: doc.ticket_category || doc.category || null,
      txId: doc.txId || doc.tx_id || null,
      payment_status: doc.payment_status || doc.status || null,
      raw_row: doc
    };

    return res.json({ success: true, ticket });
  } catch (err) {
    console.error("tickets/validate error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- SCAN (PDF) ---------- */
router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const ticketKey = extractTicketId(req.body.ticketId || req.body.raw);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Ticket required" });

    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc, collection } = found;

    const entityTypeMap = {
      visitors: "visitor",
      exhibitors: "exhibitor",
      awardees: "awardee",
      partners: "partner",
      speakers: "speaker"
    };

    const ticket = {
      ticket_code: doc.ticket_code,
      entity_type: entityTypeMap[collection] || null,
      name: doc.name || "",
      email: doc.email || "",
      company: doc.company || "",
      category: doc.ticket_category || doc.category || "GENERAL"
    };

    // ---- PDF generation ----
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=ticket-${ticket.ticket_code}.pdf`);

    const pdf = new PDFDocument({ size: [300, 450], margin: 12 });
    pdf.pipe(res);

    pdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    pdf.moveDown(2);

    pdf.fontSize(12).text(`Name: ${ticket.name}`);
    pdf.text(`Email: ${ticket.email}`);
    pdf.text(`Company: ${ticket.company}`);
    pdf.moveDown();
    pdf.fontSize(14).text(`Ticket: ${ticket.ticket_code}`, { align: "center" });
    pdf.fontSize(12).text(`Category: ${ticket.category}`, { align: "center" });

    pdf.end();
  } catch (err) {
    console.error("tickets/scan error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
