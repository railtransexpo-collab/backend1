const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { getDb } = require("../utils/mongoClient"); // should export async getDb()
const { sendMail } = require("../utils/mailer");
const { ensureTicketCodeUniqueIndex, safeFieldName } = require("../utils/mongoSchemaSync"); // ensure index helper (optional)

/**
 * Allowed entity collections that can be upgraded.
 * Restrict to known collections to avoid arbitrary collection access.
 */
const ALLOWED_ENTITIES = new Set(["speakers", "awardees", "exhibitors", "partners",  "visitors"]);

const API_BASE = (process.env.API_BASE || process.env.BACKEND_URL || "/api").replace(/\/$/, "");
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function makeApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

function generateTicketCode(length = 6, prefix = "TICK-") {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${prefix}${code}`;
}

router.post("/", async (req, res) => {
  try {
    const { entity_type, entity_id, new_category, amount = 0, email } = req.body || {};

    // Basic validation
    if (!entity_type || !entity_id || !new_category) {
      return res.status(400).json({ success: false, error: "entity_type, entity_id and new_category are required" });
    }
    if (!ALLOWED_ENTITIES.has(entity_type)) {
      return res.status(400).json({ success: false, error: "entity_type not allowed" });
    }

    // Payment required: delegate to payment API and return checkout url
    if (Number(amount) > 0) {
      const payload = {
        amount: Number(amount),
        currency: "INR",
        description: `Ticket Upgrade - ${new_category}`,
        reference_id: String(entity_id),
        metadata: { entity_type, new_category },
      };
      try {
        const r = await fetch(makeApiUrl("/payment/create-order"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "69420" },
          body: JSON.stringify(payload),
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || !js.success) {
          return res.status(502).json({ success: false, error: js.error || "Failed to create payment order", raw: js });
        }
        return res.json({ success: true, checkoutUrl: js.checkoutUrl || js.checkout_url || js.raw?.checkout_url, order: js });
      } catch (e) {
        console.error("Payment create order failed", e);
        return res.status(502).json({ success: false, error: "Failed to create payment order" });
      }
    }

    // No payment: apply upgrade immediately in Mongo
    const db = await getDb();
    if (!db) return res.status(500).json({ success: false, error: "database not available" });

    const entityCol = db.collection(entity_type);

    // Fetch entity document
    let entityRow = null;
    try {
      const q = ObjectId.isValid(entity_id) ? { _id: new ObjectId(entity_id) } : { _id: entity_id };
      entityRow = await entityCol.findOne(q);
    } catch (e) {
      console.warn("Entity lookup failed:", e && e.message);
    }

    // Determine ticket_code to use. Prefer existing ticket_code on entity, then fallback to entity_id string.
    // If that results in a poor code (e.g. you want TICK-...), we generate a ticket on tickets collection below.
    let ticket_code = entityRow && (entityRow.ticket_code || entityRow.code) ? String(entityRow.ticket_code || entityRow.code) : null;
    const name = (entityRow && (entityRow.name || entityRow.fullName || entityRow.company)) || "";
    const emailToUse = (email && String(email).trim()) || (entityRow && (entityRow.email || entityRow.contactEmail)) || "";

    // Ensure ticket_code index exists (best-effort)
    try { await ensureTicketCodeUniqueIndex(db, "tickets"); } catch (e) { /* ignore */ }

    // Upsert ticket document and return the resulting doc so we have the final ticket_code
    const ticketsCol = db.collection("tickets");
    let ticketDoc = null;
    try {
      // If ticket_code is missing, generate a candidate; we will upsert with findOneAndUpdate to get resulting doc
      if (!ticket_code) ticket_code = generateTicketCode();

      const filter = { ticket_code };
      const update = {
        $set: {
          entity_type: entity_type.replace(/s$/, ""),
          entity_id: entity_id,
          name,
          email: emailToUse || null,
          company: entityRow?.company || null,
          category: new_category,
          meta: { upgradedFrom: "self-service", upgradedAt: new Date() },
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date(), ticket_code },
      };

      // Use findOneAndUpdate with upsert and return the final doc (driver v4 option)
      const opts = { upsert: true, returnDocument: "after" };
      const result = await ticketsCol.findOneAndUpdate(filter, update, opts);
      ticketDoc = result && result.value ? result.value : null;

      // If we attempted to upsert with generated ticket_code but ran into duplicate-key on ticket_code (rare),
      // try regenerating ticket_code a few times.
      if (!ticketDoc) {
        // fallback retry loop (defensive)
        const maxAttempts = 5;
        for (let i = 0; i < maxAttempts && !ticketDoc; i++) {
          const candidate = generateTicketCode();
          try {
            const r2 = await ticketsCol.findOneAndUpdate(
              { ticket_code: candidate },
              {
                $set: {
                  entity_type: entity_type.replace(/s$/, ""),
                  entity_id: entity_id,
                  name,
                  email: emailToUse || null,
                  company: entityRow?.company || null,
                  category: new_category,
                  meta: { upgradedFrom: "self-service", upgradedAt: new Date() },
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date(), ticket_code: candidate },
              },
              { upsert: true, returnDocument: "after" }
            );
            ticketDoc = r2 && r2.value ? r2.value : null;
            if (ticketDoc) ticket_code = ticketDoc.ticket_code;
          } catch (err) {
            // if duplicate key, loop and retry; else throw
            const isDup = err && (err.code === 11000 || (err.errmsg && err.errmsg.indexOf("E11000") !== -1));
            if (!isDup) throw err;
          }
        }
      } else {
        ticket_code = ticketDoc.ticket_code;
      }
    } catch (e) {
      console.warn("Ticket upsert failed:", e && e.message);
      // continue — we still try to update entity and notify user
    }

    // Update entity's confirm fields (best-effort)
    try {
      const q = ObjectId.isValid(entity_id) ? { _id: new ObjectId(entity_id) } : { _id: entity_id };
      await entityCol.updateOne(q, { $set: { ticket_category: new_category, upgradedAt: new Date(), ticket_code } });
    } catch (e) {
      console.warn("Entity confirm update failed:", e && e.message);
    }

    // Send confirmation email with ticket_code and manage link
    if (emailToUse) {
      try {
        const params = new URLSearchParams({ entity: entity_type, id: String(entity_id) });
        if (ticket_code) params.append("ticket", ticket_code);
        const upgradeManageUrl = `${FRONTEND_BASE}/ticket?${params.toString()}`;

        const subj = `Your ticket has been upgraded to ${new_category}`;
        const bodyText = `Hello ${name || ""},\n\nYour ticket has been upgraded to ${new_category}.\n\nTicket: ${ticket_code || "N/A"}\nYou can view/manage your ticket here: ${upgradeManageUrl}\n\nRegards,\nTeam`;
        const bodyHtml = `<p>Hello ${name || ""},</p><p>Your ticket has been upgraded to <strong>${new_category}</strong>.</p><p>Ticket: <strong>${ticket_code || "N/A"}</strong></p><p>You can view/manage your ticket <a href="${upgradeManageUrl}">here</a>.</p>`;

        await sendMail({ to: emailToUse, subject: subj, text: bodyText, html: bodyHtml });
      } catch (e) {
        console.warn("Upgrade confirmation email failed:", e && e.message);
      }
    }

    return res.json({
      success: true,
      upgraded: true,
      entity_type,
      entity_id,
      new_category,
      ticket_code: ticket_code || null,
      ticket: ticketDoc || undefined,
    });
  } catch (err) {
    console.error("tickets-upgrade error:", err && (err.stack || err));
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

module.exports = router;