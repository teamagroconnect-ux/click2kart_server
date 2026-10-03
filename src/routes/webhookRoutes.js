import express from "express";
import crypto from "crypto";
import { confirmOrderPayment } from "../services/orderPayment.service.js";
import { processSuccessfulRepayment } from "../services/credit.service.js";

const router = express.Router();

router.post("/razorpay", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("RAZORPAY_WEBHOOK_SECRET is not configured");
    return res.status(500).json({ error: "missing_webhook_secret" });
  }

  // Use rawBody captured before JSON parsing, or body buffer
  const rawBuffer = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)));

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBuffer)
    .digest("hex");

  if (expected !== signature) {
    console.error("Razorpay webhook signature mismatch");
    return res.status(400).json({ error: "invalid_signature" });
  }

  try {
    const payload = typeof req.body === "object" && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBuffer.toString("utf8"));

    const event = payload?.event;
    console.log(`[Razorpay Webhook] Received event: ${event}`);

    if (event === "order.paid" || event === "payment.captured") {
      const razorpayOrderId = payload?.payload?.payment?.entity?.order_id || payload?.payload?.order?.entity?.id;
      const paymentId = payload?.payload?.payment?.entity?.id;

      if (razorpayOrderId) {
        // 1. Check & confirm standard Order
        try {
          await confirmOrderPayment({
            razorpayOrderId,
            paymentId,
            source: "WEBHOOK"
          });
        } catch (err) {
          console.error("[Razorpay Webhook] Error confirming order:", err);
        }

        // 2. Check & process Credit Repayment
        try {
          await processSuccessfulRepayment({
            razorpayOrderId,
            paymentId,
            source: "WEBHOOK"
          });
        } catch (err) {
          // May not be a credit repayment; ignore not_found error
        }
      }
    }
  } catch (err) {
    console.error("[Razorpay Webhook] Error processing payload:", err);
    return res.status(400).json({ error: "invalid_payload" });
  }

  res.json({ received: true });
});

export default router;
