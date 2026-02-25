import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import { auth, requireRole } from "../middleware/auth.js";
import { computeTotals } from "../lib/invoice.js";
import razorpay from "../lib/razorpay.js";
import crypto from "crypto";
import { createBillFromData } from "../lib/billing.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { customer, items, notes, paymentMethod } = req.body || {};
  if (!customer || !customer.name || !customer.phone) return res.status(400).json({ error: "missing_customer" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (!["CASH", "RAZORPAY"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });

  const ids = items.map((x) => x.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  // Check stock before proceeding
  for (const it of items) {
    const p = products.find(x => x._id.toString() === it.productId);
    if (!p || p.stock < it.quantity) {
      return res.status(400).json({ error: `Insufficient stock for ${p?.name || 'unknown product'}` });
    }
  }

  const totals = computeTotals(products, items);
  const orderItems = totals.items.map((it) => {
    const p = products.find(x => x._id.toString() === it.product.toString());
    return {
      product: it.product,
      name: it.name,
      price: it.price,
      gst: it.gst,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
      image: p?.images?.[0]?.url || ""
    };
  });

  let razorpayOrder = null;
  if (paymentMethod === "RAZORPAY") {
    try {
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(totals.total * 100), // in paise
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
    customer: { name: customer.name, phone: customer.phone, email: customer.email || "" },
    items: orderItems,
    totalEstimate: totals.total,
    status: orderStatus,
    paymentMethod,
    paymentStatus: "PENDING",
    razorpayOrderId: razorpayOrder?.id,
    notes: notes || ""
  });

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

    order.paymentStatus = "PAID";
    order.status = "CONFIRMED";
    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    await order.save();

    // Trigger automatic billing
    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, quantity: it.quantity })),
        paymentType: "RAZORPAY",
        existingOrderId: order._id
      });
    } catch (err) {
      console.error("Auto-billing failed after payment:", err);
    }
    
    res.json({ success: true, message: "payment_verified" });
  } else {
    res.status(400).json({ error: "invalid_signature" });
  }
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
  const allowed = new Set(["NEW", "CONFIRMED", "CANCELLED", "FULFILLED"]);
  if (!allowed.has(status)) return res.status(400).json({ error: "invalid_status" });
  const updated = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

export default router;

