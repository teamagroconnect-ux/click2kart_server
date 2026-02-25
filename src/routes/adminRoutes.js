import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Bill from "../models/Bill.js";

const router = express.Router();

router.get("/stats", auth, requireRole("admin"), async (req, res) => {
  const [totalProducts, totalCustomers, totalBills, lowStock] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: true }),
    Bill.countDocuments({}),
    Product.find({ isActive: true, stock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD ?? 5) } })
      .sort({ stock: 1 })
      .limit(10)
  ]);
  res.json({ totalProducts, totalCustomers, totalBills, lowStock });
});

export default router;

