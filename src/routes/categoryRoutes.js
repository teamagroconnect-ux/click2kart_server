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
  let parent = null;
  if (req.body?.parentId) {
    if (!mongoose.isValidObjectId(req.body.parentId)) return res.status(400).json({ error: "invalid_parent" });
    parent = await Category.findById(req.body.parentId);
    if (!parent) return res.status(404).json({ error: "parent_not_found" });
  }
  const payload = {
    name,
    store: req.body?.store || "",
    section: req.body?.section || "",
    image: req.body?.image || "",
    parent: parent?._id || null
  };
  const doc = await Category.create(payload);
  res.status(201).json(doc);
});

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const active = req.query.active;
  const filter = {};
  if (active === "true") filter.isActive = true;
  if (active === "false") filter.isActive = false;
  const items = await Category.find(filter).populate("parent", "name").sort({ name: 1 });
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  // Do not allow changing name via API to preserve URL structure and consistency
  // description removed by product requirements
  if (typeof req.body?.image === "string") payload.image = req.body.image;
  if (typeof req.body?.store === "string") payload.store = req.body.store;
  if (typeof req.body?.section === "string") payload.section = req.body.section;
  if (req.body?.parentId !== undefined) {
    if (req.body.parentId === null || req.body.parentId === "") payload.parent = null;
    else {
      if (!mongoose.isValidObjectId(req.body.parentId)) return res.status(400).json({ error: "invalid_parent" });
      const parent = await Category.findById(req.body.parentId);
      if (!parent) return res.status(404).json({ error: "parent_not_found" });
      payload.parent = parent._id;
    }
  }
  if (typeof req.body?.isActive === "boolean") payload.isActive = req.body.isActive;
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
