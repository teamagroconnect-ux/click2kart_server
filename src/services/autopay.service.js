import crypto from "crypto";
import razorpay from "../lib/razorpay.js";
import BusinessCreditFacility from "../models/BusinessCreditFacility.js";
import BusinessCreditTransaction from "../models/BusinessCreditTransaction.js";
import { processBusinessRepayment } from "./businessCredit.service.js";

/**
 * AutoPay Mandate Registration
 * Note: Recurring auto-debits via e-Mandate/eNACH/UPI Autopay require
 * verified merchant registration and NPCI customer mandate approval.
 * Standard Razorpay order IDs are NEVER treated as mandate IDs.
 * Until full banking partner integration is active, AutoPay is kept unavailable/pending
 * and manual online gateway and direct bank-transfer repayments remain active.
 */
export async function createAutoPayMandate({ facilityId, customerPhone, customerEmail, customerName, maxAmount }) {
  let facilityNumber = null;
  if (facilityId) {
    try {
      const facility = await BusinessCreditFacility.findById(facilityId);
      if (facility) facilityNumber = facility.facilityNumber;
    } catch {
      // In standalone unit test or if facility not yet persisted
    }
  }

  // Keep mandate status as NOT_REGISTERED or PENDING without assigning a standard order ID
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

