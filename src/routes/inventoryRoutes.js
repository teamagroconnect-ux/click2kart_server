import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import StockTxn from "../models/StockTxn.js";
import AuditLog from "../models/AuditLog.js";

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
  try {
    await AuditLog.create({
      actorId: req.user?.id || "",
      actorRole: req.user?.role || "",
      type: "STOCK",
      entityType: "PRODUCT",
      entityId: doc._id.toString(),
      note: `Stock IN +${qty} ${note || ""}`,
      before: { stock: before },
      after: { stock: doc.stock }
    });
  } catch {}
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
    .populate("product", "name store section");
  const out = items.map((x) => ({
    id: x._id.toString(),
    productId: x.product?._id?.toString?.() || "",
    productName: x.product?.name || "",
    store: x.product?.store || "",
    section: x.product?.section || "",
    quantity: x.quantity,
    note: x.note || "",
    before: x.before,
    after: x.after,
    createdAt: x.createdAt
  }));
  res.json({ page, limit, count: out.length, items: out });
});

// Summary analytics
router.get("/summary", auth, requireRole("admin"), async (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  const dailyAgg = await StockTxn.aggregate([
    { $match: { type: "ADDED", createdAt: { $gte: from } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, qty: { $sum: "$quantity" } } },
    { $sort: { _id: 1 } }
  ]);
  const byProduct = await StockTxn.aggregate([
    { $match: { type: "ADDED", createdAt: { $gte: from } } },
    { $group: { _id: "$product", qty: { $sum: "$quantity" } } },
    { $sort: { qty: -1 } },
    { $limit: 10 }
  ]);
  const ids = byProduct.map(x => x._id).filter(Boolean);
  const prodDocs = ids.length ? await Product.find({ _id: { $in: ids } }).select("name") : [];
  const nameMap = new Map(prodDocs.map(p => [p._id.toString(), p.name]));
  const topProducts = byProduct.map(x => ({ productId: x._id?.toString?.() || "", name: nameMap.get(x._id?.toString?.() || "") || "", quantity: x.qty || 0 }));
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
  const lowStockDocs = await Product.find({ isActive: true, stock: { $lte: threshold } }).select("name stock").sort({ stock: 1 }).limit(10);
  const skuCount = await Product.countDocuments({ isActive: true });
  const inv = await Product.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, units: { $sum: "$stock" } } }]);
  const totalUnits = inv[0]?.units || 0;
  const totalAdded = dailyAgg.reduce((s, d) => s + (d.qty || 0), 0);
  const daysList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const rec = dailyAgg.find(x => x._id === key);
    daysList.push({ date: key, quantity: rec?.qty || 0 });
  }
  res.json({
    kpis: { totalSkus: skuCount, totalUnits, lowStockCount: lowStockDocs.length, totalAdded30d: totalAdded },
    daily: daysList,
    topProducts,
    lowStock: lowStockDocs.map(p => ({ id: p._id.toString(), name: p.name, stock: p.stock }))
  });
});

export default router;

// Overview: total, reserved, available per product
router.get("/overview", auth, requireRole("admin"), async (req, res) => {
  const reservedAgg = await Order.aggregate([
    { $match: { status: { $in: ["NEW", "PENDING_CASH_APPROVAL", "CONFIRMED"] } } },
    { $unwind: "$items" },
    { $group: { _id: "$items.product", reserved: { $sum: "$items.quantity" } } }
  ]);
  const reservedMap = new Map(reservedAgg.map(x => [String(x._id), x.reserved || 0]));
  const prods = await Product.find({ isActive: true }).select("name stock");
  const items = prods.map(p => {
    const reserved = reservedMap.get(p._id.toString()) || 0;
    const available = Math.max(0, (p.stock || 0) - reserved);
    return { id: p._id.toString(), name: p.name, total: p.stock || 0, reserved, available, low: available < 10 };
  }).sort((a, b) => a.available - b.available);
  res.json({ items });
});
