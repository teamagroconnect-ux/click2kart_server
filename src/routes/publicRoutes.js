import express from "express";
import Category from "../models/Category.js";

const router = express.Router();

router.get("/categories", async (req, res) => {
  const items = await Category.find({ isActive: true }).sort({ name: 1 }).select({ name: 1, description: 1 });
  res.json(items);
});

export default router;

