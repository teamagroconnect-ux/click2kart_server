import Order from "../models/Order.js";
import CreditRepayment from "../models/CreditRepayment.js";
import razorpay from "../lib/razorpay.js";
import { confirmOrderPayment } from "./orderPayment.service.js";
import { processSuccessfulRepayment } from "./credit.service.js";

/**
 * Reconciles pending orders and repayments against Razorpay
 */
export async function runReconciliation() {
  const results = {
    ordersChecked: 0,
    ordersReconciled: 0,
    repaymentsChecked: 0,
    repaymentsReconciled: 0,
    errors: []
  };

  const cutoff = new Date(Date.now() - 5 * 60 * 1000); // older than 5 minutes
  const maxAge = new Date(Date.now() - 72 * 60 * 60 * 1000); // up to 3 days old

  // 1. Reconcile Orders
  try {
    const pendingOrders = await Order.find({
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      razorpayOrderId: { $exists: true, $ne: "" },
      createdAt: { $gte: maxAge, $lte: cutoff }
    }).limit(50);

    results.ordersChecked = pendingOrders.length;

    for (const order of pendingOrders) {
      try {
        const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId);
        const captured = (payments?.items || []).find(p => p.status === "captured");
        if (captured) {
          console.log(`[Reconciliation] Order #${order._id} was captured on Razorpay (${captured.id}). Reconciling...`);
          await confirmOrderPayment({
            razorpayOrderId: order.razorpayOrderId,
            paymentId: captured.id,
            source: "RECONCILIATION"
          });
          results.ordersReconciled++;
        }
      } catch (err) {
        console.error(`[Reconciliation] Error checking order #${order._id}:`, err?.message || err);
        results.errors.push({ orderId: order._id, error: err?.message });
      }
    }
  } catch (err) {
    console.error("[Reconciliation] Failed to query pending orders:", err);
  }

  // 2. Reconcile Credit Repayments
  try {
    const pendingRepayments = await CreditRepayment.find({
      status: "PAYMENT_PENDING",
      method: "RAZORPAY",
      razorpayOrderId: { $exists: true, $ne: "" },
      createdAt: { $gte: maxAge, $lte: cutoff }
    }).limit(50);

    results.repaymentsChecked = pendingRepayments.length;

    for (const rep of pendingRepayments) {
      try {
        const payments = await razorpay.orders.fetchPayments(rep.razorpayOrderId);
        const captured = (payments?.items || []).find(p => p.status === "captured");
        if (captured) {
          console.log(`[Reconciliation] Repayment #${rep._id} was captured on Razorpay (${captured.id}). Reconciling...`);
          await processSuccessfulRepayment({
            razorpayOrderId: rep.razorpayOrderId,
            paymentId: captured.id,
            source: "RECONCILIATION"
          });
          results.repaymentsReconciled++;
        }
      } catch (err) {
        console.error(`[Reconciliation] Error checking repayment #${rep._id}:`, err?.message || err);
        results.errors.push({ repaymentId: rep._id, error: err?.message });
      }
    }
  } catch (err) {
    console.error("[Reconciliation] Failed to query pending repayments:", err);
  }

  return results;
}
