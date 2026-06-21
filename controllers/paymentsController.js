const { ObjectId } = require("mongodb");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

async function obtainDb() {
  const mongo = require("../utils/mongoClient");
  if (!mongo) return null;
  if (typeof mongo.getDb === "function") {
    return await mongo.getDb();
  }
  return mongo.db || null;
}

// ✅ Helper: Generate ticket code
function generateTicketCode(length = 6, prefix = "TICK-") {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${prefix}${code}`;
}

// ✅ Helper: Normalize email
function normalizeEmail(e) {
  try {
    return (String(e || "").trim() || "").toLowerCase();
  } catch {
    return "";
  }
}

/* =========================================================
   CREATE ORDER
========================================================= */
exports.createOrder = async (req, res) => {
  try {
    const {
      amount,
      currency = "INR",
      reference_id,
      metadata = {},
      visitor_id = null,
      customer = {},
    } = req.body || {};

    if (!reference_id) {
      return res.status(400).json({
        success: false,
        error: "reference_id required",
      });
    }

    const amountNum = Number(amount || 0);
    if (amountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid amount",
      });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amountNum * 100),
      currency,
      receipt: String(reference_id),
      payment_capture: 1,
      notes: {
        ...metadata,
        reference_id: String(reference_id),
      },
    });

    // Save payment row with FULL metadata for webhook
    try {
      const db = await obtainDb();
      if (db) {
        await db.collection("payments").insertOne({
          visitor_id: visitor_id || metadata.entity_id || null,
          reference_id,
          provider: "razorpay",
          provider_order_id: order.id,
          amount: amountNum,
          currency,
          status: "created",
          metadata: {
            entity_type: metadata.entity_type || null,
            entity_id: metadata.entity_id || null,
            new_category: metadata.new_category || null,
            couponCode: metadata.couponCode || null,
            buyer_name: metadata.buyer_name || customer.name || null,
            email: metadata.email || customer.email || null,
            previousCategory: metadata.previousCategory || null,
            ...metadata,
          },
          created_at: new Date(),
          updated_at: new Date(),
        });
        console.log("[createOrder] Payment record saved:", order.id);
      }
    } catch (dbErr) {
      console.warn("[DB] save payment failed:", dbErr.message);
    }

    // Build checkout URL for frontend
    const checkoutUrl = `https://checkout.razorpay.com/v1/payment?order_id=${order.id}&key_id=${process.env.RAZORPAY_KEY_ID}`;

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      checkoutUrl: checkoutUrl,
    });
  } catch (err) {
    console.error("createOrder error:", err);
    return res.status(500).json({
      success: false,
      error: "Order creation failed",
    });
  }
};

/* =========================================================
   PAYMENT STATUS
========================================================= */
exports.status = async (req, res) => {
  try {
    const { reference_id } = req.query;
    if (!reference_id) {
      return res.status(400).json({
        success: false,
        error: "reference_id required",
      });
    }

    const db = await obtainDb();
    if (!db) {
      return res.json({
        success: true,
        status: "unknown",
      });
    }

    const payment = await db.collection("payments").findOne({
      reference_id,
    });

    return res.json({
      success: true,
      status: payment?.status || "created",
      record: payment || null,
    });
  } catch (err) {
    console.error("status error:", err);
    return res.status(500).json({
      success: false,
      error: "Status fetch failed",
    });
  }
};

/* =========================================================
   WEBHOOK - WITH UPGRADE HANDLING
========================================================= */
exports.webhookHandler = async (req, res) => {
  try {
    const body = req.body.toString();
    const signature = req.headers["x-razorpay-signature"];

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("[webhook] Invalid signature");
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    const event = JSON.parse(body);
    console.log("[webhook] Event received:", event.event);

    /* =============================================
       PAYMENT CAPTURED
    ============================================= */
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const amount = Number(payment.amount || 0) / 100;

      console.log("[webhook] Payment captured:", { orderId, paymentId, amount });

      const db = await obtainDb();
      if (!db) {
        console.error("[webhook] No database connection");
        return res.json({ success: true });
      }

      const paymentsCol = db.collection("payments");
      const existing = await paymentsCol.findOne({
        provider_order_id: orderId,
      });

      if (!existing) {
        console.error("[webhook] Payment record not found for order:", orderId);
        return res.json({ success: true });
      }

      // Update payment record
      await paymentsCol.updateOne(
        { provider_order_id: orderId },
        {
          $set: {
            provider_payment_id: paymentId,
            status: "paid",
            amount,
            payment_provider: "razorpay",
            webhook_payload: event,
            updated_at: new Date(),
            paid_at: new Date(),
          },
        },
      );

      console.log("[webhook] Payment record updated");

      const metadata = existing.metadata || payment.notes || {};
      console.log("[webhook] Metadata:", JSON.stringify(metadata, null, 2));

      // ✅ CHECK: Is this a TICKET UPGRADE?
      const isUpgrade = metadata.entity_type === "visitors" && metadata.new_category;

      if (isUpgrade) {
        console.log("[webhook] ⬆️ Processing TICKET UPGRADE");
        console.log("[webhook] Upgrade details:", {
          entityId: metadata.entity_id,
          newCategory: metadata.new_category,
          couponCode: metadata.couponCode,
        });

        try {
          const entityId = metadata.entity_id;
          const newCategory = metadata.new_category;
          const couponCode = metadata.couponCode;
          const entityType = metadata.entity_type || "visitors";
          const buyerEmail = metadata.email || null;
          const buyerName = metadata.buyer_name || null;

          if (!entityId || !newCategory) {
            console.error("[webhook] Missing entity_id or new_category in metadata");
            return res.json({ success: true });
          }

          // Get entity collection
          const entityCol = db.collection(entityType);
          const q = ObjectId.isValid(entityId)
            ? { _id: new ObjectId(entityId) }
            : { _id: entityId };

          // Fetch current entity for previous category
          const currentEntity = await entityCol.findOne(q);
          const previousCategory = currentEntity?.ticket_category || currentEntity?.category || null;

          // Update entity with new category
          await entityCol.updateOne(q, {
            $set: {
              ticket_category: newCategory,
              upgradedAt: new Date(),
              txId: paymentId,
              paymentMethod: "online",
              payment_status: "paid",
              amount_paid: amount,
              updated_at: new Date(),
            },
          });

          console.log("[webhook] ✅ Entity upgraded to:", newCategory);

          // Update/Create ticket record
          const ticketsCol = db.collection("tickets");
          const existingTicket = await ticketsCol.findOne({
            entity_type: entityType,
            entity_id: entityId,
          });

          const ticketCode = existingTicket?.ticket_code || generateTicketCode();

          await ticketsCol.updateOne(
            { entity_type: entityType, entity_id: entityId },
            {
              $set: {
                category: newCategory,
                txId: paymentId,
                paymentMethod: "online",
                amount_paid: amount,
                name: buyerName || currentEntity?.name || currentEntity?.company || null,
                email: buyerEmail || currentEntity?.email || null,
                company: currentEntity?.company || null,
                updatedAt: new Date(),
                meta: {
                  upgradedFrom: "self-service",
                  upgradedAt: new Date(),
                  previousCategory: previousCategory,
                },
              },
              $setOnInsert: {
                ticket_code: ticketCode,
                entity_type: entityType,
                entity_id: entityId,
                createdAt: new Date(),
              },
            },
            { upsert: true }
          );

          console.log("[webhook] ✅ Ticket record updated, code:", ticketCode);

          // Consume coupon if used
          if (couponCode) {
            try {
              const couponResult = await db.collection("coupons").updateOne(
                {
                  code: String(couponCode).toUpperCase().trim(),
                  used: { $ne: true },
                },
                {
                  $set: {
                    used: true,
                    used_at: new Date(),
                    used_by: buyerEmail || entityId,
                    payment_id: paymentId,
                    upgrade: true,
                  },
                }
              );

              if (couponResult.modifiedCount > 0) {
                console.log("[webhook] ✅ Coupon consumed:", couponCode);

                // Log coupon usage
                await db.collection("coupon_logs").insertOne({
                  type: "use_on_upgrade_webhook",
                  code: String(couponCode).toUpperCase().trim(),
                  entity_type: entityType,
                  entity_id: entityId,
                  payment_id: paymentId,
                  upgradedAt: new Date(),
                  used_by: buyerEmail || entityId,
                });
              } else {
                console.warn("[webhook] Coupon not found or already used:", couponCode);
              }
            } catch (couponErr) {
              console.error("[webhook] Coupon consume error:", couponErr);
            }
          }

          // Fetch updated entity for email
          const updatedEntity = await entityCol.findOne(q);

          // Send upgrade confirmation email
          if (updatedEntity && updatedEntity.email) {
            try {
              const sendTicketEmail = require("../utils/sendTicketEmail");
              console.log("[webhook] 📧 Sending UPGRADE ticket email to:", updatedEntity.email);

              const emailResult = await sendTicketEmail({
                entity: entityType,
                record: updatedEntity,
                options: {
                  forceSend: true,
                  includeBadge: true,
                  isUpgrade: true,
                  previousCategory: previousCategory,
                },
              });

              if (emailResult && emailResult.success) {
                console.log("[webhook] ✅ Upgrade email sent to:", updatedEntity.email);
                await entityCol.updateOne(q, {
                  $set: {
                    ticket_email_sent_at: new Date(),
                    last_email_type: "upgrade_confirmation",
                  },
                  $unset: { ticket_email_failed: "" },
                });
              } else {
                console.error("[webhook] ❌ Upgrade email failed:", emailResult?.error);
                await entityCol.updateOne(q, {
                  $set: {
                    ticket_email_failed: true,
                    ticket_email_failed_at: new Date(),
                  },
                });
              }
            } catch (emailErr) {
              console.error("[webhook] Upgrade email error:", emailErr);
              try {
                await entityCol.updateOne(q, {
                  $set: {
                    ticket_email_failed: true,
                    ticket_email_failed_at: new Date(),
                  },
                });
              } catch (updateErr) {
                console.error("[webhook] Failed to update email status:", updateErr);
              }
            }
          } else {
            console.log("[webhook] ⚠️ No email found for upgraded entity, skipping email");
          }

          console.log("[webhook] ✅ UPGRADE COMPLETE");
          return res.json({ success: true });
        } catch (upgradeErr) {
          console.error("[webhook] Upgrade processing failed:", upgradeErr);
          return res.status(500).json({
            success: false,
            error: "Upgrade processing failed: " + upgradeErr.message,
          });
        }
      }

      // =============================================
      // REGULAR VISITOR TICKET PURCHASE (existing flow)
      // =============================================
      console.log("[webhook] Processing REGULAR ticket purchase");

      let visitorRecord = null;
      if (existing?.visitor_id) {
        const visitorsCol = db.collection("visitors");

        const filter = ObjectId.isValid(existing.visitor_id)
          ? { _id: new ObjectId(existing.visitor_id) }
          : { ticket_code: String(existing.visitor_id) };

        // Update visitor payment status
        await visitorsCol.updateOne(filter, {
          $set: {
            payment_status: "paid",
            payment_provider: "razorpay",
            txId: paymentId,
            amount_paid: amount,
            paid_at: new Date(),
            updated_at: new Date(),
          },
        });

        // Fetch updated visitor for email
        visitorRecord = await visitorsCol.findOne(filter);
      }

      // Send ticket email with badge/QR after successful payment
      if (visitorRecord && visitorRecord.email) {
        try {
          const sendTicketEmail = require("../utils/sendTicketEmail");
          console.log("[webhook] Sending ticket email to:", visitorRecord.email);

          const result = await sendTicketEmail({
            entity: "visitors",
            record: visitorRecord,
            options: { forceSend: true, includeBadge: true },
          });

          if (result && result.success) {
            console.log("[webhook] ✅ Ticket email sent to:", visitorRecord.email);
            await db.collection("visitors").updateOne(
              { _id: visitorRecord._id },
              {
                $set: { ticket_email_sent_at: new Date() },
                $unset: { ticket_email_failed: "" },
              },
            );
          } else {
            console.error("[webhook] ❌ Ticket email failed:", result?.error);
            await db.collection("visitors").updateOne(
              { _id: visitorRecord._id },
              {
                $set: {
                  ticket_email_failed: true,
                  ticket_email_failed_at: new Date(),
                },
              },
            );
          }
        } catch (emailErr) {
          console.error("[webhook] Email send error:", emailErr);
          try {
            await db.collection("visitors").updateOne(
              { _id: visitorRecord._id },
              {
                $set: {
                  ticket_email_failed: true,
                  ticket_email_failed_at: new Date(),
                },
              },
            );
          } catch (updateErr) {
            console.error("[webhook] Failed to update email status:", updateErr);
          }
        }
      } else {
        console.log("[webhook] No visitor record or email found, skipping ticket email");
      }

      // Consume coupon if used (for regular purchases)
      if (existing?.metadata?.couponCode) {
        try {
          const couponCode = String(existing.metadata.couponCode).toUpperCase().trim();
          if (couponCode) {
            await db.collection("coupons").updateOne(
              { code: couponCode },
              {
                $set: {
                  used: true,
                  used_at: new Date(),
                  used_by: visitorRecord?.email || existing?.visitor_id || "unknown",
                  payment_id: paymentId,
                },
              },
            );
            console.log("[webhook] Coupon consumed:", couponCode);
          }
        } catch (couponErr) {
          console.error("[webhook] Coupon consume error:", couponErr);
        }
      }
    }

    /* =============================================
       PAYMENT FAILED
    ============================================= */
    if (event.event === "payment.failed") {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;

      console.log("[webhook] Payment failed for order:", orderId);

      const db = await obtainDb();
      if (db) {
        await db.collection("payments").updateOne(
          { provider_order_id: orderId },
          {
            $set: {
              status: "failed",
              webhook_payload: event,
              updated_at: new Date(),
              failed_at: new Date(),
              failure_reason: payment.error_description || "Payment failed",
            },
          },
        );
        console.log("[webhook] Payment marked as failed");
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[webhook] Fatal error:", err.stack || err);
    return res.status(500).json({
      success: false,
      error: "Webhook failed: " + err.message,
    });
  }
};