import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import Customer from "../models/Customer.js";
import { auth, requireRole } from "../middleware/auth.js";

const router = express.Router();

const withDerived = (p) => {
  const obj = p.toObject ? p.toObject() : { ...p };
  if (obj.mrp != null && obj.price != null && obj.mrp > obj.price) {
    obj.discountPercent = Math.round(((Number(obj.mrp) - Number(obj.price)) / Number(obj.mrp)) * 100);
  }
  return obj;
};

const sanitizeForViewer = (p, canViewPrice) => {
  let obj = withDerived(p);
  if (canViewPrice) return obj;
  delete obj.price;
  delete obj.gst;
  delete obj.mrp;
  delete obj.discountPercent;
  delete obj.bulkDiscountQuantity;
  delete obj.bulkDiscountPriceReduction;
  return obj;
};

// Reorder suggestions for logged-in customer
router.get("/reorder", auth, requireRole("customer"), async (req, res) => {
  const cust = await Customer.findById(req.user.id).select("phone");
  if (!cust) return res.status(404).json({ error: "not_found" });
  const orders = await Order.find({ "customer.phone": cust.phone }).select({ items: 1 }).limit(100).sort({ createdAt: -1 });
  const counts = new Map();
  for (const o of orders) {
    for (const it of o.items || []) {
      const id = it.product?.toString?.() || String(it.product);
      counts.set(id, (counts.get(id) || 0) + (Number(it.quantity) || 1));
    }
  }
  const sortedIds = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 12);
  const docs = await Product.find({ _id: { $in: sortedIds }, isActive: true });
  const docMap = new Map(docs.map(d => [d._id.toString(), d]));
  const ordered = sortedIds.map(id => docMap.get(id)).filter(Boolean);
  res.json(ordered.map(d => sanitizeForViewer(d, true)));
});

// Frequently bought together based on co-occurrence in Orders
router.get("/frequently-bought/:productId", async (req, res) => {
  const pid = req.params.productId;
  if (!mongoose.isValidObjectId(pid)) return res.status(400).json({ error: "invalid_id" });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 8));
  const agg = await Order.aggregate([
    { $match: { "items.product": new mongoose.Types.ObjectId(pid) } },
    { $project: { items: 1 } },
    { $unwind: "$items" },
    { $match: { "items.product": { $ne: new mongoose.Types.ObjectId(pid) } } },
    { $group: { _id: "$items.product", count: { $sum: "$items.quantity" } } },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]);
  const ids = agg.map(a => a._id);
  const docs = await Product.find({ _id: { $in: ids }, isActive: true });
  res.json(docs.map(d => sanitizeForViewer(d, false)));
});

export default router;
