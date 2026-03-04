import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import { auth, requireRole } from "../middleware/auth.js";
import { computeTotals } from "../lib/invoice.js";
import razorpay from "../lib/razorpay.js";
import crypto from "crypto";
import { createBillFromData } from "../lib/billing.js";
import { sendEmail } from "../lib/mailer.js";
import AuditLog from "../models/AuditLog.js";
import { notifyAdmin } from "../lib/socket.js";

const router = express.Router();

router.post("/", auth, requireRole("customer"), async (req, res) => {
  const { items, notes, paymentMethod } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (!["CASH", "RAZORPAY", "COD_20"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });

  const cust = await Customer.findById(req.user.id).select("name phone email isKycComplete");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });
  if (!cust.isKycComplete) return res.status(403).json({ error: "kyc_required" });

  const ids = items.map((x) => x.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  // Check stock before proceeding
  for (const it of items) {
    const p = products.find(x => x._id.toString() === it.productId);
    if (!p) return res.status(400).json({ error: "product_not_found" });
    if (p.minOrderQty && Number(p.minOrderQty) > 0 && it.quantity < Number(p.minOrderQty)) {
      return res.status(400).json({ error: `MOQ_not_met:${p.minOrderQty}` });
    }
    if (it.variantId) {
      const v = (p.variants || []).find(v => v._id.toString() === String(it.variantId));
      if (!v || (v.stock || 0) < it.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
      }
    } else if (p.stock < it.quantity) {
      return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
    }
  }

  const totals = computeTotals(products, items);
  const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
  if (totals.total < minAmount) {
    return res.status(400).json({ error: "min_order_not_met", minAmount });
  }
  const orderItems = totals.items.map((it) => {
    const p = products.find(x => x._id.toString() === it.product.toString());
    const v = it.variantId ? (p?.variants || []).find(v => v._id.toString() === String(it.variantId)) : null;
    return {
      product: it.product,
      variantId: it.variantId,
      name: it.name,
      price: it.price,
      gst: it.gst,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
      image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "")
    };
  });

  let razorpayOrder = null;
  if (paymentMethod === "RAZORPAY" || paymentMethod === "COD_20") {
    try {
      const amountPaise = paymentMethod === "COD_20"
        ? Math.round(totals.total * 0.2 * 100)
        : Math.round(totals.total * 100);
      razorpayOrder = await razorpay.orders.create({
        amount: amountPaise, // in paise
        currency: "INR",
        receipt: `receipt_${Date.now()}`
      });
    } catch (err) {
      console.error("Razorpay Order Creation Failed:", err);
      return res.status(500).json({ error: "payment_initiation_failed" });
    }
  }

  const orderStatus = paymentMethod === "CASH" ? "PENDING_CASH_APPROVAL" : "NEW";

  const doc = await Order.create({
    customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
    items: orderItems,
    totalEstimate: totals.total,
    status: orderStatus,
    paymentMethod,
    paymentStatus: "PENDING",
    razorpayOrderId: razorpayOrder?.id,
    notes: notes || "",
    codAdvancePercent: paymentMethod === "COD_20" ? 20 : 0,
    codDueAmount: paymentMethod === "COD_20" ? Number((totals.total * 0.8).toFixed(2)) : 0
  });

  if (paymentMethod === "CASH") {
    notifyAdmin("new_offline_order", doc);
  }

  try {
    const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    if (to) await sendEmail({ to, subject: `Order placed - ${process.env.COMPANY_NAME || "Click2Kart"}`, html: `<div style="font-family:ui-sans-serif"><h3>Order Received</h3><p>Order ID: ${doc._id}</p><p>Total: ₹${totals.total}</p></div>` });
  } catch {}

  res.status(201).json({
    order: doc,
    razorpayOrderId: razorpayOrder?.id
  });
});

// Verify Razorpay Payment
router.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body || {};
  
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // Re-validate stock and totals before marking paid
    try {
      const ids = order.items.map(i => i.product.toString());
      const products = await Product.find({ _id: { $in: ids }, isActive: true });
      // Stock check
      for (const it of order.items) {
        const p = products.find(x => x._id.toString() === it.product.toString());
        if (!p) return res.status(400).json({ error: "product_not_found" });
        const qty = Number(it.quantity || 0);
        if (it.variantId) {
          const v = (p.variants || []).find(v => v._id.toString() === String(it.variantId));
          if (!v || (v.stock || 0) < qty) return res.status(400).json({ error: "stock_changed" });
        } else if ((p.stock || 0) < qty) {
          return res.status(400).json({ error: "stock_changed" });
        }
      }
      // Totals check with possible new bulk pricing
      const recomputeItems = order.items.map(it => ({
        productId: it.product.toString(),
        variantId: it.variantId ? it.variantId.toString() : undefined,
        quantity: it.quantity
      }));
      const totals = computeTotals(products, recomputeItems);
      const expected = Math.round((order.paymentMethod === "COD_20" ? totals.total * 0.2 : totals.total) * 100);
      // If amount drifted vs originally computed amount stored on order
      const orderAmountPaise = Math.round((order.paymentMethod === "COD_20" ? order.totalEstimate * 0.2 : order.totalEstimate) * 100);
      if (expected !== orderAmountPaise) {
        return res.status(400).json({ error: "amount_mismatch" });
      }
    } catch (e) {
      return res.status(400).json({ error: "revalidation_failed" });
    }

    if (order.paymentMethod === "COD_20") {
      order.paymentStatus = "PARTIAL";
      order.status = "CONFIRMED";
      order.advancePaidAmount = Number((order.totalEstimate * 0.2).toFixed(2));
    } else {
      order.paymentStatus = "PAID";
      order.status = "CONFIRMED";
    }
    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    await order.save();

    // Trigger automatic billing only for full online payments
    if (order.paymentMethod === "RAZORPAY") {
    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
        paymentType: "RAZORPAY",
        existingOrderId: order._id
      });
    } catch (err) {
        console.error("Auto-billing failed after payment:", err);
      }
    }
    try {
      await AuditLog.create({ actorId: "", actorRole: "system", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Payment verified (${order.paymentMethod})` });
      const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      if (to) await sendEmail({ to, subject: `Payment confirmed - ${process.env.COMPANY_NAME || "Click2Kart"}`, html: `<div style="font-family:ui-sans-serif"><h3>Payment Confirmed</h3><p>Order ID: ${order._id}</p></div>` });
    } catch {}
    
    res.json({ success: true, message: "payment_verified" });
  } else {
    res.status(400).json({ error: "invalid_signature" });
  }
});

// Finalize COD and generate bill (admin)
router.patch("/:id/finalize-cod", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.paymentMethod !== "COD_20") return res.status(400).json({ error: "not_cod_order" });
  if (order.paymentStatus !== "PARTIAL") return res.status(400).json({ error: "advance_not_paid" });

  order.paymentStatus = "PAID";
  await order.save();

  try {
    await createBillFromData({
      customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
      items: order.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
      paymentType: "CASH",
      existingOrderId: order._id
    });
  } catch (err) {
    console.error("Billing failed after COD finalize:", err);
  }
  res.json({ success: true });
});

// Admin approves Cash Payment
router.patch("/:id/approve-cash", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.paymentMethod !== "CASH") return res.status(400).json({ error: "not_a_cash_order" });

  order.paymentStatus = "PAID";
  order.status = "CONFIRMED";
  await order.save();

  // Trigger billing
  try {
    await createBillFromData({
      customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
      items: order.items.map(it => ({ product: it.product, quantity: it.quantity })),
      paymentType: "CASH",
      existingOrderId: order._id
    });
  } catch (err) {
    console.error("Billing failed after cash approval:", err);
  }
  
  res.json({ success: true, order });
});

router.get("/my-orders", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "missing_phone" });
  const items = await Order.find({ "customer.phone": phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/my", auth, requireRole("customer"), async (req, res) => {
  const cust = await Customer.findById(req.user.id).select("phone email");
  if (!cust) return res.status(404).json({ error: "not_found" });
  const items = await Order.find({ "customer.phone": cust.phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const status = req.query.status;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const filter = {};
  if (status) filter.status = status;
  const items = await Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json({ page, limit, count: items.length, items });
});

router.get("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const doc = await Order.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "not_found" });
  res.json(doc);
});

router.patch("/:id/status", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { status } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  const allowed = new Set(["NEW", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "FULFILLED"]);
  if (!allowed.has(status)) return res.status(400).json({ error: "invalid_status" });
  const okTransitions = {
    NEW: new Set(["CONFIRMED", "CANCELLED"]),
    PENDING_CASH_APPROVAL: new Set(["CONFIRMED", "CANCELLED"]),
    CONFIRMED: new Set(["SHIPPED", "CANCELLED"]),
    SHIPPED: new Set(["DELIVERED", "RETURNED"]),
    DELIVERED: new Set(["FULFILLED", "RETURNED"]),
    CANCELLED: new Set([]),
    RETURNED: new Set([]),
    FULFILLED: new Set([])
  };
  const curr = order.status;
  if (!okTransitions[curr] || !okTransitions[curr].has(status)) return res.status(400).json({ error: "invalid_transition" });
  order.status = status;
  const updated = await order.save();
  try {
    await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: updated._id.toString(), note: `Status ${curr} → ${status}` });
  } catch {}
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

// Customer delivery feedback (rating only after order fulfilled)
router.post("/:id/feedback", auth, requireRole("customer"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const r = Number(req.body?.rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: "invalid_rating" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  const cust = await Customer.findById(req.user.id).select("phone");
  if (!cust || cust.phone !== order.customer.phone) return res.status(403).json({ error: "forbidden" });
  if (order.status !== "FULFILLED") return res.status(400).json({ error: "not_delivered" });
  order.feedbackRating = r;
  await order.save();
  res.json({ success: true, feedbackRating: r });
});

// Admin: mark as packed
router.patch("/:id/pack", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.status = "PACKED";
  await order.save();
  res.json({ success: true, order });
});

// Admin: create/update shipment (manual)
router.patch("/:id/ship", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { provider, waybill, trackingUrl } = req.body || {};
  if (!provider || !waybill) return res.status(400).json({ error: "missing_fields" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.provider = String(provider);
  order.shipping.waybill = String(waybill);
  order.shipping.trackingUrl = trackingUrl || order.shipping.trackingUrl || "";
  order.shipping.status = "SHIPPED";
  const prev = order.status;
  if (prev !== "CONFIRMED" && prev !== "SHIPPED") return res.status(400).json({ error: "invalid_transition" });
  order.status = "SHIPPED";
  await order.save();
  try {
    await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Status ${prev} → SHIPPED` });
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    if (to) await sendEmail({ to, subject: `Order shipped - ${process.env.COMPANY_NAME || "Click2Kart"}`, html: `<div style="font-family:ui-sans-serif"><h3>Shipped</h3><p>Order ID: ${order._id}</p><p>${order.shipping.provider} • ${order.shipping.waybill}</p></div>` });
  } catch {}
  res.json({ success: true, order });
});

// Admin: mark delivered and close
router.patch("/:id/deliver", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.status = "DELIVERED";
  const prev2 = order.status;
  if (prev2 !== "SHIPPED") return res.status(400).json({ error: "invalid_transition" });
  order.status = "DELIVERED";
  await order.save();
  try {
    await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Status ${prev2} → DELIVERED` });
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    if (to) await sendEmail({ to, subject: `Order delivered - ${process.env.COMPANY_NAME || "Click2Kart"}`, html: `<div style="font-family:ui-sans-serif"><h3>Delivered</h3><p>Order ID: ${order._id}</p></div>` });
  } catch {}
  res.json({ success: true, order });
});

export default router;
