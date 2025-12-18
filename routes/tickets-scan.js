const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

console.log("🔥 tickets-scan.js LOADED");

/* ------------------ DB ------------------ */
async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") {
    throw new Error("mongoClient not available");
  }
  const db = mongo.getDb();
  return typeof db?.then === "function" ? await db : db;
}

/* ------------------ helpers ------------------ */
function tryParseJsonSafe(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function looksLikeBase64(s) {
  return typeof s === "string"
    && /^[A-Za-z0-9+/=]+$/.test(s.replace(/\s+/g, ""))
    && s.length % 4 === 0;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Attempts to extract a ticket id from a nested object.
   Prefers explicit keys, then falls back to deeper scanning.
*/
function extractTicketIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = [
    "ticket_code","ticketCode",
    "ticket_id","ticketId",
    "ticket","ticketNo","ticketno","ticketid",
    "code","c","id","tk","t"
  ];
  // preferred keys first
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    // also try snake_case variant
    const snake = k.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(obj, snake)) {
      const v = obj[snake];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }

  // stack-based deep scan (avoid recursion)
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const s = String(node).trim();
      if (s) return s;
      if (typeof node === "string") {
        const parsed = tryParseJsonSafe(node);
        if (parsed && typeof parsed === "object") stack.push(parsed);
        else if (looksLikeBase64(node)) {
          try {
            const dec = Buffer.from(node, "base64").toString("utf8");
            const p2 = tryParseJsonSafe(dec);
            if (p2 && typeof p2 === "object") stack.push(p2);
            else if (dec && dec.trim()) return dec.trim();
          } catch (e) {}
        }
      }
      continue;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) stack.push(node[i]);
      continue;
    }

    if (typeof node === "object") {
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (v === null || v === undefined) continue;
        stack.push(v);
      }
    }
  }
  return null;
}

/* Normalise input into a ticket id string (supports tokens, numeric substrings, JSON, base64 JSON) */
function extractTicketId(input) {
  if (input === undefined || input === null) return null;

  if (typeof input === "number") return String(input);

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;

    // JSON string
    const parsed = tryParseJsonSafe(s);
    if (parsed && typeof parsed === "object") {
      const f = extractTicketIdFromObject(parsed);
      if (f) return f;
    }

    // base64 encoded JSON or token
    if (looksLikeBase64(s)) {
      try {
        const dec = Buffer.from(s, "base64").toString("utf8");
        const p2 = tryParseJsonSafe(dec);
        if (p2 && typeof p2 === "object") {
          const f2 = extractTicketIdFromObject(p2);
          if (f2) return f2;
        }
        // fallback token/digits from decoded string
        const tokenDec = dec.match(/[A-Za-z0-9._-]{3,64}/);
        if (tokenDec) return tokenDec[0];
        const digDec = dec.match(/\d{3,12}/);
        if (digDec) return digDec[0];
      } catch (e) { /* ignore */ }
    }

    // token-like (alphanumeric with -._)
    const token = s.match(/[A-Za-z0-9._-]{3,64}/);
    if (token) return token[0];

    // numeric substring fallback
    const m = s.match(/\d{3,12}/);
    if (m) return m[0];

    return null;
  }

  if (typeof input === "object") {
    const f = extractTicketIdFromObject(input);
    if (f) return f;
    return null;
  }

  return null;
}

/* ------------------ ticket lookup ------------------ */

const COLLECTIONS = ["visitors","exhibitors","partners","speakers","awardees"];
const CANDIDATE_FIELDS = ["ticket_code","ticket_code_num","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid","code","c","id","tk","t"];

/* findTicket:
   - tries exact ticket_code (string),
   - tries ticket_code_num if numeric,
   - tries candidate fields with exact and case-insensitive anchored regex,
   - falls back to scanning documents that have candidate fields or _rawForm (limited).
*/
async function findTicket(ticketKey) {
  const db = await getDb();
  const keyStr = String(ticketKey).trim();
  const isNum = /^\d+$/.test(keyStr);
  const keyNum = isNum ? Number(keyStr) : null;

  for (const collName of COLLECTIONS) {
    const col = db.collection(collName);

    // 1: exact ticket_code string
    try {
      const exact = await col.findOne({ ticket_code: keyStr });
      if (exact) return { doc: exact, collection: collName };
    } catch (e) { /* ignore */ }

    // 1b: ticket_code_num (numeric field)
    if (keyNum !== null) {
      try {
        const exactNum = await col.findOne({ ticket_code_num: keyNum });
        if (exactNum) return { doc: exactNum, collection: collName };
      } catch (e) {}
    }

    // 1c: ticket_code stored as number
    if (keyNum !== null) {
      try {
        const exactNum2 = await col.findOne({ ticket_code: keyNum });
        if (exactNum2) return { doc: exactNum2, collection: collName };
      } catch (e) {}
    }

    // 2: candidate fields via $or (exact string/number and anchored case-insensitive regex)
    try {
      const or = [];
      for (const f of CANDIDATE_FIELDS) {
        const objStr = {}; objStr[f] = keyStr; or.push(objStr);
        // case insensitive anchored regex
        const objRe = {}; objRe[f] = { $regex: new RegExp(`^${escapeRegex(keyStr)}$`, "i") }; or.push(objRe);
        if (keyNum !== null) { const objNum = {}; objNum[f] = keyNum; or.push(objNum); }
      }
      if (or.length) {
        const row = await col.findOne({ $or: or });
        if (row) return { doc: row, collection: collName };
      }
    } catch (e) { /* ignore */ }

    // 3: controlled JS scan fallback, limited to docs that have candidate fields or _rawForm
    try {
      const existsClauses = CANDIDATE_FIELDS.map(f => ({ [f]: { $exists: true } }));
      existsClauses.push({ _rawForm: { $exists: true } });
      const cursor = col.find({ $or: existsClauses }).limit(Number(process.env.TICKET_SCAN_SCAN_LIMIT || 1000));
      while (await cursor.hasNext()) {
        const d = await cursor.next();
        // quick checks on candidate fields
        for (const f of CANDIDATE_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(d, f)) continue;
          const v = d[f];
          if (v === undefined || v === null) continue;
          if (keyNum !== null && typeof v === "number" && v === keyNum) return { doc: d, collection: collName };
          if (String(v).trim() === keyStr) return { doc: d, collection: collName };
          if (typeof v === "string" && String(v).trim().toLowerCase() === keyStr.toLowerCase()) return { doc: d, collection: collName };
        }
        // deep inspect the document
        const found = extractTicketIdFromObject(d);
        if (found && String(found).trim() === keyStr) return { doc: d, collection: collName };
      }
    } catch (e) { /* ignore */ }
  }

  return null;
}

/* ------------------ routes ------------------ */

router.get("/__ping", (req, res) => {
  res.json({ ok: true, router: "tickets-scan" });
});

router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body?.ticketId !== undefined ? req.body.ticketId : req.body?.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) {
      if (process.env.DEBUG_TICKETS === "true") console.log("[tickets-scan] validate: could not extract from payload:", req.body);
      return res.status(400).json({ success: false, error: "Invalid ticket" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      const debug = process.env.DEBUG_TICKETS === "true" ? { extracted: ticketKey } : undefined;
      return res.status(404).json({ success: false, error: "Ticket not found", debug });
    }

    const { doc, collection } = found;

    res.json({
      success: true,
      ticket: {
        ticket_code: doc.ticket_code,
        entity_type: collection,
        name: doc.name || doc.full_name || "",
        email: doc.email || "",
        company: doc.company || doc.org || "",
        category: doc.category || ""
      }
    });
  } catch (e) {
    console.error("tickets-scan validate error:", e && (e.stack || e));
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body?.ticketId !== undefined ? req.body.ticketId : req.body?.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) {
      return res.status(400).json({ error: "Invalid ticket" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ error: "Not found" });
    }

    const { doc } = found;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=ticket-${ticketKey}.pdf`);

    const pdf = new PDFDocument({ size: [300, 450], margin: 12 });
    pdf.pipe(res);

    pdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    pdf.moveDown();
    pdf.fontSize(12).text(`Name: ${doc.name || ""}`);
    pdf.text(`Email: ${doc.email || ""}`);
    pdf.text(`Company: ${doc.company || doc.org || ""}`);
    pdf.moveDown();
    pdf.fontSize(14).text(`Ticket: ${ticketKey}`, { align: "center" });

    pdf.end();
  } catch (e) {
    console.error("tickets-scan scan error:", e && (e.stack || e));
    res.status(500).json({ error: "Server error" });
  }
});

/* debug-check - returns diagnostics about where it checked (helpful when scanning fails) */
router.post("/debug-check", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body?.ticketId !== undefined ? req.body.ticketId : req.body?.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Invalid ticket" });

    const db = await getDb();
    const debug = { ticketKey, checkedCollections: [] };

    for (const collName of COLLECTIONS) {
      const col = db.collection(collName);
      const sample = await col.findOne({});
      debug.checkedCollections.push({ coll: collName, sampleHasTicketCode: !!(sample && (sample.ticket_code || sample.ticketId || sample.code || sample._rawForm)) });
    }

    return res.json({ success: true, debug });
  } catch (err) {
    console.error("tickets-scan debug-check error:", err && (err.stack || err));
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;