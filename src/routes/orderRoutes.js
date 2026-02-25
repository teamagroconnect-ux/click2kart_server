import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import { auth, requireRole } from "../middleware/auth.js";
import { computeTotals } from "../lib/invoice.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { customer, items, notes } = req.body || {};
  if (!customer || !customer.name || !customer.phone) return res.status(400).json({ error: "missing_customer" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  const ids = items.map((x) => x.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });
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
  const doc = await Order.create({
    customer: { name: customer.name, phone: customer.phone, email: customer.email || "" },
    items: orderItems,
    totalEstimate: totals.total,
    status: "NEW",
    notes: notes || ""
  });
  res.status(201).json(doc);
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

