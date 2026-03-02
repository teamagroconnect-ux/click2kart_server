import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Product from "../models/Product.js";
import StockTxn from "../models/StockTxn.js";

const router = express.Router();

// Stock IN: increase product stock and log entry
router.post("/in", auth, requireRole("admin"), async (req, res) => {
  const { productId, quantity, note } = req.body || {};
  if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ error: "invalid_product" });
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
  const doc = await Product.findById(productId);
  if (!doc || !doc.isActive) return res.status(404).json({ error: "not_found" });
  const before = doc.stock || 0;
  doc.stock = before + qty;
  await doc.save();
  await StockTxn.create({
    product: doc._id,
    type: "ADDED",
    quantity: qty,
    before,
    after: doc.stock,
    refType: "MANUAL",
    note: note || ""
  });
  res.status(201).json({ productId: doc._id.toString(), before, added: qty, after: doc.stock });
});

// History: list recent stock-in records
router.get("/history", auth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const items = await StockTxn.find({ type: "ADDED" })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("product", "name");
  const out = items.map((x) => ({
    id: x._id.toString(),
    productId: x.product?._id?.toString?.() || "",
    productName: x.product?.name || "",
    quantity: x.quantity,
    note: x.note || "",
    before: x.before,
    after: x.after,
    createdAt: x.createdAt
  }));
  res.json({ page, limit, count: out.length, items: out });
});

export default router;
