const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const mongo = require("../utils/mongoClient");
const sendTicketEmail = require("../utils/sendTicketEmail");

console.log("🔥 tickets-upgrade.js LOADING.. .");

const ALLOWED_ENTITIES = new Set([
  "speakers",
  "awardees",
  "exhibitors",
  "partners",
  "visitors",
]);


const API_BASE = (process.env.BACKEND_ORIGIN || process.env.API_BASE || "https://influential-panda-railtransexpo-39a8c6ee.koyeb.app").replace(/\/$/, "");
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.APP_ORIGIN || "https://www.irmaindia.com").replace(/\/$/, "");

async function obtainDb() {
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") return await mongo.getDb();
  if (mongo.db) return mongo.db;
  return null;
}

function generateTicketCode(length = 6, prefix = "TICK-") {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${prefix}${code}`;
}

function normalizeEmail(e) {
  try {
    return (String(e || "").trim() || "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * POST /api/tickets/upgrade
 *
 * Body:  
 *  - entity_type: string (collection name)
 *  - entity_id: string (Mongo _id)
 *  - new_category: string
 *  - amount: number
 *  - email: string (for verification)
 *  - txId: string (optional, if payment already completed)
 *  - method: string (optional:  "online", "manual", "free")
 *  - couponCode: string (optional, coupon code applied by user)
 */
async function handleUpgrade(req, res) {
  try {
    console.log("[tickets-upgrade] POST request:", req.body);

    const { entity_type, entity_id, new_category, amount = 0, email, txId, method = "online", couponCode } = req.body || {};

    if (!entity_type || !entity_id || !new_category) {
      return res.status(400).json({ 
        success: false, 
        error:  "entity_type, entity_id and new_category are required" 
      });
    }

    if (!ALLOWED_ENTITIES.has(String(entity_type).toLowerCase())) {
      return res.status(400).json({ 
        success: false, 
        error:  "entity_type not allowed" 
      });
    }

    const entityType = String(entity_type).toLowerCase();
    const targetIdRaw = String(entity_id);

    // Get DB
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ 
        success: false, 
        error: "database not available" 
      });
    }

    const entityCol = db.collection(entityType);

    // Fetch entity document
    let entityRow = null;
    try {
      const q = ObjectId.isValid(targetIdRaw) 
        ? { _id: new ObjectId(targetIdRaw) } 
        : { _id: targetIdRaw };
      entityRow = await entityCol.findOne(q);
    } catch (e) {
      console.error("[tickets-upgrade] Entity lookup failed:", e);
    }

    if (!entityRow) {
      return res.status(404).json({ 
        success: false, 
        error:  "Entity not found" 
      });
    }

    // Email validation
    const storedEmail = normalizeEmail(
      entityRow.email || 
      entityRow.contactEmail || 
      entityRow.data?.email || 
      ""
    );

    const providedEmail = email ?  normalizeEmail(email) : "";

    if (!storedEmail) {
      return res.status(403).json({
        success: false,
        error: "Entity has no verified email on record. Upgrade denied.",
      });
    }

    if (providedEmail && providedEmail !== storedEmail) {
      return res.status(403).json({
        success: false,
        error: "Provided email does not match entity record.",
      });
    }

    const emailToUse = storedEmail;
    const amountNum = Number(amount || 0);

    console.log("[tickets-upgrade] Validated:", { 
      entityType, 
      targetIdRaw, 
      new_category, 
      amountNum, 
      method,
      txId,
      couponCode: couponCode || null
    });

   
    // In the PAYMENT PATH section, update the payload
if (amountNum > 0 && !txId) {
  console.log("[tickets-upgrade] Creating payment order...");

  // ✅ Fix: Properly format email and ensure it's valid
  const buyerEmail = emailToUse && emailToUse.includes('@') ? emailToUse : 'customer@example.com';
  
  const payload = {
    amount: amountNum,
    currency: "INR",
    description: `Ticket Upgrade - ${new_category}`,
    reference_id: String(entity_id),
    metadata: { 
      entity_type: entityType, 
      entity_id: targetIdRaw,
      new_category,
      couponCode: couponCode || undefined,
      buyer_name: entityRow.name || entityRow.company || 'Customer',
      email: buyerEmail
    },
    customer: { 
      email: buyerEmail,
      name: entityRow.name || entityRow.company || 'Customer'
    },
  };

  try {
    const apiUrl = `${API_BASE}/api/payment/create-order`;
    console.log("[tickets-upgrade] Calling payment API:", apiUrl);
    console.log("[tickets-upgrade] Payment payload:", JSON.stringify(payload, null, 2));

    const r = await fetch(apiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "ngrok-skip-browser-warning": "69420" 
      },
      body: JSON.stringify(payload),
    });

    const js = await r.json().catch(() => ({}));
    console.log("[tickets-upgrade] Payment response:", js);

    if (!r.ok || !js.success) {
      return res.status(502).json({ 
        success: false, 
        error: js.error || "Failed to create payment order", 
        raw: js 
      });
    }

    return res.json({ 
      success: true, 
      payment_required: true,
      checkoutUrl: js.checkoutUrl || js.checkout_url || js.raw?.checkout_url,
      order: js 
    });
  } catch (e) {
    console.error("[tickets-upgrade] Payment creation failed:", e);
    return res.status(502).json({ 
      success: false, 
      error: "Failed to create payment order: " + e.message 
    });
  }
}

    // ATOMIC: Upgrade & consume coupon
    const ticketsCol = db.collection("tickets");
    let ticketDoc = null;

    // -------- Coupon Validate & Burn (if supplied) --------
    if (couponCode) {
      const couponCol = db.collection("coupons");
      const coupon = await couponCol.findOneAndUpdate(
        { code: String(couponCode).trim().toUpperCase(), used: { $ne: true } },
        { $set: { used: true, used_at: new Date(), used_by: emailToUse || targetIdRaw } },
        { returnDocument: "after" }
      );
      if (!coupon.value) {
        return res.status(400).json({
          success: false,
          error: "Coupon invalid or already used. Please try a different code."
        });
      }
      // Log coupon use
      try {
        await db.collection("coupon_logs").insertOne({
          type: "use_on_upgrade",
          code: String(couponCode).trim().toUpperCase(),
          entity_type,
          entity_id: targetIdRaw,
          upgradedAt: new Date(),
          used_by: emailToUse || targetIdRaw
        });
      } catch {}
    }

    // -------- Upgrade logic (category/ticket update) --------
    try {
      const filter = { entity_type: entityType, entity_id: targetIdRaw };
      const existingTicket = await ticketsCol.findOne(filter);
      let ticket_code = existingTicket?.ticket_code || generateTicketCode();

      const update = {
        $set: {
          entity_type: entityType,
          entity_id: targetIdRaw,
          name: entityRow.name || entityRow.fullName || entityRow.company || null,
          email: emailToUse || null,
          company: entityRow.company || null,
          category: new_category,
          txId: txId || null,
          paymentMethod: method || "free",
          meta: { 
            upgradedFrom: "self-service", 
            upgradedAt: new Date(),
            previousCategory: entityRow.ticket_category || entityRow.category || null
          },
          updatedAt: new Date(),
        },
        $setOnInsert: { 
          createdAt: new Date(), 
          ticket_code 
        },
      };

      const result = await ticketsCol.findOneAndUpdate(
        filter, 
        update, 
        { upsert: true, returnDocument: "after" }
      );

      ticketDoc = result.value;

      if (!ticketDoc) {
        const finalCode = generateTicketCode();
        const insertRes = await ticketsCol.insertOne({
          ticket_code: finalCode,
          entity_type: entityType,
          entity_id: targetIdRaw,
          name: entityRow.name || entityRow.fullName || entityRow.company || null,
          email: emailToUse || null,
          company: entityRow.company || null,
          category: new_category,
          txId: txId || null,
          paymentMethod: method || "free",
          meta: { 
            upgradedFrom: "self-service", 
            upgradedAt: new Date(),
            previousCategory: entityRow.ticket_category || entityRow.category || null
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        ticketDoc = await ticketsCol.findOne({ _id: insertRes.insertedId });
      }
    } catch (e) {
      console.error("[tickets-upgrade] Ticket upsert failed:", e);
    }

    const finalTicketCode = ticketDoc?.ticket_code || 
      entityRow?.ticket_code || 
      entityRow?.code || 
      null;

    // Update entity with new category and ticket code
    try {
      const q = ObjectId.isValid(targetIdRaw) 
        ? { _id: new ObjectId(targetIdRaw) } 
        : { _id: targetIdRaw };

      await entityCol.updateOne(q, { 
        $set: { 
          ticket_category: new_category, 
          ticket_code: finalTicketCode,
          upgradedAt: new Date(),
          txId: txId || null,
          paymentMethod: method || null
        } 
      });

      console.log("[tickets-upgrade] Entity updated with new category and ticket code");
    } catch (e) {
      console.error("[tickets-upgrade] Entity update failed:", e);
    }

    let updatedEntity = null;
    try {
      const q = ObjectId.isValid(targetIdRaw) 
        ? { _id: new ObjectId(targetIdRaw) } 
        : { _id: targetIdRaw };
      updatedEntity = await entityCol.findOne(q);
    } catch (e) {
      console.error("[tickets-upgrade] Failed to fetch updated entity:", e);
      updatedEntity = {
        ...entityRow,
        ticket_category: new_category,
        ticket_code: finalTicketCode,
        upgradedAt: new Date()
      };
    }

    if (emailToUse && updatedEntity) {
      try {
        console.log("[tickets-upgrade] Sending complete ticket email via sendTicketEmail...");

        const emailResult = await sendTicketEmail({
          entity: entityType,
          record: updatedEntity,
          frontendBase: FRONTEND_BASE,
          options: {
            forceSend: true,
            includeBadge: true,
            includeAttendingCard: true,
            isUpgrade: true,
            previousCategory: entityRow.ticket_category || entityRow.category || null
          }
        });

        if (emailResult && emailResult.success) {
          console.log("[tickets-upgrade] ✅ Ticket email sent successfully");
          try {
            const q = ObjectId.isValid(targetIdRaw) 
              ? { _id: new ObjectId(targetIdRaw) } 
              : { _id: targetIdRaw };
            await entityCol.updateOne(q, { 
              $set: { ticket_email_sent_at: new Date(), last_email_type: 'upgrade_confirmation' },
              $unset: { ticket_email_failed: "" }
            });
          } catch {}
        } else {
          console.error("[tickets-upgrade] ❌ Ticket email failed:", emailResult?.error);
          try {
            const q = ObjectId.isValid(targetIdRaw) 
              ? { _id: new ObjectId(targetIdRaw) } 
              : { _id: targetIdRaw };
            await entityCol.updateOne(q, { 
              $set: { ticket_email_failed: true, ticket_email_failed_at: new Date() }
            });
          } catch {}
        }
      } catch (e) {
        console.error("[tickets-upgrade] Ticket email error:", e);
      }
    }

    console.log("[tickets-upgrade] ✅ Upgrade complete");

    return res.json({
      success: true,
      upgraded: true,
      entity_type: entityType,
      entity_id: targetIdRaw,
      new_category,
      ticket_code: finalTicketCode,
      ticket: ticketDoc || undefined,
      couponUsed: couponCode || undefined,
      message: "Upgrade successful! Check your email for your updated ticket with badge download link."
    });
  } catch (err) {
    console.error("[tickets-upgrade] Error:", err.stack || err);
    return res.status(500).json({ 
      success: false, 
      error: String(err.message || err) 
    });
  }
}


router.post("/upgrade", handleUpgrade);


router.post("/", handleUpgrade);

console.log("✅ tickets-upgrade.js LOADED");

module.exports = router;