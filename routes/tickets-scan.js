const express = require("express");
const router = express.Router();
const mongo = require("../utils/mongoClient");
const { generateBadgePDF } = require("../utils/badgeGenerator"); // 🔥 REUSE

console.log("🔥 tickets-scan. js LOADED");

/* ------------------ DB ------------------ */
async function getDb() {
  if (!mongo || typeof mongo.getDb !== "function") {
    throw new Error("mongoClient not available");
  }
  const db = mongo.getDb();
  return typeof db?. then === "function" ? await db : db;
}

/* ------------------ helpers ------------------ */
function tryParseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function looksLikeBase64(s) {
  return (
    typeof s === "string" &&
    /^[A-Za-z0-9+/=]+$/.test(s. replace(/\s+/g, "")) &&
    s.length % 4 === 0
  );
}

function extractTicketIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = [
    "ticket_code",
    "ticketCode",
    "ticket_id",
    "ticketId",
    "ticket",
    "ticketNo",
    "ticketno",
    "ticketid",
    "code",
    "c",
    "id",
    "tk",
    "t",
  ];

  // Check preferred keys first
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        return String(v).trim();
      }
    }
  }

  // Deep scan using stack (avoid recursion)
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (! node) continue;

    if (
      typeof node === "string" ||
      typeof node === "number" ||
      typeof node === "boolean"
    ) {
      const s = String(node).trim();
      if (s) return s;

      if (typeof node === "string") {
        const parsed = tryParseJsonSafe(node);
        if (parsed && typeof parsed === "object") {
          stack.push(parsed);
        } else if (looksLikeBase64(node)) {
          try {
            const dec = Buffer.from(node, "base64").toString("utf8");
            const p2 = tryParseJsonSafe(dec);
            if (p2 && typeof p2 === "object") {
              stack. push(p2);
            } else if (dec && dec.trim()) {
              return dec.trim();
            }
          } catch (e) {
            // ignore base64 decode errors
          }
        }
      }
      continue;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push(node[i]);
      }
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

function extractTicketId(input) {
  if (input === undefined || input === null) return null;

  if (typeof input === "number") return String(input);

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;

    // Try parsing as JSON
    const parsed = tryParseJsonSafe(s);
    if (parsed && typeof parsed === "object") {
      const f = extractTicketIdFromObject(parsed);
      if (f) return f;
    }

    // Try base64 decode
    if (looksLikeBase64(s)) {
      try {
        const dec = Buffer.from(s, "base64").toString("utf8");
        const p2 = tryParseJsonSafe(dec);
        if (p2 && typeof p2 === "object") {
          const f2 = extractTicketIdFromObject(p2);
          if (f2) return f2;
        }
        const tokenDec = dec.match(/[A-Za-z0-9._-]{3,64}/);
        if (tokenDec) return tokenDec[0];
        const digDec = dec.match(/\d{3,12}/);
        if (digDec) return digDec[0];
      } catch (e) {
        // ignore
      }
    }

    // Try token pattern
    const token = s.match(/[A-Za-z0-9._-]{3,64}/);
    if (token) return token[0];

    // Try numeric substring
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
const COLLECTIONS = ["visitors", "exhibitors", "partners", "speakers", "awardees"];

async function findTicket(ticketCode) {
  const db = await getDb();
  const codeStr = String(ticketCode);
  const codeNum = Number(codeStr);

  for (const coll of COLLECTIONS) {
    const doc = await db. collection(coll).findOne({
      $or: [{ ticket_code: codeStr }, { ticket_code_num: codeNum }],
    });
    if (doc) return { doc, collection: coll };
  }
  return null;
}

/* ------------------ routes ------------------ */

router.get("/__ping", (req, res) => {
  res.json({ ok: true, router: "tickets-scan" });
});

/**
 * POST /api/tickets/validate
 * Validates ticket and returns basic info (no PDF)
 */
router.post("/validate", express.json(), async (req, res) => {
  try {
    const raw = req.body?. ticketId;
    if (raw === undefined || raw === null) {
      return res.status(400).json({ success: false, error: "Missing ticketId" });
    }

    const ticketCode = String(raw).trim();
    if (!ticketCode || ticketCode.length < 3) {
      return res.status(400).json({ success: false, error: "Invalid ticket_code" });
    }

    const found = await findTicket(ticketCode);
    if (!found) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc, collection } = found;

    res.json({
      success: true,
      ticket: {
        ticket_code:  doc.ticket_code,
        entity_type: collection,
        name: doc.name || doc.full_name || "",
        email: doc.email || "",
        company: doc.company || doc.organization || "",
      },
    });
  } catch (e) {
    console.error("[tickets-scan] validate error:", e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/**
 * POST /api/tickets/scan
 * Returns SIMPLE badge PDF with ONLY QR, Name, Organization
 */
router.post("/scan", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming = req.body?.ticketId !== undefined ? req.body.ticketId : req.body?.raw;
    const ticketKey = extractTicketId(incoming);

    if (!ticketKey) {
      return res.status(400).json({ error: "Invalid ticket" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const { doc, collection } = found;

    // Normalize data for badge generator
    const badgeData = {
      ...doc,
      name: doc.name || doc.data?.name || doc.full_name || "Attendee",
      company: doc.company || doc.organization || doc.data?.company || "Organization",
      ticket_code: doc.ticket_code || doc.data?.ticket_code || ticketKey,
    };

    // ✅ NEW: Generate SIMPLE badge with ONLY QR, Name, Organization
    // We'll create a new function in badgeGenerator or modify the existing one
    // For now, let's create a simple HTML to PDF conversion
    const { generateSimpleBadgePDF } = require("../utils/simpleBadgeGenerator");
    
    const pdfBuffer = await generateSimpleBadgePDF(badgeData);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=badge-${ticketKey}.pdf`
    );
    res.end(pdfBuffer);
  } catch (e) {
    console.error("[tickets-scan] scan error:", e && (e.stack || e));
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/tickets/debug-check
 * Diagnostic endpoint for troubleshooting scan failures
 */
router.post("/debug-check", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const incoming =
      req.body?.ticketId !== undefined ? req.body.ticketId : req.body?.raw;
    const ticketKey = extractTicketId(incoming);

    if (!ticketKey) {
      return res.status(400).json({ success: false, error: "Invalid ticket" });
    }

    const db = await getDb();
    const debug = { ticketKey, checkedCollections: [] };

    for (const collName of COLLECTIONS) {
      const col = db.collection(collName);
      const sample = await col.findOne({});
      const count = await col.countDocuments({ ticket_code: ticketKey });

      debug.checkedCollections. push({
        coll: collName,
        sampleHasTicketCode: ! !(sample && sample.ticket_code),
        matchCount: count,
      });
    }

    return res.json({ success: true, debug });
  } catch (err) {
    console.error("[tickets-scan] debug-check error:", err && (err.stack || err));
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;