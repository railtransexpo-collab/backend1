const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { getDb } = require("../utils/mongoClient"); // your Mongo client util
const { sendMail } = require("../utils/mailer");

const API_BASE = (process.env.API_BASE || process.env.BACKEND_URL || "/api").replace(/\/$/, "");
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * POST /api/tickets/upgrade
 * Body: {
 *   entity_type: "speakers" | "awardees" | "exhibitors" | "partners",
 *   entity_id: "<id>",
 *   new_category: "vip" | "delegate" | "combo" | ...,
 *   amount?: number (optional; if present >0 create payment order)
 * }
 */
router.post("/", async (req, res) => {
  try {
    const { entity_type, entity_id, new_category, amount = 0, email } = req.body || {};
    if (!entity_type || !entity_id || !new_category) {
      return res.status(400).json({ success: false, error: "entity_type, entity_id and new_category are required" });
    }

    const db = await getDb();
    const collection = db.collection(entity_type);

    // Payment required: create order and return checkoutUrl
    if (Number(amount) > 0) {
      const payload = {
        amount: Number(amount),
        currency: "INR",
        description: `Ticket Upgrade - ${new_category}`,
        reference_id: String(entity_id),
        metadata: { entity_type, new_category },
      };

      try {
        const r = await fetch(`${API_BASE}/api/payment/create-order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "69420",
          },
          body: JSON.stringify(payload),
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || !js.success) {
          return res.status(502).json({ success: false, error: js.error || "Failed to create payment order" });
        }
        return res.json({ success: true, checkoutUrl: js.checkoutUrl || js.checkout_url || js.raw?.checkout_url, order: js });
      } catch (e) {
        console.error("Payment order creation failed:", e);
        return res.status(502).json({ success: false, error: "Failed to create payment order" });
      }
    }

    // No payment: perform upgrade immediately
    // 1) Fetch entity row
    let entityRow = null;
    try {
      const query = ObjectId.isValid(entity_id) ? { _id: new ObjectId(entity_id) } : { _id: entity_id };
      entityRow = await collection.findOne(query);
    } catch (e) {
      console.warn("Entity lookup failed:", e);
    }

    const ticket_code = (entityRow && (entityRow.ticket_code || entityRow.code)) || String(entity_id);
    const name = (entityRow && (entityRow.name || entityRow.fullName || entityRow.company)) || "";
    const emailToUse = email || (entityRow && (entityRow.email || entityRow.contactEmail)) || "";

    // 2) Update or create ticket
    try {
      const ticketsCol = db.collection("tickets");
      await ticketsCol.updateOne(
        { ticket_code },
        {
          $set: {
            entity_type: entity_type.replace(/s$/, ""),
            entity_id,
            name,
            email: emailToUse || null,
            company: entityRow?.company || null,
            category: new_category,
            meta: { upgradedFrom: "self-service", upgradedAt: new Date() },
          },
        },
        { upsert: true }
      );
    } catch (e) {
      console.warn("Ticket update/create failed:", e);
    }

    // 3) Update entity confirm fields
    try {
      const query = ObjectId.isValid(entity_id) ? { _id: new ObjectId(entity_id) } : { _id: entity_id };
      await collection.updateOne(query, {
        $set: { ticket_category: new_category, upgradedAt: new Date() },
      });
    } catch (e) {
      console.warn("Entity confirm update failed:", e);
    }

    // 4) Send confirmation email
    if (emailToUse) {
      try {
        const upgradeManageUrl = `${FRONTEND_BASE}/ticket?entity=${encodeURIComponent(entity_type)}&id=${encodeURIComponent(String(entity_id))}`;
        const subj = `Your ticket has been upgraded to ${new_category}`;
        const bodyText = `Hello ${name || ""},\n\nYour ticket has been upgraded to ${new_category}.\n\nYou can view/manage your ticket here: ${upgradeManageUrl}\n\nRegards,\nTeam`;
        const bodyHtml = `<p>Hello ${name || ""},</p><p>Your ticket has been upgraded to <strong>${new_category}</strong>.</p><p>You can view/manage your ticket <a href="${upgradeManageUrl}">here</a>.</p>`;
        await sendMail({ to: emailToUse, subject: subj, text: bodyText, html: bodyHtml });
      } catch (e) {
        console.warn("Upgrade confirmation email failed:", e);
      }
    }

    return res.json({ success: true, upgraded: true, entity_type, entity_id, new_category });
  } catch (err) {
    console.error("tickets-upgrade error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

module.exports = router;
