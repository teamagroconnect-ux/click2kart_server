import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";
import Bill from "../models/Bill.js";
import Order from "../models/Order.js";
import { computeTotals, generateInvoiceNumber } from "../lib/invoice.js";
import { streamInvoicePDF } from "../lib/pdf.js";
import { renderInvoiceHTML } from "../lib/invoiceHtml.js";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";

const router = express.Router();

router.post("/", auth, requireRole("admin"), async (req, res) => {
  try {
    const { customerId, customer, items, paymentType, couponCode } = req.body || {};
    const billDoc = await createBillFromData({
      customerData: customerId ? { id: customerId } : customer,
      items,
      paymentType,
      couponCode
    });
    const populated = await Bill.findById(billDoc._id).populate("customer");
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

router.get("/:id/html", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  const order = await Order.findOne({ billId: bill._id }).lean();
  const html = renderInvoiceHTML(bill.toObject(), bill.customer?.toObject(), order);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
