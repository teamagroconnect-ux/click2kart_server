import express from "express";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Bill from "../models/Bill.js";
import { sendEmail } from "../lib/mailer.js";

import Admin from "../models/Admin.js";

const router = express.Router();

// Get all staff members
router.get("/staff", auth, requireRole("admin"), async (req, res) => {
  const staff = await Admin.find({ role: "staff" }).select("-password");
  res.json(staff);
});

// Create new staff
router.post("/staff", auth, requireRole("admin"), async (req, res) => {
  const { name, email, password, permissions } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "missing_fields" });
  
  const exists = await Admin.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(400).json({ error: "email_exists" });

  const staff = await Admin.create({
    name,
    email: email.toLowerCase(),
    password,
    role: "staff",
    permissions: permissions || [],
    isActive: true
  });

  const staffObj = staff.toObject();
  delete staffObj.password;
  res.status(201).json(staffObj);
});

// Update staff permissions/status
router.put("/staff/:id", auth, requireRole("admin"), async (req, res) => {
  const { name, permissions, isActive, password } = req.body || {};
  const staff = await Admin.findById(req.params.id);
  if (!staff) return res.status(404).json({ error: "not_found" });

  if (name) staff.name = name;
  if (permissions) staff.permissions = permissions;
  if (isActive !== undefined) staff.isActive = isActive;
  if (password) staff.password = password;

  await staff.save();
  const staffObj = staff.toObject();
  delete staffObj.password;
  res.json(staffObj);
});

// Delete staff
router.delete("/staff/:id", auth, requireRole("admin"), async (req, res) => {
  await Admin.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

router.get("/stats", auth, async (req, res) => {
  // Staff can also see basic stats, but maybe filtered based on permissions in the future
  // For now, let both admin and staff access this route if authenticated
  const Order = (await import("../models/Order.js")).default;
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
  const [totalProducts, totalCustomers, pendingCustomers, totalBills, lowStockProducts, newOrders, pendingCash] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: false }),
    Bill.countDocuments({}),
    Product.find({ 
      isActive: true, 
      $or: [
        { variants: { $exists: true, $not: { $size: 0 } }, "variants.stock": { $lte: threshold } },
        { variants: { $exists: false }, stock: { $lte: threshold } },
        { variants: { $size: 0 }, stock: { $lte: threshold } }
      ]
    })
      .sort({ stock: 1 })
      .limit(20),
    Order.countDocuments({ status: "NEW" }),
    Order.countDocuments({ status: "PENDING_ADMIN_APPROVAL" })
  ]);

  // Flatten low stock to SKU level for the dashboard
  const lowStock = [];
  lowStockProducts.forEach(p => {
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (v.isActive !== false && v.stock <= threshold) {
          lowStock.push({
            _id: `${p._id}_${v.sku}`,
            productId: p._id,
            name: `${p.name} (${v.sku || 'No SKU'})`,
            stock: v.stock,
            isVariant: true,
            sku: v.sku
          });
        }
      });
    } else if (p.stock <= threshold) {
      lowStock.push({
        _id: p._id,
        productId: p._id,
        name: p.name,
        stock: p.stock,
        isVariant: false
      });
    }
  });

  res.json({ 
    totalProducts, 
    totalCustomers, 
    pendingCustomers, 
    totalBills, 
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 10), 
    newOrders, 
    pendingCash 
  });
});

router.get("/settings", auth, requireRole("admin"), (req, res) => {
  res.json({
    companyName: process.env.COMPANY_NAME || "Click2Kart",
    companyGst: process.env.COMPANY_GST || "",
    companyAddress: process.env.COMPANY_ADDRESS || "",
    companyPhone: process.env.COMPANY_PHONE || "",
    companyEmail: process.env.COMPANY_EMAIL || "",
    lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD ?? 5)
  });
});

router.get("/customers", auth, requirePermission("customers"), async (req, res) => {
  const { q } = req.query;
  const filter = {};
  if (q) {
    filter.$or = [
      { name: { $regex: String(q), $options: "i" } },
      { phone: { $regex: String(q), $options: "i" } }
    ];
  }
  const items = await Customer.find(filter).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/customers/:id", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const user = await Customer.findById(id).select("-password");
  if (!user) return res.status(404).json({ error: "not_found" });
  const Order = (await import("../models/Order.js")).default;
  const Bill = (await import("../models/Bill.js")).default;
  const orders = await Order.find({ "customer.phone": user.phone }).sort({ createdAt: -1 }).limit(10);
  const bills = await Bill.find({ customer: id }).sort({ createdAt: -1 }).limit(10);
  res.json({ user, orders, bills });
});

router.delete("/customers/:id", auth, requireRole("admin"), async (req, res) => {
  const id = req.params.id;
  const removed = await Customer.findByIdAndDelete(id);
  if (!removed) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.post("/customers/:id/approve", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const updated = await Customer.findByIdAndUpdate(id, { isActive: true }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  if (updated.email) {
    try {
      const base =
        (process.env.CLIENT_URL && process.env.CLIENT_URL.replace(/\/$/, "")) ||
        (req.headers.origin && String(req.headers.origin).replace(/\/$/, "")) ||
        "https://click2kart.net";
      await sendEmail({
        to: updated.email,
        subject: `Welcome to ${process.env.COMPANY_NAME || "Click2Kart"}`,
        html: `
          <div style="font-family: ui-sans-serif, system-ui; max-width: 560px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color:#111827;margin:0 0 12px;font-weight:800">Welcome, ${updated.name}!</h2>
            <p style="color:#374151;line-height:1.6">Your B2B account has been approved. You can now sign in to view wholesale prices and place orders.</p>
            <a href="${base}/login" style="display:inline-block;margin-top:16px;padding:12px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">Login Now</a>
            <p style="color:#6b7280;margin-top:24px;font-size:12px">&copy; ${new Date().getFullYear()} ${process.env.COMPANY_NAME || "Click2Kart"}</p>
          </div>
        `
      });
    } catch {}
  }
  res.json({ approved: true, customer: updated });
});

// Top buyers analytics
router.get("/analytics/top-buyers", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const agg = await Order.aggregate([
    {
      $group: {
        _id: "$customer.phone",
        name: { $last: "$customer.name" },
        email: { $last: "$customer.email" },
        totalSpent: { $sum: "$totalEstimate" },
        orderCount: { $sum: 1 }
      }
    },
    { $sort: { totalSpent: -1 } },
    { $limit: limit }
  ]);
  res.json(agg.map(x => ({
    phone: x._id,
    name: x.name || "",
    email: x.email || "",
    totalSpent: x.totalSpent || 0,
    orderCount: x.orderCount || 0
  })));
});

export default router;

// Revenue summary: totals and leaders
router.get("/revenue/summary", auth, requirePermission("dashboard"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  const paidStatuses = ["PAID", "PARTIAL"];
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const totalAgg = await Order.aggregate([
    { $match: { paymentStatus: { $in: paidStatuses } } },
    { $group: { _id: null, sum: { $sum: "$totalEstimate" } } }
  ]);
  const monthAgg = await Order.aggregate([
    { $match: { paymentStatus: { $in: paidStatuses }, createdAt: { $gte: startOfMonth } } },
    { $group: { _id: null, sum: { $sum: "$totalEstimate" } } }
  ]);
  const pendingOrders = await Order.countDocuments({ status: { $in: ["NEW", "PENDING_CASH_APPROVAL"] } });
  const topProducts = await Order.aggregate([
    { $unwind: "$items" },
    { $group: { _id: "$items.name", revenue: { $sum: "$items.lineTotal" }, qty: { $sum: "$items.quantity" } } },
    { $sort: { revenue: -1 } },
    { $limit: 5 }
  ]);
  const topBuyers = await Order.aggregate([
    { $group: { _id: "$customer.phone", name: { $last: "$customer.name" }, total: { $sum: "$totalEstimate" } } },
    { $sort: { total: -1 } },
    { $limit: 5 }
  ]);
  res.json({
    totalRevenue: totalAgg[0]?.sum || 0,
    thisMonthRevenue: monthAgg[0]?.sum || 0,
    pendingOrders,
    topProducts: topProducts.map(x => ({ name: x._id, revenue: x.revenue, quantity: x.qty })),
    topBuyers: topBuyers.map(x => ({ phone: x._id, name: x.name, total: x.total }))
  });
});
