import express from "express";
import mongoose from "mongoose";
import Category from "../models/Category.js";
import { auth, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const name = (req.body?.name || "").toString().trim().toLowerCase();
  if (!name) return res.status(400).json({ error: "missing_name" });
  const exists = await Category.findOne({ name });
  if (exists) return res.status(409).json({ error: "duplicate_name" });
  const doc = await Category.create({ name, description: req.body?.description || "" });
  res.status(201).json(doc);
});

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const active = req.query.active;
  const filter = {};
  if (active === "true") filter.isActive = true;
  if (active === "false") filter.isActive = false;
  const items = await Category.find(filter).sort({ name: 1 });
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) payload.name = req.body.name.trim().toLowerCase();
  if (typeof req.body?.description === "string") payload.description = req.body.description;
  if (typeof req.body?.isActive === "boolean") payload.isActive = req.body.isActive;
  if (payload.name) {
    const dup = await Category.findOne({ name: payload.name, _id: { $ne: req.params.id } });
    if (dup) return res.status(409).json({ error: "duplicate_name" });
  }
  const updated = await Category.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const updated = await Category.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

export default router;

