const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") throw new Error("mongoClient not available");
  const maybe = mongo.getDb();
  return typeof maybe?.then === "function" ? await maybe : maybe;
}

function tryParseJsonSafe(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function looksLikeBase64(s) {
  if (typeof s !== "string") return false;
  const s2 = s.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/=]+$/.test(s2) && (s2.length % 4 === 0);
}

function extractTicketIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["ticket_code","ticketCode","ticket_id","ticketId","ticket","code","c","id","tk","t"];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return null;
}

function extractTicketId(input) {
  if (input == null) return null;
  if (typeof input === "number") return String(input);
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;

    const parsed = tryParseJsonSafe(s);
    if (parsed && typeof parsed === "object") {
      const f = extractTicketIdFromObject(parsed);
      if (f) return f;
    }

    if (looksLikeBase64(s)) {
      try {
        const dec = Buffer.from(s, 'base64').toString('utf8');
        const p2 = tryParseJsonSafe(dec);
        if (p2 && typeof p2 === 'object') {
          const f2 = extractTicketIdFromObject(p2);
          if (f2) return f2;
        }
        const tok = dec.match(/[A-Za-z0-9\-_\.]{3,64}/);
        if (tok) return tok[0];
        const dig = dec.match(/\d{3,12}/);
        if (dig) return dig[0];
      } catch {}
    }

    const token = s.match(/[A-Za-z0-9\-_\.]{3,64}/);
    if (token) return token[0];
    const digits = s.match(/\d{3,12}/);
    if (digits) return digits[0];

    return null;
  }
  if (typeof input === "object") {
    return extractTicketIdFromObject(input);
  }
  return null;
}

const COLLECTIONS = ["visitors","exhibitors","partners","speakers","awardees"];

/**
 * Find ticket by `ticket_code` only
 */
async function findTicket(ticketKey) {
  const db = await getDb();
  const keyStr = String(ticketKey).trim();
  
  for (const collName of COLLECTIONS) {
    const col = db.collection(collName);
    const doc = await col.findOne({ ticket_code: keyStr });
    if (doc) return { doc, collection: collName };
  }
  return null;
}

/* validate route */
router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId ?? req.body.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id" });

    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc, collection } = found;
    const ticket = {
      ticket_code: doc.ticket_code,
      entity_type: collection,
      entity_id: doc._id,
      name: doc.name || doc.full_name || null,
      email: doc.email || doc.e || null,
      company: doc.company || doc.org || null,
      category: doc.category || doc.ticket_category || null,
      raw_row: doc
    };

    res.json({ success: true, ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* scan/print route */
router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId ?? req.body.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id" });

    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc } = found;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=ticket-${ticketKey}.pdf`);

    const pdf = new PDFDocument({ size: [300, 450], margin: 12 });
    pdf.pipe(res);
    pdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    pdf.moveDown(2);
    pdf.fontSize(12).text(`Name: ${doc.name || doc.full_name || ""}`);
    pdf.text(`Email: ${doc.email || ""}`);
    pdf.text(`Company: ${doc.company || doc.org || ""}`);
    pdf.moveDown();
    pdf.fontSize(14).text(`Ticket: ${ticketKey}`, { align: "center" });
    pdf.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
