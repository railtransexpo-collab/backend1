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

  const collections = ["visitors", "exhibitors"];

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
router.post("/validate", express.json(), async (req, res) => {
  try {
    const ticketKey = extractTicketId(req.body.ticketId || req.body.raw);
    if (!ticketKey) {
      return res.status(400).json({ success: false, error: "Ticket required" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc, collection } = found;

    return res.json({
      success: true,
      ticket: {
        ticket_code: doc.ticket_code,
        entity_type: collection.slice(0, -1),
        entity_id: doc._id,
        name: doc.name || null,
        email: doc.email || null,
        company: doc.company || null,
        category: doc.ticket_category || doc.category || null,
        payment_status: doc.status || null,
        raw_row: doc
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- SCAN (PDF) ---------- */
router.post("/scan", express.json(), async (req, res) => {
  try {
    const ticketKey = extractTicketId(req.body.ticketId || req.body.raw);
    if (!ticketKey) {
      return res.status(400).json({ success: false, error: "Ticket required" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc } = found;

    // ---- simple badge PDF ----
    res.setHeader("Content-Type", "application/pdf");
    const pdf = new PDFDocument({ size: [300, 450], margin: 10 });
    pdf.pipe(res);

    pdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    pdf.moveDown(2);
    pdf.fontSize(12).text(`Name: ${doc.name || ""}`);
    pdf.text(`Email: ${doc.email || ""}`);
    pdf.text(`Company: ${doc.company || ""}`);
    pdf.moveDown();
    pdf.fontSize(14).text(`Ticket: ${doc.ticket_code}`, { align: "center" });

    pdf.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
