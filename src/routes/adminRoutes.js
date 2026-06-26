import express from "express";
import mongoose from "mongoose";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import OfflineCustomer from "../models/OfflineCustomer.js";
import Bill from "../models/Bill.js";
import Partner from "../models/Partner.js";
import { sendEmail } from "../lib/mailer.js";

import Admin from "../models/Admin.js";
import Settings from "../models/Settings.js";

const router = express.Router();

// Verify deletion password
router.post("/verify-deletion-password", auth, requireRole("admin"), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });

    const admin = await Admin.findById(req.user.id);
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const isMatch = await admin.compareDeletionPassword(password);
    if (!isMatch) return res.status(401).json({ error: "Invalid password" });

    res.json({ valid: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

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
  
  await Admin.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

router.get("/stats", auth, async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  const SupportTicket = (await import("../models/SupportTicket.js")).default;
  const settings = await Settings.getDefaultSettings();
  const threshold = settings.lowStockThreshold || 5;
  
  // Aggregate inventory stats directly in DB for efficiency
  const invStats = await Product.aggregate([
    { $match: { isActive: true } },
    {
      $project: {
        skus: {
          $cond: {
            if: { $and: [{ $isArray: "$variants" }, { $gt: [{ $size: "$variants" }, 0] }] },
            then: {
              $filter: {
                input: "$variants",
                as: "v",
                cond: { $ne: ["$$v.isActive", false] }
              }
            },
            else: [{ stock: "$stock", isActive: true }]
          }
        }
      }
    },
    { $unwind: "$skus" },
    {
      $group: {
        _id: null,
        totalSkus: { $sum: 1 },
        totalUnits: { $sum: "$skus.stock" },
        outOfStock: { $sum: { $cond: [{ $eq: ["$skus.stock", 0] }, 1, 0] } },
        lowStockCount: { $sum: { $cond: [{ $and: [{ $gt: ["$skus.stock", 0] }, { $lte: ["$skus.stock", threshold] }] }, 1, 0] } }
      }
    }
  ]);

  const [actualProductsCount, totalCustomers, pendingCustomers, skippedCustomers, totalBills, lowStockProducts, newOrders, pendingCash, pendingSupportTickets, inProgressSupportTickets, resolvedSupportTickets] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: true }),
    Customer.countDocuments({ approvalStatus: 'pending' }),
    Customer.countDocuments({ approvalStatus: 'skipped' }),
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
    Order.countDocuments({ status: "PENDING_ADMIN_APPROVAL" }),
    SupportTicket.countDocuments({ status: 'Open' }),
    SupportTicket.countDocuments({ status: 'In Progress' }),
    SupportTicket.countDocuments({ status: 'Resolved' })
  ]);

  const inv = invStats[0] || { totalSkus: 0, totalUnits: 0, outOfStock: 0, lowStockCount: 0 };

  // Flatten low stock to SKU level
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
    actualProductsCount,
    totalProducts: inv.totalSkus, 
    totalUnits: inv.totalUnits,
    outOfStock: inv.outOfStock,
    lowStockCount: inv.lowStockCount,
    totalCustomers, 
    pendingCustomers,
    skippedCustomers,
    totalBills, 
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 10), 
    newOrders, 
    pendingCash,
    pendingSupportTickets,
    inProgressSupportTickets,
    resolvedSupportTickets
  });
});

// Get settings from database
router.get("/settings", auth, requireRole("admin"), async (req, res) => {
  try {
    const settings = await Settings.getDefaultSettings();
    res.json(settings);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// Update settings
router.put("/settings", auth, requireRole("admin"), async (req, res) => {
  try {
    const settings = await Settings.getDefaultSettings();
    
    // Update all provided fields
    Object.keys(req.body).forEach(key => {
      if (key in settings.schema.paths) {
        settings[key] = req.body[key];
      }
    });
    
    await settings.save();
    res.json(settings);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// Update admin deletion password (requires old password)
router.put("/deletion-password", auth, requireRole("admin"), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Old password and new password (min 6 chars) required" });
    }

    const admin = await Admin.findById(req.user.id);
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    // Verify old password
    const isMatch = await admin.compareDeletionPassword(oldPassword);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid old password" });
    }

    admin.deletionPassword = newPassword;
    await admin.save();

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Change admin login password (requires old password)
router.put("/change-password", auth, requireRole("admin"), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Old password and new password (min 6 chars) required" });
    }

    const admin = await Admin.findById(req.user.id);
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    // Verify old password
    const isMatch = await admin.comparePassword(oldPassword);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid old password" });
    }

    admin.password = newPassword;
    await admin.save();

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/customers", auth, requirePermission("customers"), async (req, res) => {
  const { q, status } = req.query;
  const filter = {};
  if (q) {
    filter.$or = [
      { name: { $regex: String(q), $options: "i" } },
      { phone: { $regex: String(q), $options: "i" } }
    ];
  }
  if (status) {
    if (status === 'pending') filter.approvalStatus = 'pending';
    else if (status === 'skipped') filter.approvalStatus = 'skipped';
    else if (status === 'approved') filter.approvalStatus = 'approved';
  }
  
  const customers = await Customer.find(filter).sort({ createdAt: -1 });
  
  // Enrich with order counts and partner details
  const Order = (await import("../models/Order.js")).default;
  const enriched = await Promise.all(customers.map(async (c) => {
    const orderCount = await Order.countDocuments({ "customer.phone": c.phone });
    let partner = null;
    if (c.kyc?.partnerInviteCode) {
      partner = await Partner.findOne({ inviteCode: c.kyc.partnerInviteCode });
    }
    return { ...c.toObject(), orderCount, partner: partner ? partner.toObject() : null };
  }));

  res.json(enriched);
});

router.get("/customers/:id", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const user = await Customer.findById(id).select("-password");
  if (!user) return res.status(404).json({ error: "not_found" });
  const Order = (await import("../models/Order.js")).default;
  const Bill = (await import("../models/Bill.js")).default;
  const orders = await Order.find({ "customer.phone": user.phone }).sort({ createdAt: -1 }).limit(10);
  const bills = await Bill.find({ customer: id }).sort({ createdAt: -1 }).limit(10);
  
  let partner = null;
  if (user.kyc?.partnerInviteCode) {
    partner = await Partner.findOne({ inviteCode: user.kyc.partnerInviteCode });
  }
  
  res.json({ user, orders, bills, partner: partner ? partner.toObject() : null });
});

router.delete("/customers/:id", auth, requireRole("admin"), async (req, res) => {
  const id = req.params.id;
  
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
  
  const removed = await Customer.findByIdAndDelete(id);
  if (!removed) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.post("/customers/:id/approve", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const updated = await Customer.findByIdAndUpdate(id, { isActive: true, approvalStatus: 'approved' }, { new: true });
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

router.post("/customers/:id/skip", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const updated = await Customer.findByIdAndUpdate(id, { approvalStatus: 'skipped' }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ skipped: true, customer: updated });
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

// Revenue and Top Products Summary
router.get("/revenue/summary", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  try {
    const totalAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $group: { _id: null, total: { $sum: "$totalEstimate" }, count: { $sum: 1 } } }
    ]);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] }, createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$totalEstimate" } } }
    ]);

    const pendingCount = await Order.countDocuments({ status: "NEW" });

    // Top Products Aggregation (PRODUCT-BASED - User requested)
    const topProductsAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          name: { $first: "$items.name" },
          revenue: { $sum: "$items.lineTotal" },
          quantity: { $sum: "$items.quantity" }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    const topBuyersAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      {
        $group: {
          _id: "$customer.phone",
          name: { $first: "$customer.name" },
          phone: { $first: "$customer.phone" },
          total: { $sum: "$totalEstimate" }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]);

    res.json({
      totalRevenue: totalAgg[0]?.total || 0,
      totalOrders: totalAgg[0]?.count || 0,
      thisMonthRevenue: monthAgg[0]?.total || 0,
      pendingOrders: pendingCount,
      topProducts: topProductsAgg.map(p => ({
        id: p._id,
        name: p.name,
        revenue: p.revenue,
        quantity: p.quantity
      })),
      topBuyers: topBuyersAgg
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Offline Customers CRUD
router.get("/offline-customers", auth, requirePermission("offline-customers"), async (req, res) => {
  const { q } = req.query;
  const filter = {};
  if (q) {
    filter.$or = [
      { name: { $regex: String(q), $options: "i" } },
      { phone: { $regex: String(q), $options: "i" } },
      { email: { $regex: String(q), $options: "i" } }
    ];
  }
  const items = await OfflineCustomer.find(filter).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/offline-customers/:id", auth, requirePermission("offline-customers"), async (req, res) => {
  const customer = await OfflineCustomer.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: "not_found" });
  const bills = await Bill.find({ offlineCustomer: req.params.id }).sort({ createdAt: -1 }).limit(10);
  res.json({ customer, bills });
});

router.post("/offline-customers", auth, requirePermission("offline-customers"), async (req, res) => {
  const { name, email, phone, whatsappNumber, address, notes } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
  const customer = await OfflineCustomer.create({ name, email, phone, whatsappNumber, address, notes });
  res.status(201).json(customer);
});

router.put("/offline-customers/:id", auth, requirePermission("offline-customers"), async (req, res) => {
  const customer = await OfflineCustomer.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!customer) return res.status(404).json({ error: "not_found" });
  res.json(customer);
});

router.delete("/offline-customers/:id", auth, requireRole("admin"), async (req, res) => {
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
  
  await OfflineCustomer.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

// SKU Breakdown for a specific Product
router.get("/revenue/product/:id/skus", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  try {
    const skuAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $unwind: "$items" },
      { $match: { "items.product": new mongoose.Types.ObjectId(req.params.id) } },
      {
        $group: {
          _id: "$items.variantSku",
          name: { $first: "$items.name" },
          revenue: { $sum: "$items.lineTotal" },
          quantity: { $sum: "$items.quantity" }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    res.json({
      productId: req.params.id,
      skus: skuAgg.map(s => ({
        sku: s._id || "No SKU",
        revenue: s.revenue,
        quantity: s.quantity
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
