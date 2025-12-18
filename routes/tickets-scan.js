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
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract ticket id candidate from an object (shallow preference then deep stack scan).
 */
function extractTicketIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const prefer = ["ticket_code","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid","code","c","id","tk","t"];
  for (const k of prefer) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    const snake = k.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(obj, snake)) {
      const v = obj[snake];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }

  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;

    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const s = String(node).trim();
      if (s) return s;
      if (typeof node === "string") {
        const parsed = tryParseJsonSafe(node);
        if (parsed && typeof parsed === 'object') stack.push(parsed);
        else if (looksLikeBase64(node)) {
          try {
            const dec = Buffer.from(node, 'base64').toString('utf8');
            const p2 = tryParseJsonSafe(dec);
            if (p2 && typeof p2 === 'object') stack.push(p2);
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

/**
 * Normalise various inputs into a ticket key string (supports digits, tokens, JSON, base64 JSON).
 * - Prefer a 3-64 char alphanumeric/token match (covers TICK-ABC123, DLN2722)
 * - Then fallback to numeric substring (3-12 digits) for purely numeric systems
 */
function extractTicketId(input) {
  if (input === undefined || input === null) return null;

  if (typeof input === 'number') return String(input);

  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;

    // Try parse JSON first (common if scanner encoded JSON)
    const parsed = tryParseJsonSafe(s);
    if (parsed && typeof parsed === 'object') {
      const f = extractTicketIdFromObject(parsed);
      if (f) return f;
    }

    // If it's base64, try decode and parse
    if (looksLikeBase64(s)) {
      try {
        const dec = Buffer.from(s, 'base64').toString('utf8');
        const p2 = tryParseJsonSafe(dec);
        if (p2 && typeof p2 === 'object') {
          const f2 = extractTicketIdFromObject(p2);
          if (f2) return f2;
        }
        // try token/digits in decoded string
        const tokDec = dec.match(/[A-Za-z0-9\-_\.]{3,64}/);
        if (tokDec) return tokDec[0];
        const digDec = dec.match(/\d{3,12}/);
        if (digDec) return digDec[0];
      } catch (e) {}
    }

    // Look for an alphanumeric token (covers most QR payloads like TICK-ABC123, DLN2722, etc.)
    const token = s.match(/[A-Za-z0-9\-_\.]{3,64}/);
    if (token) return token[0];

    // Finally fallback to numeric substring for numeric-only codes
    const m = s.match(/\d{3,12}/);
    if (m) return m[0];

    return null;
  }

  if (typeof input === 'object') {
    const f = extractTicketIdFromObject(input);
    if (f) return f;
    return null;
  }

  return null;
}

const CANDIDATE_FIELDS = ["ticket_code","ticketCode","ticket_id","ticketId","ticket","ticketNo","ticketno","ticketid","code","c","id","tk","t","ticket_code_num"];

async function findTicketDetailed(ticketKey) {
  const debug = { ticketKey, checked: [] };
  const db = await getDb();
  const keyStr = String(ticketKey).trim();
  const isNum = /^\d+$/.test(keyStr);
  const keyNum = isNum ? Number(keyStr) : null;
  const collections = ["visitors","exhibitors","partners","speakers","awardees"];
  const SCAN_LIMIT = Number(process.env.TICKET_SCAN_SCAN_LIMIT || 1000);

  for (const collName of collections) {
    const collDebug = { collection: collName, steps: [], matched: null };
    const col = db.collection(collName);

    // 1) exact ticket_code as string
    try {
      const exact = await col.findOne({ ticket_code: keyStr });
      collDebug.steps.push({ step: 'exact_ticket_code_string', found: !!exact });
      if (exact) {
        collDebug.matched = { by: 'ticket_code_string', doc: { _id: String(exact._id), ticket_code: exact.ticket_code } };
        debug.checked.push(collDebug);
        return { debug, result: { doc: exact, collection: collName } };
      }
    } catch (e) { collDebug.steps.push({ step:'exact_ticket_code_string_error', error: String(e && e.message) }); }

    // 1b) exact ticket_code_num if numeric
    if (keyNum !== null) {
      try {
        const exactNum = await col.findOne({ ticket_code_num: keyNum });
        collDebug.steps.push({ step: 'exact_ticket_code_num_field', found: !!exactNum });
        if (exactNum) {
          collDebug.matched = { by: 'ticket_code_num', doc: { _id: String(exactNum._id), ticket_code_num: exactNum.ticket_code_num } };
          debug.checked.push(collDebug);
          return { debug, result: { doc: exactNum, collection: collName } };
        }
      } catch (e) { collDebug.steps.push({ step:'exact_ticket_code_num_error', error: String(e && e.message) }); }
    }

    // 1c) exact ticket_code as number (legacy where ticket_code stored as number)
    if (keyNum !== null) {
      try {
        const exactNum2 = await col.findOne({ ticket_code: keyNum });
        collDebug.steps.push({ step: 'exact_ticket_code_number', found: !!exactNum2 });
        if (exactNum2) {
          collDebug.matched = { by: 'ticket_code_number', doc: { _id: String(exactNum2._id), ticket_code: exactNum2.ticket_code } };
          debug.checked.push(collDebug);
          return { debug, result: { doc: exactNum2, collection: collName } };
        }
      } catch (e) { collDebug.steps.push({ step:'exact_ticket_code_number_error', error: String(e && e.message) }); }
    }

    // 2) candidate fields exact and regex (string and numeric)
    try {
      const or = [];
      for (const f of CANDIDATE_FIELDS) {
        const o1 = {}; o1[f] = keyStr; or.push(o1);
        // anchored case-insensitive regex fallback for string tokens
        const orRe = {}; orRe[f] = { $regex: new RegExp(`^${escapeRegex(keyStr)}$`, "i") }; or.push(orRe);
        if (keyNum !== null) { const o2 = {}; o2[f] = keyNum; or.push(o2); }
      }
      const row = or.length ? await col.findOne({ $or: or }) : null;
      collDebug.steps.push({ step: 'candidate_fields_db', found: !!row, tried: or.length });
      if (row) {
        collDebug.matched = { by: 'candidate_field', doc: { _id: String(row._id) } };
        debug.checked.push(collDebug);
        return { debug, result: { doc: row, collection: collName } };
      }
    } catch (e) { collDebug.steps.push({ step:'candidate_fields_error', error: String(e && e.message) }); }

    // 3) controlled JS scan fallback (limited)
    try {
      const existsClauses = CANDIDATE_FIELDS.map(f=> ({ [f]: { $exists: true } })); existsClauses.push({ _rawForm: { $exists: true } });
      const cursor = col.find({ $or: existsClauses }).limit(SCAN_LIMIT);
      collDebug.steps.push({ step: 'scan_start', limit: SCAN_LIMIT });
      while (await cursor.hasNext()) {
        const d = await cursor.next();

        // quick field checks
        for (const f of CANDIDATE_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(d, f)) continue;
          const v = d[f];
          if (v === undefined || v === null) continue;
          if (keyNum !== null && typeof v === 'number' && v === keyNum) {
            collDebug.matched = { by: `field_${f}_number`, doc: { _id: String(d._id), [f]: v } };
            debug.checked.push(collDebug);
            return { debug, result: { doc: d, collection: collName } };
          }
          if (String(v).trim() === keyStr) {
            collDebug.matched = { by: `field_${f}_string`, doc: { _id: String(d._id), [f]: v } };
            debug.checked.push(collDebug);
            return { debug, result: { doc: d, collection: collName } };
          }
          if (typeof v === 'string' && String(v).trim().toLowerCase() === keyStr.toLowerCase()) {
            collDebug.matched = { by: `field_${f}_ci_string`, doc: { _id: String(d._id), [f]: v } };
            debug.checked.push(collDebug);
            return { debug, result: { doc: d, collection: collName } };
          }
        }

        // deep inspect
        const found = extractTicketIdFromObject(d);
        if (found && String(found).trim() === keyStr) {
          collDebug.matched = { by: 'deep_inspect', doc: { _id: String(d._id) } };
          debug.checked.push(collDebug);
          return { debug, result: { doc: d, collection: collName } };
        }
      }
      collDebug.steps.push({ step: 'scan_complete' });
    } catch (e) {
      collDebug.steps.push({ step:'scan_error', error: String(e && e.message) });
    }

    debug.checked.push(collDebug);
  }

  return { debug, result: null };
}

/* validate route */
router.post("/validate", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId !== undefined ? req.body.ticketId : req.body.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

    if (process.env.DEBUG_TICKETS === "true") console.log("[tickets.validate] extracted ticketKey:", ticketKey);

    const fd = await findTicketDetailed(ticketKey);
    if (!fd || !fd.result) {
      const wantDebug = req.query.debug === '1' || process.env.DEBUG_TICKETS === 'true';
      if (wantDebug) return res.status(404).json({ success: false, error: "Ticket not found", debug: fd.debug });
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc, collection } = fd.result;

    const ticket = {
      ticket_code: doc.ticket_code || String(ticketKey).trim(),
      entity_type: collection,
      entity_id: doc._id,
      name: doc.name || doc.full_name || null,
      email: doc.email || doc.e || null,
      company: doc.company || doc.org || null,
      category: doc.category || doc.ticket_category || null,
      raw_row: doc
    };

    return res.json({ success: true, ticket });
  } catch (err) {
    console.error("tickets/validate error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* scan route */
router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId !== undefined ? req.body.ticketId : req.body.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

    if (process.env.DEBUG_TICKETS === "true") console.log("[tickets.scan] ticketKey:", ticketKey);

    const fd = await findTicketDetailed(ticketKey);
    if (!fd || !fd.result) {
      const wantDebug = req.query.debug === '1' || process.env.DEBUG_TICKETS === 'true';
      if (wantDebug) return res.status(404).json({ success: false, error: "Ticket not found", debug: fd.debug });
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc } = fd.result;

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
    console.error("tickets/scan error:", err && (err.stack || err));
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* debug-check endpoint */
router.post("/debug-check", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body.ticketId !== undefined ? req.body.ticketId : req.body.raw;
    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) return res.status(400).json({ success: false, error: "Could not extract ticket id from payload" });

    const fd = await findTicketDetailed(ticketKey);
    return res.json({ success: true, debug: fd.debug, found: !!fd.result, matchedCollection: fd.result ? fd.result.collection : null, sampleDoc: fd.result ? { _id: String(fd.result.doc._id), ticket_code: fd.result.doc.ticket_code } : null });
  } catch (err) {
    console.error("tickets/debug-check error:", err && (err.stack || err));
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;