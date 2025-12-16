// backend/routes/tickets.js
const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient"); // must expose getDb()

// optional server-side QR generator
let QRCode = null;
try { QRCode = require("qrcode"); } catch (e) { QRCode = null; }

// optional existing badge generator
let generateVisitorBadgePDF = null;
try { generateVisitorBadgePDF = require("../utils/pdfGenerator").generateVisitorBadgePDF; } catch (e) { generateVisitorBadgePDF = null; }

/* ---------- MongoDB helper ---------- */
async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") throw new Error("mongoClient not available");
  return await mongo.getDb();
}

/* ---------- Ticket ID extraction ---------- */
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
  const prefer = ["ticket_code","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid","code","c","id","tk","t"];
  for (const k of prefer) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && String(obj[k]).trim() !== "") {
      return String(obj[k]).trim();
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const found = extractTicketIdFromObject(v);
      if (found) return found;
    }
    if (Array.isArray(obj[k])) {
      for (const item of obj[k]) {
        if (item && typeof item === "object") {
          const found = extractTicketIdFromObject(item);
          if (found) return found;
        }
      }
    }
  }
  return null;
}
function extractTicketId(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^[A-Za-z0-9\-_\.]{3,64}$/.test(s)) return s;
  let obj = tryParseJsonSafe(s);
  if (obj) {
    const id = extractTicketIdFromObject(obj);
    if (id) return id;
  }
  if (looksLikeBase64(s)) {
    try {
      const decoded = Buffer.from(s, "base64").toString("utf8");
      obj = tryParseJsonSafe(decoded);
      if (obj) {
        const id = extractTicketIdFromObject(obj);
        if (id) return id;
      }
    } catch (e) {}
  }
  const jsonMatch = s.match(/\{.*\}/s);
  if (jsonMatch) {
    obj = tryParseJsonSafe(jsonMatch[0]);
    if (obj) {
      const id = extractTicketIdFromObject(obj);
      if (id) return id;
    }
  }
  const digits = s.match(/\d{4,12}/);
  if (digits) return digits[0];
  return null;
}

/* ---------- Mongo lookup helper ---------- */
async function findTicketInCollection(collectionName, ticketKey) {
  const db = await getDb();
  const col = db.collection(collectionName);
  const row = await col.findOne({ ticket_code: ticketKey });
  return row || null;
}

/* ---------- /validate route ---------- */
router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  const { ticketId, raw } = req.body || {};
  const incoming = ticketId || raw;
  if (!incoming) return res.status(400).json({ success: false, error: "ticketId or raw payload required" });

  const ticketKey = extractTicketId(incoming);
  if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

  try {
    const collections = ["tickets", "speakers", "visitors", "partners"];
    let found = null;
    let entityType = null;

    for (const coll of collections) {
      const row = await findTicketInCollection(coll, ticketKey);
      if (row) {
        found = row;
        entityType = coll === "tickets" ? null : coll.slice(0, -1);
        break;
      }
    }

    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const ticket = {
      ticket_code: found.ticket_code || ticketKey,
      entity_type: entityType,
      entity_id: found._id,
      name: found.name || found.full_name || found.n || null,
      email: found.email || found.e || null,
      company: found.company || found.org || found.organization || null,
      category: found.category || found.ticket_category || null,
      txId: found.txId || found.tx_id || null,
      payment_status: found.payment_status || found.status || null,
      raw_row: found
    };

    return res.json({ success: true, ticket });
  } catch (err) {
    console.error("tickets/validate error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- /scan route ---------- */
router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  const { ticketId, raw } = req.body || {};
  const incoming = ticketId || raw;
  if (!incoming) return res.status(400).json({ success: false, error: "ticketId or raw payload required" });

  const ticketKey = extractTicketId(incoming);
  if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

  try {
    const collections = ["tickets", "speakers", "visitors", "partners"];
    let found = null;
    let entityType = null;

    for (const coll of collections) {
      const row = await findTicketInCollection(coll, ticketKey);
      if (row) {
        found = row;
        entityType = coll === "tickets" ? null : coll.slice(0, -1);
        console.log(`[tickets.scan] matched ${coll} row id=${row._id} ticket=${ticketKey}`);
        break;
      }
    }

    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const ticket = {
      ticket_code: found.ticket_code || ticketKey,
      entity_type: entityType,
      entity_id: found._id,
      name: found.name || found.full_name || found.n || null,
      email: found.email || found.e || null,
      company: found.company || found.org || found.organization || null,
      category: found.category || found.ticket_category || null,
      txId: found.txId || found.tx_id || null,
      payment_status: found.payment_status || found.status || null,
      raw_row: found
    };

    return await respondWithPdf(ticket, res);
  } catch (err) {
    console.error("tickets/scan error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- PDF responder ---------- */
async function respondWithPdf(ticket, res) {
  const paidStatuses = ["paid", "captured", "success", "completed"];
  const category = (ticket.category || "").toString().toLowerCase();
  const isFree = /free|general|0/.test(category);
  const pstatus = (ticket.payment_status || "").toString().toLowerCase();
  if (!isFree && pstatus && !paidStatuses.includes(pstatus)) {
    return res.status(402).json({ success: false, error: "Ticket not paid" });
  }

  // Generate PDF using existing utility if available
  if (generateVisitorBadgePDF) {
    try {
      const pdfResult = await generateVisitorBadgePDF(ticket, process.env.BADGE_TEMPLATE_URL || "", {
        includeQRCode: true,
        qrPayload: { ticket_code: ticket.ticket_code },
        event: {
          name: process.env.EVENT_NAME || "RailTrans Expo",
          date: process.env.EVENT_DATE || "",
          venue: process.env.EVENT_VENUE || ""
        },
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=ticket-${ticket.ticket_code}.pdf`);
      if (pdfResult && typeof pdfResult.pipe === "function") { pdfResult.pipe(res); return; }
      if (Buffer.isBuffer(pdfResult)) { res.end(pdfResult); return; }
      if (typeof pdfResult === "string" && pdfResult.startsWith("data:application/pdf;base64,")) {
        const b64 = pdfResult.split(",")[1];
        res.end(Buffer.from(b64, "base64"));
        return;
      }
      return res.status(500).json({ success: false, error: "PDF generator returned unsupported result" });
    } catch (e) {
      console.warn("generateVisitorBadgePDF failed, falling back to pdfkit:", e && (e.message || e));
    }
  }

  // pdfkit fallback
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=ticket-${ticket.ticket_code}.pdf`);
  const doc = new PDFDocument({ size: [300, 450], margin: 12 });
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#ffffff");
  doc.fontSize(12).fillColor("#196e87").font("Helvetica-Bold").text(process.env.EVENT_NAME || "RailTrans Expo", { align: "center" });
  doc.moveDown(2);
  doc.fontSize(18).fillColor("#000000").font("Helvetica-Bold").text(ticket.name || ticket.company || "", { align: "center" });
  if (ticket.company) { doc.moveDown(0.5); doc.fontSize(11).fillColor("#555").text(ticket.company, { align: "center" }); }
  if (QRCode) {
    try {
      const qrDataUrl = await QRCode.toDataURL(ticket.ticket_code, { margin: 1, width: 140 });
      const base64 = qrDataUrl.split(",")[1];
      const qrBuf = Buffer.from(base64, "base64");
      const qrW = 120;
      doc.image(qrBuf, (doc.page.width - qrW) / 2, doc.y + 8, { width: qrW, height: qrW });
    } catch (e) {}
  } else {
    const boxSize = 120;
    doc.rect((doc.page.width - boxSize) / 2, doc.y + 8, boxSize, boxSize).stroke("#ccc");
  }
  const barHeight = 48;
  const barY = doc.page.height - barHeight - 12;
  doc.rect(0, barY, doc.page.width, barHeight).fill("#e54b4b");
  doc.fillColor("#fff").fontSize(12).text(((ticket.category || "DELEGATE") + "").toUpperCase(), 0, barY + 14, { align: "center" });
  doc.fontSize(8).fillColor("#fff").text(`Ticket: ${ticket.ticket_code}`, 8, barY + barHeight - 14);
  doc.end();
}

module.exports = router;
