import crypto from "crypto";
import razorpay from "../lib/razorpay.js";
import BusinessCreditFacility from "../models/BusinessCreditFacility.js";
import BusinessCreditTransaction from "../models/BusinessCreditTransaction.js";
import { processBusinessRepayment, getProductSettings } from "./businessCredit.service.js";

/**
 * AutoPay Mandate Registration
 * When autoPayEnabled is true and live Razorpay credentials are present,
 * creates a real recurring authorization order on Razorpay.
 * Otherwise, cleanly falls back to manual collections.
 */
export async function createAutoPayMandate({ facilityId, customerPhone, customerEmail, customerName, maxAmount }) {
  let facilityNumber = null;
  let facility = null;
  if (facilityId) {
    try {
      facility = await BusinessCreditFacility.findById(facilityId);
      if (facility) facilityNumber = facility.facilityNumber;
    } catch {
      // In standalone unit test or if facility not yet persisted
    }
  }

  let autoPayConfigured = false;
  try {
    const settings = await getProductSettings();
    autoPayConfigured = Boolean(settings?.autoPayEnabled);
  } catch {
    autoPayConfigured = false;
  }

  const isLiveKey = process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes("placeholder");
  const canCreateMandate = (autoPayConfigured || process.env.AUTOPAY_LIVE === "true") && isLiveKey && facilityId;

  if (canCreateMandate) {
    try {
      let customerId = null;
      try {
        const rzpCust = await razorpay.customers.create({
          name: customerName || "Retailer",
          contact: customerPhone || "9999999999",
          email: customerEmail || "retailer@click2kart.net",
          fail_existing: 0
        });
        customerId = rzpCust.id;
      } catch (cErr) {
        if (cErr.error?.metadata?.customer_id) {
          customerId = cErr.error.metadata.customer_id;
        }
      }

      // Create mandate authorization order (₹0 auth or ₹5 refundable auth)
      const receipt = `mnd_${String(facilityId).slice(-6)}_${Date.now()}`.slice(-40);
      const orderPayload = {
        amount: 0,
        currency: "INR",
        receipt,
        payment_capture: 1,
        notes: {
          facilityId: String(facilityId),
          facilityNumber: facilityNumber || "",
          type: "AUTOPAY_MANDATE"
        }
      };
      if (customerId) orderPayload.customer_id = customerId;

      let order;
      try {
        order = await razorpay.orders.create(orderPayload);
      } catch (zeroErr) {
        order = await razorpay.orders.create({
          ...orderPayload,
          amount: 500
        });
      }

      return {
        enabled: true,
        recurringEnabled: true,
        mandateOrder: {
          id: order.id,
          amount: order.amount,
          currency: order.currency
        },
        key: process.env.RAZORPAY_KEY_ID,
        customerId,
        facilityNumber,
        status: "INITIATED",
        message: "AutoPay mandate registration initialized. Please authorize with your bank/UPI."
      };
    } catch (orderErr) {
      console.warn("[AutoPay] Razorpay mandate creation error, falling back:", orderErr.message);
    }
  }

  // Safe fallback if not configured or pending
  return {
    enabled: false,
    recurringEnabled: false,
    mandateId: null,
    status: "PENDING_MERCHANT_ACTIVATION",
    message: "AutoPay e-Mandate registration is currently pending aggregator onboarding. Automatic recurring collections are disabled. Please use instant online payment (Razorpay) or direct bank transfer (NEFT/RTGS/IMPS).",
    facilityNumber,
    fallbackToManual: true
  };
}

// Backward-compatible alias
export const initializeAutoPayMandate = createAutoPayMandate;

/**
 * Verifies webhook signature idempotently using raw request body
 */
export function verifyRazorpayWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  try {
    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBuffer)
      .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expectedSignature, "hex"), Buffer.from(signature, "hex"));
  } catch {
    // If hex length mismatch or decode error, safely return false
    return false;
  }
}

/**
 * Handles incoming Razorpay webhook for recurring collections or payments
 * Enforces strict event and payment ID deduplication
 */
export async function handleAutoPayWebhookEvent(event) {
  const { event: eventType, payload, id: eventId } = event || {};
  if (!eventType || !payload) return { handled: false, reason: "invalid_payload" };

  if (eventType === "payment.captured") {
    const payment = payload.payment?.entity;
    const notes = payment?.notes || {};

    if (notes.facilityId && notes.type === "BUSINESS_CREDIT_REPAYMENT") {
      const paymentId = payment.id;
      const orderId = payment.order_id;
      const amountRupees = Number((payment.amount / 100).toFixed(2));

      // Event / Payment Deduplication Check
      const existingTxn = await BusinessCreditTransaction.findOne({
        $or: [
          { "paymentDetails.razorpayPaymentId": paymentId },
          { idempotencyKey: `WEBHOOK-${eventId}` },
          { idempotencyKey: `PAYMENT-${paymentId}` }
        ]
      });

      if (existingTxn) {
        console.log(`[AutoPayWebhook] ℹ️ Duplicate event/payment ignored: ${paymentId} (Event ID: ${eventId})`);
        return {
          handled: true,
          duplicate: true,
          facilityId: notes.facilityId,
          paymentId,
          message: "Payment already processed in ledger."
        };
      }

      const result = await processBusinessRepayment({
        facilityId: notes.facilityId,
        retailerId: payment.customer_id || null,
        amount: amountRupees,
        method: "RAZORPAY",
        paymentDetails: {
          razorpayPaymentId: paymentId,
          razorpayOrderId: orderId,
          webhookEventId: eventId,
          idempotencyKey: `PAYMENT-${paymentId}`,
          notes: `Webhook payment.captured confirmed (${paymentId})`
        },
        createdBy: "WEBHOOK",
        createdByName: "Razorpay Webhook"
      });

      return {
        handled: true,
        duplicate: false,
        facilityId: notes.facilityId,
        repaymentAmount: amountRupees,
        transactionId: result.transaction._id
      };
    }
  }

  return { handled: true, eventType, ignored: true };
}

// Convenient aliases for webhook and route integration
export const verifyAutoPayWebhookSignature = (rawBody, signature, secret = process.env.RAZORPAY_AUTOPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET) => {
  return verifyRazorpayWebhookSignature(rawBody, signature, secret);
};

export const createAutoPayMandateOrder = createAutoPayMandate;

