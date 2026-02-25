import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Category from "../models/Category.js";
import { auth, requireRole } from "../middleware/auth.js";
import StockTxn from "../models/StockTxn.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.status(503).json({ error: "database_unavailable", items: [] });
  const query = { isActive: true };
  if (req.query.category) query.category = req.query.category.toString().toLowerCase();
  if (req.query.q) query.name = { $regex: req.query.q.toString(), $options: "i" };
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const total = await Product.countDocuments(query);
  const items = await Product.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  res.json({ page, limit, total, items });
});

router.get("/low-stock", auth, requireRole("admin"), async (req, res) => {
  const threshold = Number(req.query.threshold ?? 5);
  const t = Number.isFinite(threshold) && threshold >= 0 ? threshold : 5;
  const items = await Product.find({ isActive: true, stock: { $lte: t } }).sort({ stock: 1, updatedAt: -1 });
  res.json({ threshold: t, items });
});

router.get("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const item = await Product.findById(req.params.id);
  if (!item || !item.isActive) return res.status(404).json({ error: "not_found" });
  res.json(item);
});

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { name, price, category, images, stock, gst, description } = req.body || {};
  if (!name || price == null || stock == null) return res.status(400).json({ error: "missing_fields" });
  let categoryValue = undefined;
  if (category) {
    const catName = String(category).trim().toLowerCase();
    const cat = await Category.findOne({ name: catName, isActive: true });
    if (!cat) return res.status(400).json({ error: "category_not_found" });
    categoryValue = catName;
  }
  const imgArr = Array.isArray(images)
    ? images.map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && i.url)
    : [];
  const doc = await Product.create({
    name: String(name).trim(),
    description: description || "",
    price: Number(price),
    category: categoryValue,
    images: imgArr,
    stock: Number(stock),
    gst: gst == null ? 0 : Number(gst)
  });
  res.status(201).json(doc);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const allowed = ["name", "description", "price", "category", "images", "stock", "gst", "isActive"];
  const payload = {};
  for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
  if (payload.category != null) {
    if (payload.category === "") payload.category = undefined;
    else {
      const catName = String(payload.category).trim().toLowerCase();
      const cat = await Category.findOne({ name: catName, isActive: true });
      if (!cat) return res.status(400).json({ error: "category_not_found" });
      payload.category = catName;
    }
  }
  if (Array.isArray(payload.images)) payload.images = payload.images.map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && i.url);
  const updated = await Product.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const updated = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

router.patch("/:id/stock", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const qty = Number(req.body?.quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
  const doc = await Product.findById(req.params.id);
  if (!doc || !doc.isActive) return res.status(404).json({ error: "not_found" });
  if (doc.stock - qty < 0) return res.status(400).json({ error: "insufficient_stock" });
  const before = doc.stock;
  doc.stock -= qty;
  await doc.save();
  await StockTxn.create({ product: doc._id, type: req.body?.reason === "ADJUST" ? "ADJUST" : "SOLD", quantity: qty, before, after: doc.stock, refType: "MANUAL", note: req.body?.note || "" });
  res.json({ id: doc._id.toString(), stock: doc.stock });
});

router.get("/:id/stock-history", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const items = await StockTxn.find({ product: req.params.id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json({ page, limit, count: items.length, items });
});

 

export default router;
