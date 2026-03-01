import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Bill from "../models/Bill.js";
import { sendEmail } from "../lib/mailer.js";

const router = express.Router();

router.get("/stats", auth, requireRole("admin"), async (req, res) => {
  const [totalProducts, totalCustomers, pendingCustomers, totalBills, lowStock] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: false }),
    Bill.countDocuments({}),
    Product.find({ isActive: true, stock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD ?? 5) } })
      .sort({ stock: 1 })
      .limit(10)
  ]);
  res.json({ totalProducts, totalCustomers, pendingCustomers, totalBills, lowStock });
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

router.get("/customers", auth, requireRole("admin"), async (req, res) => {
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

router.post("/customers/:id/approve", auth, requireRole("admin"), async (req, res) => {
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

export default router;
