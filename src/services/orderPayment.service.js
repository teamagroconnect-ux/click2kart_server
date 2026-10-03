import Order from "../models/Order.js";
import AuditLog from "../models/AuditLog.js";
import { createBillFromData } from "../lib/billing.js";
import { sendEmail, renderMail } from "../lib/mailer.js";
import { tryCreateDelhiveryShipment } from "./delhivery.service.js";

/**
 * Idempotently confirms an order payment
 * Callable from Razorpay webhook, frontend verification callback, or reconciliation scheduler
 */
export async function confirmOrderPayment({ razorpayOrderId, orderId, paymentId, paymentSignature, source = "WEBHOOK" }) {
  const query = razorpayOrderId ? { razorpayOrderId } : { _id: orderId };
  const order = await Order.findOne(query);

  if (!order) {
    console.warn(`[confirmOrderPayment] Order not found for query:`, query);
    return null;
  }

  // Idempotency check: if order is already confirmed / paid, return immediately
  if (order.status === "CONFIRMED" || order.paymentStatus === "PAID" || (order.paymentMethod === "COD_20" && order.paymentStatus === "PARTIAL")) {
    return { order, alreadyConfirmed: true };
  }

  const prevStatus = order.status;
  const isCod20 = order.paymentMethod === "COD_20";

  order.status = "CONFIRMED";
  order.paymentStatus = isCod20 ? "PARTIAL" : "PAID";
  if (paymentId) order.razorpayPaymentId = paymentId;
  if (paymentSignature) order.razorpaySignature = paymentSignature;
  if (isCod20) {
    order.advancePaidAmount = Math.round(order.totalEstimate * 0.2);
  }

  await order.save();

  // 1. Auto Billing for full online payments
  if (order.paymentMethod === "RAZORPAY") {
    try {
      await createBillFromData({
        customerData: {
          phone: order.customer.phone,
          name: order.customer.name,
          email: order.customer.email
        },
        items: order.items.map(it => ({
          product: it.product,
          variantSku: it.variantSku ? String(it.variantSku) : undefined,
          quantity: it.quantity
        })),
        paymentType: "RAZORPAY",
        existingOrderId: order._id
      });
    } catch (err) {
      console.error("[confirmOrderPayment] Auto-billing failed:", err?.message || err);
    }
  }

  // 2. Email confirmation
  try {
    const to = order.customer.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const paidText = isCod20
      ? `Advance Paid (20%): ₹${Number(order.totalEstimate * 0.2).toLocaleString("en-IN")}`
      : `Amount Paid: ₹${Number(order.totalEstimate).toLocaleString("en-IN")}`;

    const html = renderMail({
      heading: "Payment Confirmed",
      subheading: "We’ve confirmed your payment and are preparing your shipment.",
      highlight: `Order ID: ${order._id}`,
      blocks: [
        { label: "Payment Method", value: order.paymentMethod },
        { label: "Payment", value: paidText },
        { label: "Delivery Channel", value: order.deliveryChannel === "LOCAL_DELIVERY" ? "Local Delivery" : "Delhivery Express" },
        { label: "Current Status", value: order.status }
      ]
    });

    if (to) {
      await sendEmail({
        to,
        subject: `Payment confirmed - ${process.env.COMPANY_NAME || "Click2Kart"}`,
        html
      });
    }
  } catch (err) {
    console.error("[confirmOrderPayment] Email sending failed:", err?.message || err);
  }

  // 3. Shipment: only create Delhivery shipment if deliveryChannel is DELHIVERY
  if (order.deliveryChannel === "DELHIVERY") {
    try {
      await tryCreateDelhiveryShipment(order);
    } catch (err) {
      console.error("[confirmOrderPayment] Auto Delhivery shipment failed:", err?.message || err);
    }
  } else {
    console.log(`[confirmOrderPayment] Order #${order._id} is marked as LOCAL_DELIVERY. Awaiting admin fulfillment.`);
  }

  // 4. Audit Log
  try {
    await AuditLog.create({
      actorId: order.customer.phone || "SYSTEM",
      actorRole: "customer",
      type: "ORDER_PAYMENT_CONFIRMED",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Payment confirmed via ${source}. Payment ID: ${paymentId || 'N/A'}. Method: ${order.paymentMethod}`,
      before: { status: prevStatus, paymentStatus: "PENDING" },
      after: { status: order.status, paymentStatus: order.paymentStatus }
    });
  } catch (err) {
    console.error("[confirmOrderPayment] Audit log error:", err);
  }

  return { order, confirmed: true };
}
