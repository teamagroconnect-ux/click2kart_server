import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Category from "../models/Category.js";
import { auth, requireRole } from "../middleware/auth.js";
import StockTxn from "../models/StockTxn.js";
import Bill from "../models/Bill.js";
import Review from "../models/Review.js";
import jwt from "jsonwebtoken";

const router = express.Router();

const isViewerAuthorized = (req) => {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");
    if (type === "Bearer" && token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      return !!payload;
    }
  } catch {}
  return false;
};

const withDerived = (p) => {
  const obj = p.toObject ? p.toObject() : { ...p };
  if (obj.mrp != null && obj.price != null && obj.mrp > obj.price) {
    obj.discountPercent = Math.round(((Number(obj.mrp) - Number(obj.price)) / Number(obj.mrp)) * 100);
  }
  return obj;
};

const sanitizeProduct = (p, canViewPrice) => {
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

router.get("/", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.status(503).json({ error: "database_unavailable", items: [] });
  const query = { isActive: true };
  if (req.query.category) query.category = req.query.category.toString().toLowerCase();
  if (req.query.subcategory) query.subcategory = req.query.subcategory.toString().toLowerCase();
  const q = req.query.q ? String(req.query.q).trim() : "";
  if (q && q.length < 2) query.name = { $regex: q, $options: "i" };
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const useText = q && q.length >= 2;
  if (useText) query.$text = { $search: q };
  const total = await Product.countDocuments(query);
  let cursor = Product.find(query);
  if (useText) cursor = cursor.select({ score: { $meta: "textScore" } }).sort({ score: { $meta: "textScore" }, createdAt: -1 });
  else cursor = cursor.sort({ createdAt: -1 });
  const items = await cursor.skip((page - 1) * limit).limit(limit);
  const canViewPrice = isViewerAuthorized(req);
  const safeItems = items.map((it) => sanitizeProduct(it, canViewPrice));
  res.json({ page, limit, total, items: safeItems });
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
  const canViewPrice = isViewerAuthorized(req);
  res.json(sanitizeProduct(item, canViewPrice));
});

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { name, price, category, subcategory, images, stock, gst, description, bulkDiscountQuantity, bulkDiscountPriceReduction, mrp } = req.body || {};
  if (!name || price == null || stock == null) return res.status(400).json({ error: "missing_fields" });
  let categoryValue = undefined;
  if (category) {
    const catName = String(category).trim().toLowerCase();
    const cat = await Category.findOne({ name: catName, isActive: true });
    if (!cat) return res.status(400).json({ error: "category_not_found" });
    categoryValue = catName;
  }
  let subcategoryValue = undefined;
  if (subcategory) {
    const subName = String(subcategory).trim().toLowerCase();
    const sub = await Category.findOne({ name: subName, isActive: true });
    if (!sub) return res.status(400).json({ error: "subcategory_not_found" });
    subcategoryValue = subName;
  }
  const imgArr = Array.isArray(images)
    ? images.map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && i.url)
    : [];
  const doc = await Product.create({
    name: String(name).trim(),
    description: description || "",
    price: Number(price),
    category: categoryValue,
    subcategory: subcategoryValue,
    images: imgArr,
    stock: Number(stock),
    gst: gst == null ? 0 : Number(gst),
    mrp: mrp == null || mrp === "" ? undefined : Number(mrp),
    bulkDiscountQuantity: Number(bulkDiscountQuantity || 0),
    bulkDiscountPriceReduction: Number(bulkDiscountPriceReduction || 0)
  });
  res.status(201).json(doc);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const allowed = ["name", "description", "price", "category", "subcategory", "images", "stock", "gst", "mrp", "isActive", "bulkDiscountQuantity", "bulkDiscountPriceReduction"];
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
  if (payload.subcategory != null) {
    if (payload.subcategory === "") payload.subcategory = undefined;
    else {
      const subName = String(payload.subcategory).trim().toLowerCase();
      const sub = await Category.findOne({ name: subName, isActive: true });
      if (!sub) return res.status(400).json({ error: "subcategory_not_found" });
      payload.subcategory = subName;
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

router.get("/suggest", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.json([]);
  const q = req.query.q ? String(req.query.q).trim() : "";
  if (!q) return res.json([]);
  const base = { isActive: true };
  let items = [];
  if (q.length >= 2) {
    items = await Product.find({ ...base, $text: { $search: q } })
      .select({ name: 1, category: 1, images: 1, score: { $meta: "textScore" } })
      .sort({ score: { $meta: "textScore" } })
      .limit(8);
  } else {
    items = await Product.find({ ...base, name: { $regex: q, $options: "i" } })
      .select({ name: 1, category: 1, images: 1 })
      .sort({ createdAt: -1 })
      .limit(8);
  }
  const out = items.map((d) => ({
    id: d._id.toString(),
    name: d.name,
    category: d.category,
    image: d.images?.[0]?.url || ""
  }));
  res.json(out);
});
router.post("/:id/reviews", auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { rating, comment } = req.body || {};
  const r = Number(rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: "invalid_rating" });
  const product = await Product.findById(req.params.id);
  if (!product || !product.isActive) return res.status(404).json({ error: "not_found" });
  const eligible = await Bill.exists({ customer: req.user?.id, "items.product": product._id });
  if (!eligible) return res.status(403).json({ error: "not_eligible" });
  await Review.findOneAndUpdate(
    { product: product._id, customer: req.user.id },
    { rating: r, comment: comment || "" },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const agg = await Review.aggregate([
    { $match: { product: product._id } },
    { $group: { _id: "$product", count: { $sum: 1 }, avg: { $avg: "$rating" } } }
  ]);
  const summary = agg[0] || { count: 0, avg: 0 };
  await Product.updateOne({ _id: product._id }, { ratingAvg: Number(summary.avg || 0).toFixed ? Number(summary.avg.toFixed(2)) : Number(summary.avg || 0), ratingCount: summary.count || 0 });
  const updated = await Product.findById(product._id).select({ ratingAvg: 1, ratingCount: 1 });
  res.status(201).json({ ratingAvg: updated.ratingAvg || 0, ratingCount: updated.ratingCount || 0 });
});

export default router;
