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
      notes: metadata || {},
    });

    // Save payment row
    try {
      const db = await obtainDb();
      if (db) {
        await db.collection("payments").insertOne({
          visitor_id,
          reference_id,
          provider: "razorpay",
          provider_order_id: order.id,
          amount: amountNum,
          currency,
          status: "created",
          metadata,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    } catch (dbErr) {
      console.warn("[DB] save payment failed:", dbErr.message);
    }

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
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
   WEBHOOK - WITH AUTO TICKET EMAIL
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
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    const event = JSON.parse(body);

    /* PAYMENT CAPTURED */
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const amount = Number(payment.amount || 0) / 100;

      const db = await obtainDb();
      if (!db) {
        return res.json({ success: true });
      }

      const paymentsCol = db.collection("payments");
      const existing = await paymentsCol.findOne({
        provider_order_id: orderId,
      });

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

      // Update visitor and send ticket email
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

      // ✅ SEND TICKET EMAIL WITH BADGE/QR AFTER SUCCESSFUL PAYMENT
      if (visitorRecord && visitorRecord.email) {
        try {
          const sendTicketEmail = require("../utils/sendTicketEmail");
          console.log(
            "[webhook] Sending ticket email to:",
            visitorRecord.email,
          );

          const result = await sendTicketEmail({
            entity: "visitors",
            record: visitorRecord,
            options: { forceSend: true, includeBadge: true },
          });

          if (result && result.success) {
            console.log(
              "[webhook] ✅ Ticket email sent to:",
              visitorRecord.email,
            );
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
            console.error(
              "[webhook] Failed to update email status:",
              updateErr,
            );
          }
        }
      } else {
        console.log(
          "[webhook] No visitor record or email found, skipping ticket email",
        );
      }

      // ✅ CONSUME COUPON IF USED
      if (existing?.metadata?.couponCode) {
        try {
          const couponCode = String(existing.metadata.couponCode)
            .toUpperCase()
            .trim();
          if (couponCode) {
            await db.collection("coupons").updateOne(
              { code: couponCode },
              {
                $set: {
                  used: true,
                  used_at: new Date(),
                  used_by:
                    visitorRecord?.email || existing?.visitor_id || "unknown",
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

    // Handle payment failure
    if (event.event === "payment.failed") {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;

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
            },
          },
        );
        console.log("[webhook] Payment failed for order:", orderId);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(500).json({
      success: false,
      error: "Webhook failed",
    });
  }
};
