import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";
import Bill from "../models/Bill.js";
import { computeTotals, generateInvoiceNumber } from "../lib/invoice.js";
import { streamInvoicePDF } from "../lib/pdf.js";
import Coupon from "../models/Coupon.js";
import StockTxn from "../models/StockTxn.js";
import { sendLowStockEmail } from "../lib/notifications.js";

const router = express.Router();

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { customerId, customer, items, paymentType, couponCode } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  let cust;
  if (customerId) {
    if (!mongoose.isValidObjectId(customerId)) return res.status(400).json({ error: "invalid_customer" });
    cust = await Customer.findOne({ _id: customerId, isActive: true });
    if (!cust) return res.status(404).json({ error: "customer_not_found" });
  } else if (customer && customer.name && customer.phone) {
    const phone = String(customer.phone).trim();
    cust = await Customer.findOne({ phone });
    if (!cust) {
      cust = await Customer.create({
        name: String(customer.name).trim(),
        phone,
        email: customer.email || "",
        address: customer.address || ""
      });
    }
  } else {
    return res.status(400).json({ error: "missing_customer" });
  }

  const ids = items.map((x) => x.productId).filter(Boolean);
  if (ids.length !== items.length) return res.status(400).json({ error: "invalid_items" });
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  for (const it of items) {
    const p = products.find((x) => x._id.toString() === it.productId);
    const qty = Number(it.quantity);
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
    if (!p || p.stock < qty) return res.status(400).json({ error: "insufficient_stock", productId: it.productId });
  }

  const totals = computeTotals(products, items);
  let discount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    const now = new Date();
    const c = await Coupon.findOne({ code });
    if (!c || !c.isActive || (c.expiryDate && c.expiryDate < now) || (c.usageLimit > 0 && c.usedCount >= c.usageLimit) || (totals.total < (c.minAmount || 0))) {
      return res.status(400).json({ error: "invalid_coupon" });
    }
    discount = c.type === "PERCENT" ? (totals.total * c.value) / 100 : c.value;
    if (discount > totals.total) discount = totals.total;
    appliedCoupon = c;
  }
  if (appliedCoupon && appliedCoupon.maxTotalSales > 0) {
    const currentBills = await Bill.find({ couponCode: appliedCoupon.code });
    const currentTotal = currentBills.reduce((sum, b) => sum + (b.payable || 0), 0);
    const nextPayable = Number((totals.total - discount).toFixed(2));
    if (currentTotal + nextPayable > appliedCoupon.maxTotalSales) {
      return res.status(400).json({ error: "coupon_amount_limit_reached" });
    }
  }
  const invoiceNumber = await generateInvoiceNumber();

  const session = await mongoose.startSession();
  let billDoc;
  try {
    await session.withTransaction(async () => {
      for (const it of items) {
        const p = products.find((x) => x._id.toString() === it.productId);
        const r = await Product.updateOne(
          { _id: it.productId, stock: { $gte: it.quantity } },
          { $inc: { stock: -Number(it.quantity) } },
          { session }
        );
        if (r.matchedCount !== 1 || r.modifiedCount !== 1) throw new Error("stock_update_failed");
        await StockTxn.create([
          {
            product: it.productId,
            type: "SOLD",
            quantity: Number(it.quantity),
            before: p.stock,
            after: p.stock - Number(it.quantity),
            refType: "BILL",
            refId: invoiceNumber
          }
        ], { session });
      }
      billDoc = await Bill.create(
        [
          {
            invoiceNumber,
            customer: cust._id,
            items: totals.items,
            subtotal: totals.subtotal,
            gstTotal: totals.gstTotal,
            total: totals.total,
            discount: Number(discount.toFixed(2)),
            payable: Number((totals.total - discount).toFixed(2)),
            couponCode: appliedCoupon ? appliedCoupon.code : undefined,
            gstBreakdown: totals.gstBreakdown,
            paymentType: paymentType || "CASH"
          }
        ],
        { session }
      );
      billDoc = billDoc[0];
      await Customer.updateOne({ _id: cust._id }, { $push: { purchaseHistory: billDoc._id } }, { session });
      if (appliedCoupon) {
        await Coupon.updateOne({ _id: appliedCoupon._id }, { $inc: { usedCount: 1 } }, { session });
      }
    });
  } finally {
    session.endSession();
  }

  const populated = await Bill.findById(billDoc._id).populate("customer");

  try {
    const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
    const lowItems = await Product.find({ _id: { $in: products.map((p) => p._id) }, stock: { $lte: threshold }, isActive: true });
    if (lowItems.length > 0) await sendLowStockEmail(lowItems, threshold);
  } catch {}

  res.status(201).json(populated);
});

router.get("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  res.json(bill);
});

router.get("/:id/pdf", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  streamInvoicePDF(res, bill, bill.customer);
});

export default router;
