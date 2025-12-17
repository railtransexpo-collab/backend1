/**
 * backend/routes/tickets.js
 *
 * Fixed ticket scan to match your current storage (role-specific collections only).
 * - Searches only: visitors, exhibitors, partners, speakers, awardees (no 'registrants' legacy search).
 * - Fast indexed lookups first (exact + case-insensitive).
 * - Candidate-field queries (ticketCode, ticket_id, code, id, etc).
 * - Controlled JS scan fallback that inspects nested objects, arrays, stringified JSON and base64 JSON.
 * - Configurable scan limit via TICKET_SCAN_SCAN_LIMIT (default 1000).
 * - Enable verbose debug: DEBUG_TICKETS=true
 */

const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

let QRCode = null;
try { QRCode = require("qrcode"); } catch (e) { QRCode = null; }

let generateVisitorBadgePDF = null;
try { generateVisitorBadgePDF = require("../utils/pdfGenerator").generateVisitorBadgePDF; } catch (e) { generateVisitorBadgePDF = null; }

/* ---------- DB helper ---------- */
async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") throw new Error("mongoClient.getDb() not available");
  const maybe = mongo.getDb();
  return (maybe && typeof maybe.then === "function") ? await maybe : maybe;
}

/* ---------- ticket extraction helpers ---------- */
function tryParseJsonSafe(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function looksLikeBase64(s) {
  if (typeof s !== "string") return false;
  const s2 = s.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/=]+$/.test(s2) && (s2.length % 4 === 0);
}
function isTicketCandidateValue(val) {
  if (val === undefined || val === null) return false;
  const s = (typeof val === 'string') ? val.trim() : String(val);
  if (!s) return false;
  if (/^TICK-[A-Z0-9]{3,64}$/i.test(s)) return true;             // explicit TICK-... format
  if (/^[A-Za-z0-9\-_\.]{3,64}$/.test(s)) return true;          // token-like
  if (/^\d{4,12}$/.test(s)) return true;                        // numeric fallback
  return false;
}

/* Recursively (stack-based) search an object/array/string for a ticket-like value.
   Returns first matching primitive string found, or null. Prefers well-known field names first.
*/
function extractTicketIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const prefer = [
    "ticket_code","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid",
    "code","c","id","tk","t"
  ];
  // Prefer explicit keys
  for (const k of prefer) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (isTicketCandidateValue(v)) return String(v).trim();
    }
    const snake = k.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(obj, snake)) {
      const v = obj[snake];
      if (isTicketCandidateValue(v)) return String(v).trim();
    }
  }

  // Generic stack traversal
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      if (isTicketCandidateValue(node)) return String(node).trim();
      if (typeof node === 'string') {
        const parsed = tryParseJsonSafe(node);
        if (parsed && typeof parsed === 'object') stack.push(parsed);
        else if (looksLikeBase64(node)) {
          try {
            const dec = Buffer.from(node, 'base64').toString('utf8');
            const p2 = tryParseJsonSafe(dec);
            if (p2 && typeof p2 === 'object') stack.push(p2);
            else if (isTicketCandidateValue(dec)) return String(dec).trim();
          } catch (e) {}
        }
      }
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) stack.push(node[i]);
      continue;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v === null || v === undefined) continue;
        stack.push(v);
      }
    }
  }
  return null;
}

function extractTicketId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') {
    return extractTicketIdFromObject(raw);
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (isTicketCandidateValue(s)) return s;
  const parsed = tryParseJsonSafe(s);
  if (parsed && typeof parsed === 'object') {
    const f = extractTicketIdFromObject(parsed);
    if (f) return f;
  }
  if (looksLikeBase64(s)) {
    try {
      const dec = Buffer.from(s, 'base64').toString('utf8');
      if (isTicketCandidateValue(dec)) return dec;
      const p2 = tryParseJsonSafe(dec);
      if (p2 && typeof p2 === 'object') {
        const f2 = extractTicketIdFromObject(p2);
        if (f2) return f2;
      }
    } catch (e) {}
  }
  const jsonMatch = s.match(/\{.*\}/s);
  if (jsonMatch) {
    const p = tryParseJsonSafe(jsonMatch[0]);
    if (p && typeof p === 'object') {
      const f3 = extractTicketIdFromObject(p);
      if (f3) return f3;
    }
  }
  const digits = s.match(/\d{4,12}/);
  if (digits) return digits[0];
  return null;
}

/* ---------- lookup utilities ---------- */
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function toSnakeCase(name = "") { return name.replace(/([A-Z])/g, "_$1").replace(/[\- ]+/g, "_").toLowerCase().replace(/^_+/, ""); }
function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }

const CANDIDATE_FIELDS = ["ticket_code","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid","code","c","id","tk","t"];

/* ---------- core: findTicket ----------
   Searches ONLY the role-specific collections (no 'registrants').
*/
async function findTicket(ticketKey) {
  const db = await getDb();
  const key = String(ticketKey).trim();
  const SCAN_LIMIT = Number(process.env.TICKET_SCAN_SCAN_LIMIT || 1000);
  const collections = ["visitors", "exhibitors", "partners", "speakers", "awardees"]; // role collections only

  const fieldVariants = unique(CANDIDATE_FIELDS.flatMap(f => [f, toSnakeCase(f), f.toLowerCase()]));

  for (const collName of collections) {
    const col = db.collection(collName);

    // 1) exact match on ticket_code
    try {
      const exact = await col.findOne({ ticket_code: key });
      if (exact) {
        if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] exact match in ${collName}`);
        return { doc: exact, collection: collName };
      }
    } catch (e) {
      if (process.env.DEBUG_TICKETS === "true") console.warn("[tickets] exact check error", e);
    }

    // 2) case-insensitive anchored regex on ticket_code
    try {
      const rx = new RegExp(`^${escapeRegex(key)}$`, "i");
      const ci = await col.findOne({ ticket_code: { $regex: rx } });
      if (ci) {
        if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] ci match in ${collName}`);
        return { doc: ci, collection: collName };
      }
    } catch (e) {}

    // 3) candidate fields exact + anchored regex
    try {
      const or = [];
      for (const f of fieldVariants) {
        const e = {}; e[f] = key; or.push(e);
        const r = {}; r[f] = { $regex: new RegExp(`^${escapeRegex(key)}$`, "i") }; or.push(r);
      }
      if (or.length) {
        const row = await col.findOne({ $or: or });
        if (row) {
          if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] candidate-field match in ${collName}`);
          return { doc: row, collection: collName };
        }
      }
    } catch (e) {
      if (process.env.DEBUG_TICKETS === "true") console.warn("[tickets] candidate-fields query error", e);
    }

    // 4) controlled JS scan fallback (inspects nested values and _rawForm)
    try {
      const existsClauses = fieldVariants.map(f => ({ [f]: { $exists: true } }));
      existsClauses.push({ _rawForm: { $exists: true } });
      const query = { $or: existsClauses };
      if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] scanning up to ${SCAN_LIMIT} docs in ${collName}`);
      const cursor = col.find(query).limit(SCAN_LIMIT);
      while (await cursor.hasNext()) {
        const doc = await cursor.next();

        // quick candidate-field checks
        for (const f of fieldVariants) {
          if (Object.prototype.hasOwnProperty.call(doc, f)) {
            const v = doc[f];
            if (isTicketCandidateValue(v) && String(v).trim().toLowerCase() === key.toLowerCase()) {
              if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] quick field match (${f}) in ${collName}`);
              return { doc, collection: collName };
            }
          }
        }

        // deep inspection
        const found = extractTicketIdFromObject(doc);
        if (found && String(found).trim().toLowerCase() === key.toLowerCase()) {
          if (process.env.DEBUG_TICKETS === "true") console.log(`[tickets] deep match in ${collName}`);
          return { doc, collection: collName };
        }

        // _rawForm special handling
        const raw = doc._rawForm;
        if (raw) {
          if (typeof raw === "string") {
            const p = tryParseJsonSafe(raw);
            if (p && typeof p === "object") {
              const f = extractTicketIdFromObject(p);
              if (f && String(f).trim().toLowerCase() === key.toLowerCase()) return { doc, collection: collName };
            } else if (looksLikeBase64(raw)) {
              try {
                const dec = Buffer.from(raw, "base64").toString("utf8");
                if (isTicketCandidateValue(dec) && String(dec).trim().toLowerCase() === key.toLowerCase()) return { doc, collection: collName };
                const p2 = tryParseJsonSafe(dec);
                if (p2 && typeof p2 === "object") {
                  const f2 = extractTicketIdFromObject(p2);
                  if (f2 && String(f2).trim().toLowerCase() === key.toLowerCase()) return { doc, collection: collName };
                }
              } catch (e) {}
            } else if (typeof raw === "string" && raw.toLowerCase().indexOf(key.toLowerCase()) !== -1) {
              return { doc, collection: collName };
            }
          } else if (typeof raw === "object") {
            const f3 = extractTicketIdFromObject(raw);
            if (f3 && String(f3).trim().toLowerCase() === key.toLowerCase()) return { doc, collection: collName };
          }
        }
      }
    } catch (e) {
      if (process.env.DEBUG_TICKETS === "true") console.warn("[tickets] scan fallback error", e);
    }
  }

  return null;
}

/* ---------- routes (/validate & /scan) ---------- */
router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId || req.body.raw;
    if (!incoming) return res.status(400).json({ success: false, error: "ticketId or raw payload required" });
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id" });

    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc, collection } = found;
    const entityTypeMap = { visitors: "visitor", exhibitors: "exhibitor", partners: "partner", speakers: "speaker", awardees: "awardee" };

    const ticket = {
      ticket_code: doc.ticket_code || ticketKey,
      entity_type: entityTypeMap[collection] || null,
      entity_id: doc._id,
      name: doc.name || doc.full_name || null,
      email: doc.email || null,
      company: doc.company || doc.org || doc.organization || null,
      category: doc.ticket_category || doc.category || null,
      txId: doc.txId || doc.tx_id || null,
      payment_status: doc.payment_status || doc.status || null,
      raw_row: doc
    };

    return res.json({ success: true, ticket });
  } catch (err) {
    console.error("tickets/validate error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId || req.body.raw;
    if (!incoming) return res.status(400).json({ success: false, error: "ticketId or raw payload required" });
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id" });

    const found = await findTicket(ticketKey);
    if (!found) return res.status(404).json({ success: false, error: "Ticket not found" });

    const { doc, collection } = found;
    const entityTypeMap = { visitors: "visitor", exhibitors: "exhibitor", partners: "partner", speakers: "speaker", awardees: "awardee" };

    const ticket = {
      ticket_code: doc.ticket_code || ticketKey,
      entity_type: entityTypeMap[collection] || null,
      entity_id: doc._id,
      name: doc.name || doc.full_name || "",
      email: doc.email || "",
      company: doc.company || doc.org || doc.organization || "",
      category: doc.ticket_category || doc.category || "GENERAL",
      raw_row: doc
    };

    // PDF generation (unchanged behavior)
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=ticket-${ticket.ticket_code}.pdf`);

    if (generateVisitorBadgePDF) {
      try {
        const pdfResult = await generateVisitorBadgePDF(ticket, process.env.BADGE_TEMPLATE_URL || "", {
          includeQRCode: true,
          qrPayload: { ticket_code: ticket.ticket_code },
          event: { name: process.env.EVENT_NAME || "Event", date: process.env.EVENT_DATE || "", venue: process.env.EVENT_VENUE || "" }
        });
        if (pdfResult && typeof pdfResult.pipe === "function") return pdfResult.pipe(res);
        if (Buffer.isBuffer(pdfResult)) return res.end(pdfResult);
        if (typeof pdfResult === "string" && pdfResult.startsWith("data:application/pdf;base64,")) {
          const b64 = pdfResult.split(",")[1];
          return res.end(Buffer.from(b64, "base64"));
        }
      } catch (e) {
        console.warn("generateVisitorBadgePDF failed; falling back to pdfkit", e && e.message);
      }
    }

    const docPdf = new PDFDocument({ size: [300, 450], margin: 12 });
    docPdf.pipe(res);
    docPdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    docPdf.moveDown(2);
    docPdf.fontSize(12).text(`Name: ${ticket.name}`);
    docPdf.text(`Email: ${ticket.email}`);
    docPdf.text(`Company: ${ticket.company}`);
    docPdf.moveDown();
    docPdf.fontSize(14).text(`Ticket: ${ticket.ticket_code}`, { align: "center" });
    docPdf.fontSize(12).text(`Category: ${ticket.category}`, { align: "center" });
    docPdf.end();

  } catch (err) {
    console.error("tickets/scan error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;