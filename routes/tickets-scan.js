const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const mongo = require("../utils/mongoClient");

/* ---------- DB helper ---------- */
async function getDb() {
  const db = mongo.getDb();
  return typeof db?.then === "function" ? await db : db;
}

/* ---------- helpers ---------- */
function isDigits(v) {
  return typeof v === "string" && /^\d+$/.test(v);
}

function normalize(v) {
  return typeof v === "string" ? v.trim() : v;
}

const CANDIDATE_FIELDS = [
  "ticket_code",
  "ticketCode",
  "ticket_id",
  "ticketId",
  "ticket",
  "ticketNo",
  "ticketno",
  "ticketid",
  "code"
];

/* ---------- extraction ---------- */
function extractTicketId(input) {
  if (input == null) return null;
  if (typeof input === "number") return String(input);
  if (typeof input === "string") {
    const m = input.match(/\d{3,12}/);
    return m ? m[0] : null;
  }
  if (typeof input === "object") {
    for (const k of Object.keys(input)) {
      if (CANDIDATE_FIELDS.includes(k)) {
        return String(input[k]);
      }
    }
  }
  return null;
}

/* ---------- core lookup ---------- */
async function findTicket(ticketKey) {
  const db = await getDb();
  const keyStr = normalize(String(ticketKey));
  const keyNum = isDigits(keyStr) ? Number(keyStr) : null;

  const collections = [
    "visitors",
    "exhibitors",
    "partners",
    "speakers",
    "awardees"
  ];

  for (const collName of collections) {
    const col = db.collection(collName);

    /* ---- 1. Exact unified match ---- */
    const exactOr = [];
    for (const f of CANDIDATE_FIELDS) {
      exactOr.push({ [f]: keyStr });
      if (keyNum !== null) exactOr.push({ [f]: keyNum });
    }

    const exact = await col.findOne({ $or: exactOr });
    if (exact) {
      return { doc: exact, collection: collName };
    }

    /* ---- 2. Safe scan fallback ---- */
    const cursor = col.find({}).limit(1000);

    while (await cursor.hasNext()) {
      const doc = await cursor.next();

      for (const f of CANDIDATE_FIELDS) {
        if (!(f in doc)) continue;

        const v = doc[f];
        if (keyNum !== null && typeof v === "number" && v === keyNum) {
          return { doc, collection: collName };
        }
        if (String(v).trim() === keyStr) {
          return { doc, collection: collName };
        }
      }
    }
  }

  return null;
}

/* ---------- validate ---------- */
router.post("/validate", express.json(), async (req, res) => {
  try {
    const incoming =
      req.body.ticketId !== undefined
        ? String(req.body.ticketId)
        : req.body.raw;

    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) {
      return res.status(400).json({ success: false, error: "Invalid ticket" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc, collection } = found;

    return res.json({
      success: true,
      ticket: {
        ticket_code: doc.ticket_code ?? ticketKey,
        entity_type: collection,
        entity_id: doc._id,
        name: doc.name || doc.full_name || "",
        email: doc.email || "",
        company: doc.company || "",
        raw_row: doc
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ---------- scan ---------- */
router.post("/scan", express.json(), async (req, res) => {
  try {
    const incoming =
      req.body.ticketId !== undefined
        ? String(req.body.ticketId)
        : req.body.raw;

    const ticketKey = extractTicketId(incoming);
    if (!ticketKey) {
      return res.status(400).json({ success: false, error: "Invalid ticket" });
    }

    const found = await findTicket(ticketKey);
    if (!found) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    const { doc } = found;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=ticket-${ticketKey}.pdf`
    );

    const pdf = new PDFDocument({ size: [300, 450], margin: 12 });
    pdf.pipe(res);
    pdf.fontSize(16).text("EVENT ENTRY PASS", { align: "center" });
    pdf.moveDown(2);
    pdf.fontSize(12).text(`Name: ${doc.name || ""}`);
    pdf.text(`Email: ${doc.email || ""}`);
    pdf.text(`Company: ${doc.company || ""}`);
    pdf.moveDown();
    pdf.fontSize(14).text(`Ticket: ${ticketKey}`, { align: "center" });
    pdf.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
