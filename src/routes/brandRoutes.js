import express from "express";
import mongoose from "mongoose";
import Brand from "../models/Brand.js";
import Admin from "../models/Admin.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import { getOrSetCache, delCache, bumpCacheVersion } from "../lib/redis.js";

const router = express.Router();

router.post("/", auth, requirePermission("products"), async (req, res) => {
  const { name, slug, logo, isFeatured } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: "missing_fields" });
  
  const exists = await Brand.findOne({ $or: [{ name }, { slug }] });
  if (exists) return res.status(409).json({ error: "duplicate_brand" });
  
  const doc = await Brand.create({ name, slug, logo, isFeatured });
  await delCache("brands:all");
  await delCache("brands:featured");
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.status(201).json(doc);
});

router.get("/featured", async (req, res) => {
  const cacheKey = "brands:featured";
  const items = await getOrSetCache(cacheKey, async () => {
    return await Brand.find({ isActive: true, isFeatured: true }).sort({ name: 1 });
  }, 86400); // 24 hours
  res.json(items);
});

router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.active === "true") filter.isActive = true;
  
  const cacheKey = `brands:all:${req.query.active === "true"}`;
  const items = await getOrSetCache(cacheKey, async () => {
    return await Brand.find(filter).sort({ name: 1 });
  }, 86400); // 24 hours
  
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { name, slug, logo, isActive, isFeatured } = req.body || {};
  const payload = {};
  if (name) payload.name = name;
  if (slug) payload.slug = slug;
  if (logo !== undefined) payload.logo = logo;
  if (isActive !== undefined) payload.isActive = isActive;
  if (isFeatured !== undefined) payload.isFeatured = isFeatured;
  
  const updated = await Brand.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  await delCache("brands:all:*");
  await delCache("brands:featured");
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  // Verify deletion password
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Deletion password required" });
  }
  const admin = await Admin.findById(req.user.id);
  if (!admin) return res.status(404).json({ error: "Admin not found" });
  const isValid = await admin.compareDeletionPassword(password);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid deletion password" });
  }
  
  const updated = await Brand.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  await delCache("brands:all:*");
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.json({ success: true });
});

export default router;
