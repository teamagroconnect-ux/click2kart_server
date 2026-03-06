import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import { auth, requireRole } from "../middleware/auth.js";
import { computeTotals } from "../lib/invoice.js";
import razorpay from "../lib/razorpay.js";
import crypto from "crypto";
import { createBillFromData } from "../lib/billing.js";
import { sendEmail, renderMail } from "../lib/mailer.js";
import AuditLog from "../models/AuditLog.js";
import { notifyAdmin } from "../lib/socket.js";
import fetch from "node-fetch";

const router = express.Router();

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const getDelhiveryBase = () => _sanitize(process.env.DELHIVERY_BASE_URL || "");
const getDelhiveryToken = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const getDims = () => ({
  weight: Number(process.env.DELHIVERY_PACKAGE_WEIGHT || 1),
  length: Number(process.env.DELHIVERY_PACKAGE_LENGTH || 10),
  breadth: Number(process.env.DELHIVERY_PACKAGE_WIDTH || 10),
  height: Number(process.env.DELHIVERY_PACKAGE_HEIGHT || 10)
});

const tryCreateDelhiveryShipment = async (order) => {
  try {
    const base = getDelhiveryBase();
    const token = getDelhiveryToken();
    if (!base || !token) throw new Error("Delhivery config missing");
    
    // Load customer KYC for address
    const cust = await Customer.findOne({ phone: order.customer.phone }).select("kyc");
    const addr = {
      line1: cust?.kyc?.addressLine1 || "",
      line2: cust?.kyc?.addressLine2 || "",
      city: cust?.kyc?.city || "",
      state: cust?.kyc?.state || "",
      pincode: cust?.kyc?.pincode || ""
    };
    if (!addr.pincode) throw new Error("Customer pincode missing");

    // Optional: quick serviceability check (non-blocking)
    try {
      await fetch(`${base}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(addr.pincode)}`, { headers: { Authorization: `Token ${token}` } });
    } catch {}

    // Generate waybill - MUST get a real one from Delhivery
    let waybill = "";
    try {
      const wbResp = await fetch(`${base}/waybill/api/bulk/json/?token=${token}&count=1&format=json`, {
        method: "GET",
        headers: { "Content-Type": "application/json", Authorization: `Token ${token}` }
      });
      const wbData = await wbResp.json();
      const wb = Array.isArray(wbData) ? wbData[0] : (wbData?.waybill || wbData?.waybills?.[0]);
      if (wb) waybill = String(wb);
    } catch (err) {
      console.error("Failed to fetch waybill from Delhivery:", err);
    }

    if (!waybill) {
      throw new Error("Could not fetch a valid Waybill from Delhivery. Please check your account/API key.");
    }

    // Prepare payload
    const pickup = process.env.DELHIVERY_PICKUP_LOCATION || "Click2Kart Main";
    const paymentMode = order.paymentMethod === "RAZORPAY" ? "Prepaid" : "COD";
    const codAmount = paymentMode === "COD" ? Number(order.codDueAmount || order.totalEstimate || 0).toFixed(2) : "0.00";
    const dims = getDims();
    const payload = {
      pickup_location: pickup,
      shipments: [
        {
          waybill,
          name: order.customer.name,
          add: addr.line1,
          address2: addr.line2,
          city: addr.city,
          state: addr.state,
          country: "India",
          phone: order.customer.phone,
          pin: addr.pincode,
          order: order._id.toString(),
          payment_mode: paymentMode,
          products_desc: (order.items || []).map(i => i.name).join(", ").slice(0, 200),
          cod_amount: codAmount,
          total_amount: Number(order.totalEstimate || 0).toFixed(2),
          ...dims
        }
      ]
    };
    const resp = await fetch(`${base}/api/cmu/create.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    const wbFinal = data?.packages?.[0]?.waybill || data?.waybill || waybill;
    const status = data?.packages?.[0]?.status?.status || data?.status || "CREATED";

    if (data.success || data.packages?.[0]?.status === "Success" || wbFinal) {
      order.shipping = {
        provider: "DELHIVERY",
        waybill: wbFinal,
        status: status,
        trackingUrl: `https://track.delhivery.com/track/package/${wbFinal}`
      };
      order.status = "SHIPPED";
      await order.save();
      return order;
    }
    throw new Error(data?.packages?.[0]?.remarks?.[0] || data?.message || "Delhivery API error");
  } catch (err) {
    console.error("Delhivery Shipment Exception:", err);
    throw err;
  }
};

// Create new order
router.post("/", auth, requireRole("customer"), async (req, res) => {
  const { 
    items, 
    notes, 
    paymentMethod,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (!["CASH", "RAZORPAY", "COD_20"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });

  const cust = await Customer.findById(req.user.id).select("name phone email isKycComplete kyc");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });
  if (!cust.isKycComplete) return res.status(403).json({ error: "kyc_required" });

  // Serviceability guard if Delhivery configured
  try {
    const token = getDelhiveryToken();
    const base = getDelhiveryBase();
    const ltl = process.env.DELHIVERY_LTL_BASE_URL && process.env.DELHIVERY_LTL_BASE_URL.replace(/\/+$/, "");
    const pin = String(cust?.kyc?.pincode || "").trim();
    if (token && pin && (ltl || base)) {
      let delivery = true, cod = true;
      if (ltl) {
        const resp = await fetch(`${ltl}/pincode-service/${encodeURIComponent(pin)}`, { headers: { Authorization: `Token ${token}` } });
        const data = await resp.json();
        const svc = data?.data || data || {};
        delivery = !!(svc.serviceable ?? svc.is_serviceable ?? svc.delivery ?? svc.pre_paid);
        cod = !!(svc.cod ?? svc.cod_serviceable ?? svc.cash);
      } else if (base) {
        const resp = await fetch(`${base}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pin)}`, { headers: { Authorization: `Token ${token}` } });
        const data = await resp.json();
        const entry = Array.isArray(data) ? data.find((x) => String(x.pin) === pin) : (data?.delivery_codes?.[0] || null);
        delivery = !!(entry?.is_oda === false || entry?.pre_paid || entry?.delivery || entry?.serviceable);
        cod = !!(entry?.cod || entry?.cash || entry?.cod_serviceable);
      }
      if (!delivery) return res.status(400).json({ error: "service_unavailable" });
      if (paymentMethod === "COD_20" && !cod) return res.status(400).json({ error: "cod_unavailable" });
    }
  } catch {}

  const ids = items.map((x) => x.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  // Check stock before proceeding
  for (const it of items) {
    const p = products.find(x => x._id.toString() === it.productId);
    if (!p) return res.status(400).json({ error: "product_not_found" });
    if (p.minOrderQty && Number(p.minOrderQty) > 0 && it.quantity < Number(p.minOrderQty)) {
      return res.status(400).json({ error: `MOQ_not_met:${p.minOrderQty}` });
    }
    if (it.variantId) {
      const v = (p.variants || []).find(v => v._id.toString() === String(it.variantId));
      if (!v || (v.stock || 0) < it.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
      }
    } else if (p.stock < it.quantity) {
      return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
    }
  }

  const totals = computeTotals(products, items);
  const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
  if (totals.total < minAmount) {
    return res.status(400).json({ error: "min_order_not_met", minAmount });
  }
  const orderItems = totals.items.map((it) => {
    const p = products.find(x => x._id.toString() === it.product.toString());
    const v = it.variantId ? (p?.variants || []).find(v => v._id.toString() === String(it.variantId)) : null;
    return {
      product: it.product,
      variantId: it.variantId,
      name: it.name,
      price: it.price,
      gst: it.gst,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
      image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "")
    };
  });

  let razorpayOrder = null;
  if (paymentMethod === "RAZORPAY" || paymentMethod === "COD_20") {
    try {
      const amountPaise = paymentMethod === "COD_20"
        ? Math.round(totals.total * 0.2 * 100)
        : Math.round(totals.total * 100);
      razorpayOrder = await razorpay.orders.create({
        amount: amountPaise, // in paise
        currency: "INR",
        receipt: `receipt_${Date.now()}`
      });
    } catch (err) {
      console.error("Razorpay Order Creation Failed:", err);
      return res.status(500).json({ error: "payment_initiation_failed" });
    }
  }

  const orderStatus = paymentMethod === "CASH" ? "PENDING_CASH_APPROVAL" : "PENDING_PAYMENT";

  const doc = await Order.create({
    customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
    items: orderItems,
    totalEstimate: totals.total,
    status: orderStatus,
    paymentMethod,
    paymentStatus: "PENDING",
    razorpayOrderId: razorpayOrder?.id,
    notes: notes || "",
    codAdvancePercent: paymentMethod === "COD_20" ? 20 : 0,
    codDueAmount: paymentMethod === "COD_20" ? Number((totals.total * 0.8).toFixed(2)) : 0
  });

  if (paymentMethod === "CASH") {
    notifyAdmin("new_offline_order", doc);
    try {
      const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const html = renderMail({
        heading: "Order Received",
        subheading: "Thanks for your order. We’ve started processing it.",
        highlight: `Order ID: ${doc._id}`,
        blocks: [
          { label: "Total", value: `₹${Number(totals.total).toLocaleString("en-IN")}` },
          { label: "Payment Method", value: doc.paymentMethod },
          { label: "Status", value: orderStatus }
        ],
        items: doc.items.map(it => ({
          name: it.name,
          quantity: it.quantity,
          price: it.price,
          lineTotal: it.lineTotal
        })),
        totals: { subtotal: totals.subtotal, gstTotal: totals.gstTotal, total: totals.total }
      });
      if (to) await sendEmail({ to, subject: `Order placed - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
    } catch {}
  }

  res.status(201).json({
    order: doc,
    razorpayOrderId: razorpayOrder?.id
  });
});


// Prepare Payment (no Order creation) - new flow
router.post("/prepare-payment", auth, requireRole("customer"), async (req, res) => {
  const { items, paymentMethod } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (!["RAZORPAY", "COD_20"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: "razorpay_not_configured" });
    }
    const ids = items.map((x) => x.productId);
    const products = await Product.find({ _id: { $in: ids }, isActive: true });
    if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });
    const totals = computeTotals(products, items);
    const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
    if (totals.total < minAmount) return res.status(400).json({ error: "min_order_not_met", minAmount });
    const amountPaise = paymentMethod === "COD_20"
      ? Math.round(totals.total * 0.2 * 100)
      : Math.round(totals.total * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: "invalid_amount" });
    }
    const rp = await razorpay.orders.create({ amount: amountPaise, currency: "INR", receipt: `prepay_${Date.now()}` });
    const checksum = crypto.createHash("sha256").update(JSON.stringify({ items, paymentMethod, amountPaise })).digest("hex");
    return res.json({ razorpayOrderId: rp.id, amountPaise: rp.amount, checksum });
  } catch (e) {
    console.error("Prepare payment failed:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: "payment_initiation_failed" });
  }
});

// Create Order after payment verification (new flow)
router.post("/create-after-verify", auth, requireRole("customer"), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, items, paymentMethod, notes } = req.body || {};
  if (!["RAZORPAY", "COD_20"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest("hex");
  if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: "invalid_signature" });

  const cust = await Customer.findById(req.user.id).select("name phone email isKycComplete kyc");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });
  if (!cust.isKycComplete) return res.status(403).json({ error: "kyc_required" });

  try {
    const ids = items.map((x) => x.productId);
    const products = await Product.find({ _id: { $in: ids }, isActive: true });
    if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });
    // Stock re-check
    for (const it of items) {
      const p = products.find(x => x._id.toString() === it.productId);
      if (!p) return res.status(400).json({ error: "product_not_found" });
      const qty = Number(it.quantity || 0);
      if (it.variantId) {
        const v = (p.variants || []).find(v => v._id.toString() === String(it.variantId));
        if (!v || (v.stock || 0) < qty) return res.status(400).json({ error: "stock_changed" });
      } else if ((p.stock || 0) < qty) {
        return res.status(400).json({ error: "stock_changed" });
      }
    }
    const totals = computeTotals(products, items);
    const orderItems = totals.items.map((it) => {
      const p = products.find(x => x._id.toString() === it.product.toString());
      const v = it.variantId ? (p?.variants || []).find(v => v._id.toString() === String(it.variantId)) : null;
      return { product: it.product, variantId: it.variantId, name: it.name, price: it.price, gst: it.gst, quantity: it.quantity, lineTotal: it.lineTotal, image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "") };
    });
    const doc = await Order.create({
      customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
      items: orderItems,
      totalEstimate: totals.total,
      status: "CONFIRMED", // Razorpay orders are directly confirmed after successful payment
      paymentMethod,
      paymentStatus: paymentMethod === "COD_20" ? "PARTIAL" : "PAID",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      notes: notes || "",
      codAdvancePercent: paymentMethod === "COD_20" ? 20 : 0,
      codDueAmount: paymentMethod === "COD_20" ? Number((totals.total * 0.8).toFixed(2)) : 0
    });
    // Billing only for full online payments
    if (paymentMethod === "RAZORPAY") {
      try {
        await createBillFromData({
          customerData: { phone: doc.customer.phone, name: doc.customer.name, email: doc.customer.email },
          items: doc.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
          paymentType: "RAZORPAY",
          existingOrderId: doc._id
        });
      } catch {}
    }
    try {
      const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const paidText = paymentMethod === "COD_20"
        ? `Advance Paid: ₹${Number(doc.totalEstimate * 0.2).toLocaleString("en-IN")}`
        : `Amount Paid: ₹${Number(doc.totalEstimate).toLocaleString("en-IN")}`;
      const html = renderMail({
        heading: "Payment Confirmed",
        subheading: "We’ve confirmed your payment and are preparing your shipment.",
        highlight: `Order ID: ${doc._id}`,
        blocks: [
          { label: "Payment Method", value: doc.paymentMethod },
          { label: "Payment", value: paidText },
          { label: "Current Status", value: doc.status }
        ]
      });
      if (to) await sendEmail({ to, subject: `Payment confirmed - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
    } catch {}
    // Attempt shipment creation (non-blocking)
    try { await tryCreateDelhiveryShipment(doc); } catch {}
    return res.json({ success: true, orderId: doc._id });
  } catch (e) {
    return res.status(500).json({ error: "order_create_failed" });
  }
});

// Verify Razorpay Payment
router.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body || {};
  
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // Re-validate stock and totals before marking paid
    try {
      const ids = order.items.map(i => i.product.toString());
      const products = await Product.find({ _id: { $in: ids }, isActive: true });
      // Stock check
      for (const it of order.items) {
        const p = products.find(x => x._id.toString() === it.product.toString());
        if (!p) return res.status(400).json({ error: "product_not_found" });
        const qty = Number(it.quantity || 0);
        if (it.variantId) {
          const v = (p.variants || []).find(v => v._id.toString() === String(it.variantId));
          if (!v || (v.stock || 0) < qty) return res.status(400).json({ error: "stock_changed" });
        } else if ((p.stock || 0) < qty) {
          return res.status(400).json({ error: "stock_changed" });
        }
      }
      // Totals check with possible new bulk pricing
      const recomputeItems = order.items.map(it => ({
        productId: it.product.toString(),
        variantId: it.variantId ? it.variantId.toString() : undefined,
        quantity: it.quantity
      }));
      const totals = computeTotals(products, recomputeItems);
      const expected = Math.round((order.paymentMethod === "COD_20" ? totals.total * 0.2 : totals.total) * 100);
      // If amount drifted vs originally computed amount stored on order
      const orderAmountPaise = Math.round((order.paymentMethod === "COD_20" ? order.totalEstimate * 0.2 : order.totalEstimate) * 100);
      if (expected !== orderAmountPaise) {
        return res.status(400).json({ error: "amount_mismatch" });
      }
    } catch (e) {
      return res.status(400).json({ error: "revalidation_failed" });
    }

    if (order.paymentMethod === "COD_20") {
      order.paymentStatus = "PARTIAL";
      order.status = "CONFIRMED";
      order.advancePaidAmount = Number((order.totalEstimate * 0.2).toFixed(2));
    } else {
      order.paymentStatus = "PAID";
      order.status = "CONFIRMED";
    }
    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    await order.save();

    // Trigger automatic billing only for full online payments
    if (order.paymentMethod === "RAZORPAY") {
    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
        paymentType: "RAZORPAY",
        existingOrderId: order._id
      });
    } catch (err) {
        console.error("Auto-billing failed after payment:", err);
      }
    }
    try {
      await AuditLog.create({ actorId: "", actorRole: "system", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Payment verified (${order.paymentMethod})` });
      const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const paidText = order.paymentMethod === "COD_20"
        ? `Advance Paid: ₹${Number(order.totalEstimate * 0.2).toLocaleString("en-IN")}`
        : `Amount Paid: ₹${Number(order.totalEstimate).toLocaleString("en-IN")}`;
      const html = renderMail({
        heading: "Payment Confirmed",
        subheading: "We’ve confirmed your payment and are preparing your shipment.",
        highlight: `Order ID: ${order._id}`,
        blocks: [
          { label: "Payment Method", value: order.paymentMethod },
          { label: "Payment", value: paidText },
          { label: "Current Status", value: order.status }
        ]
      });
      if (to) await sendEmail({ to, subject: `Payment confirmed - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
    } catch {}
    
    // Auto-create shipment (legacy CMU) after payment
    try {
      if (order.status === "CONFIRMED") {
        // Optional: compute free shipping (mirror /calculate fallback)
        const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
        const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
        const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 0);
        const weight = Number(process.env.DELHIVERY_PACKAGE_WEIGHT || 1);
        const variable = perKg * weight;
        const amt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
        order.shipping_charge = amt;
        order.shipping_discount = amt;
        await order.save();

        const created = await tryCreateDelhiveryShipment(order);
        if (!created) {
          order.shipment_status = "CREATION_FAILED";
          await order.save();
        }
      }
    } catch {}
    
    res.json({ success: true, message: "payment_verified" });
  } else {
    res.status(400).json({ error: "invalid_signature" });
  }
});

// Manual Payment Submission (UPI/Bank) - create order pending approval
router.post("/manual-submit", auth, requireRole("customer"), async (req, res) => {
  const { items, amountPaid, utr, note, codAdvance20 } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  const cust = await Customer.findById(req.user.id).select("name phone email isKycComplete kyc");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });
  if (!cust.isKycComplete) return res.status(403).json({ error: "kyc_required" });
  try {
    const ids = items.map((x) => x.productId);
    const products = await Product.find({ _id: { $in: ids }, isActive: true });
    if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });
    const totals = computeTotals(products, items);
    const orderItems = totals.items.map((it) => {
      const p = products.find(x => x._id.toString() === it.product.toString());
      const v = it.variantId ? (p?.variants || []).find(v => v._id.toString() === String(it.variantId)) : null;
      return { product: it.product, variantId: it.variantId, name: it.name, price: it.price, gst: it.gst, quantity: it.quantity, lineTotal: it.lineTotal, image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "") };
    });
    const doc = await Order.create({
      customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
      items: orderItems,
      totalEstimate: totals.total,
      status: "PENDING_ADMIN_APPROVAL",
      paymentMethod: codAdvance20 ? "COD_20" : "MANUAL",
      paymentStatus: "PAYMENT_SUBMITTED",
      notes: note || "",
      manualPayment: { amountPaid: Number(amountPaid || 0), utr: String(utr || ""), note: String(note || "") },
      codAdvancePercent: codAdvance20 ? 20 : 0,
      codDueAmount: codAdvance20 ? Number((totals.total * 0.8).toFixed(2)) : 0
    });
    
    // Notify admin via WebSocket
    try {
      notifyAdmin("new_manual_payment", doc);
    } catch (err) {
      console.error("Failed to notify admin via socket:", err);
    }

    try {
      const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const html = renderMail({
        heading: codAdvance20 ? "COD Advance Submitted" : "Payment Submitted",
        subheading: codAdvance20 ? "We have received your 20% COD advance. Our team will verify shortly." : "We have received your payment details. Our team will verify shortly.",
        highlight: `Order ID: ${doc._id}`,
        blocks: [
          { label: "Payment Method", value: codAdvance20 ? "COD (20% via Manual UPI/Bank)" : "Manual (UPI/Bank)" },
          { label: "Amount Submitted", value: `₹${Number(amountPaid || 0).toLocaleString("en-IN")}` },
          { label: "UTR", value: String(utr || "-") },
          { label: "Status", value: "Pending Admin Approval" }
        ]
      });
      if (to) await sendEmail({ to, subject: `Payment submitted - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
    } catch {}
    return res.json({ success: true, orderId: doc._id });
  } catch {
    return res.status(500).json({ error: "manual_submit_failed" });
  }
});

// Admin approve manual payment
router.patch("/:id/approve-manual", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.paymentMethod === "MANUAL") {
    order.paymentStatus = "PAID";
    order.status = "CONFIRMED";
  } else if (order.paymentMethod === "COD_20") {
    order.paymentStatus = "PARTIAL";
    order.status = "CONFIRMED";
    order.advancePaidAmount = order.manualPayment?.amountPaid || 0;
  } else {
    return res.status(400).json({ error: "not_manual_order" });
  }

  await order.save();

  // Trigger automatic billing only for full online payments (MANUAL in this case)
  if (order.paymentMethod === "MANUAL") {
    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
        paymentType: "MANUAL",
        existingOrderId: order._id
      });
    } catch (err) {
      console.error("Auto-billing failed after manual approval:", err);
    }
  }

  // Auto-create shipment after approval
  try {
    if (order.status === "CONFIRMED") {
      // Optional: compute free shipping
      const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
      const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
      const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 0);
      const weight = Number(process.env.DELHIVERY_PACKAGE_WEIGHT || 1);
      const variable = perKg * weight;
      const amt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
      order.shipping_charge = amt;
      order.shipping_discount = amt;
      await order.save();

      const created = await tryCreateDelhiveryShipment(order);
      if (!created) {
        order.shipment_status = "CREATION_FAILED";
        await order.save();
      }
    }
  } catch (err) {
    console.error("Auto-shipment failed after manual approval:", err);
  }

  try {
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const html = renderMail({
      heading: order.paymentMethod === "COD_20" ? "COD Advance Approved" : "Payment Approved",
      subheading: order.paymentMethod === "COD_20" ? "Your 20% COD advance has been verified. We are confirming your order." : "Your payment has been verified. We are confirming your order.",
      highlight: `Order ID: ${order._id}`,
      blocks: [
        { label: "Payment Method", value: order.paymentMethod === "COD_20" ? "COD (20% via Manual UPI/Bank)" : "Manual (UPI/Bank)" },
        { label: "Current Status", value: "CONFIRMED" }
      ]
    });
    if (to) await sendEmail({ to, subject: `Payment approved - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
  } catch {}

  try {
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "PAYMENT_VERIFICATION",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Manual payment approved for ${order.paymentMethod}`,
      after: { paymentStatus: order.paymentStatus, status: order.status }
    });
  } catch (err) {
    console.error("Failed to create audit log:", err);
  }

  return res.json({ success: true });
});

// Admin reject manual payment
router.patch("/:id/reject-manual", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.paymentMethod !== "MANUAL" && order.paymentMethod !== "COD_20") return res.status(400).json({ error: "not_manual_order" });
  
  order.paymentStatus = "FAILED";
  order.status = "CANCELLED";
  await order.save();

  try {
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const html = renderMail({
      heading: "Payment Rejected",
      subheading: "We could not verify your payment. Please contact support or resubmit.",
      highlight: `Order ID: ${order._id}`,
      blocks: [
        { label: "Payment Method", value: order.paymentMethod },
        { label: "Current Status", value: "CANCELLED" }
      ]
    });
    if (to) await sendEmail({ to, subject: `Payment rejected - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
  } catch {}

  try {
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "PAYMENT_VERIFICATION",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Manual payment rejected for ${order.paymentMethod}`,
      after: { paymentStatus: order.paymentStatus, status: order.status }
    });
  } catch (err) {
    console.error("Failed to create audit log:", err);
  }

  return res.json({ success: true });
});

// Get manual payment verification history
router.get("/payment-history", auth, requireRole("admin"), async (req, res) => {
  try {
    const logs = await AuditLog.find({ type: "PAYMENT_VERIFICATION" })
      .sort({ createdAt: -1 })
      .limit(50);
    
    // Enrich with order details
    const orderIds = logs.map(l => l.entityId);
    const orders = await Order.find({ _id: { $in: orderIds } }).select("customer totalEstimate paymentMethod manualPayment");
    
    const enriched = logs.map(log => {
      const order = orders.find(o => o._id.toString() === log.entityId);
      return {
        ...log.toObject(),
        order: order || null
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: "failed_to_fetch_history" });
  }
});

// Finalize COD and generate bill (admin)
router.patch("/:id/finalize-cod", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.paymentMethod !== "COD_20") return res.status(400).json({ error: "not_cod_order" });
  if (order.paymentStatus !== "PARTIAL") return res.status(400).json({ error: "advance_not_paid" });

  order.paymentStatus = "PAID";
  await order.save();

  try {
    await createBillFromData({
      customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
      items: order.items.map(it => ({ product: it.product, variantId: it.variantId, quantity: it.quantity })),
      paymentType: "CASH",
      existingOrderId: order._id
    });
  } catch (err) {
    console.error("Billing failed after COD finalize:", err);
  }
  res.json({ success: true });
});

// Admin approves Manual/Offline Payment
router.patch("/:id/approve-cash", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  
  // Accept both CASH and COD_20 (for advance verification)
  if (!["CASH", "COD_20"].includes(order.paymentMethod)) {
    return res.status(400).json({ error: "not_a_manual_or_cod_order" });
  }

  if (order.paymentMethod === "CASH") {
    order.paymentStatus = "PAID";
  } else {
    // For COD_20, it's PARTIAL since only advance is paid
    order.paymentStatus = "PARTIAL";
  }
  
  order.status = "CONFIRMED";
  await order.save();

  // Trigger billing immediately upon confirmation
  try {
    await createBillFromData({
      customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
      items: order.items.map(it => ({ 
        product: it.product, 
        quantity: it.quantity,
        variantId: it.variantId 
      })),
      paymentType: order.paymentMethod,
      existingOrderId: order._id
    });
  } catch (err) {
    console.error("Billing failed after approval:", err);
  }
  
  res.json({ success: true, order });
});

router.get("/my-orders", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "missing_phone" });
  const items = await Order.find({ "customer.phone": phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/my", auth, requireRole("customer"), async (req, res) => {
  const cust = await Customer.findById(req.user.id).select("phone email");
  if (!cust) return res.status(404).json({ error: "not_found" });
  const items = await Order.find({ "customer.phone": cust.phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const status = req.query.status;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const filter = {};
  if (status) {
    filter.status = status;
  } else {
    // By default, exclude orders waiting for manual payment verification
    filter.status = { $ne: "PENDING_ADMIN_APPROVAL" };
  }
  const items = await Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json({ page, limit, count: items.length, items });
});

router.get("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const doc = await Order.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "not_found" });
  res.json(doc);
});

// Admin update status/LRN
router.patch("/:id/status", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { status, lrn } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });

  if (lrn !== undefined) {
    order.lrn = lrn;
  }

  if (status) {
    const allowed = new Set(["NEW", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "FULFILLED"]);
    if (!allowed.has(status)) return res.status(400).json({ error: "invalid_status" });
    const okTransitions = {
      NEW: new Set(["CONFIRMED", "CANCELLED"]),
      PENDING_CASH_APPROVAL: new Set(["CONFIRMED", "CANCELLED"]),
      CONFIRMED: new Set(["SHIPPED", "CANCELLED"]),
      SHIPPED: new Set(["DELIVERED", "RETURNED"]),
      DELIVERED: new Set(["FULFILLED", "RETURNED"]),
      CANCELLED: new Set([]),
      RETURNED: new Set([]),
      FULFILLED: new Set([])
    };
    const curr = order.status;
    if (!okTransitions[curr] || !okTransitions[curr].has(status)) return res.status(400).json({ error: "invalid_transition" });
    order.status = status;
    try {
      await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Status ${curr} → ${status}` });
    } catch {}
  }

  const updated = await order.save();
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

// Customer delivery feedback (rating only after order fulfilled)
router.post("/:id/feedback", auth, requireRole("customer"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const r = Number(req.body?.rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: "invalid_rating" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  const cust = await Customer.findById(req.user.id).select("phone");
  if (!cust || cust.phone !== order.customer.phone) return res.status(403).json({ error: "forbidden" });
  if (order.status !== "FULFILLED") return res.status(400).json({ error: "not_delivered" });
  order.feedbackRating = r;
  await order.save();
  res.json({ success: true, feedbackRating: r });
});

// Admin: mark as packed
router.patch("/:id/pack", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.status = "PACKED";
  await order.save();
  res.json({ success: true, order });
});

// Admin: create/update shipment (manual)
router.patch("/:id/ship", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { provider, waybill, trackingUrl } = req.body || {};
  if (!provider || !waybill) return res.status(400).json({ error: "missing_fields" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.provider = String(provider);
  order.shipping.waybill = String(waybill);
  order.shipping.trackingUrl = trackingUrl || order.shipping.trackingUrl || "";
  order.shipping.status = "SHIPPED";
  const prev = order.status;
  if (prev !== "CONFIRMED" && prev !== "SHIPPED") return res.status(400).json({ error: "invalid_transition" });
  order.status = "SHIPPED";
  await order.save();
  try {
    await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Status ${prev} → SHIPPED` });
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const html = renderMail({
      heading: "Your Order is Shipped",
      subheading: "We’ve handed your package to our courier partner.",
      highlight: `Order ID: ${order._id}`,
      blocks: [
        { label: "Courier", value: `${order.shipping.provider} • ${order.shipping.waybill}` },
        { label: "Track", value: order.shipping.trackingUrl || "Tracking link will update shortly" },
        { label: "Current Status", value: "SHIPPED" }
      ]
    });
    if (to) await sendEmail({ to, subject: `Order shipped - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
  } catch {}
  res.json({ success: true, order });
});

// Admin: mark delivered and close
router.patch("/:id/deliver", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  if (order.status === "CANCELLED") return res.status(400).json({ error: "cancelled_order" });
  order.shipping = order.shipping || {};
  order.shipping.status = "DELIVERED";
  const prev2 = order.status;
  if (prev2 !== "SHIPPED") return res.status(400).json({ error: "invalid_transition" });
  order.status = "DELIVERED";
  await order.save();
  try {
    await AuditLog.create({ actorId: req.user?.id || "", actorRole: req.user?.role || "", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: `Status ${prev2} → DELIVERED` });
    const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const html = renderMail({
      heading: "Delivered",
      subheading: "Your order has been delivered. We hope you enjoy your purchase.",
      highlight: `Order ID: ${order._id}`,
      blocks: [
        { label: "Final Status", value: "DELIVERED" },
        { label: "Waybill", value: order.shipping?.waybill || "-" }
      ]
    });
    if (to) await sendEmail({ to, subject: `Order delivered - ${process.env.COMPANY_NAME || "Click2Kart"}`, html });
  } catch {}
  res.json({ success: true, order });
});

// Admin: Manual trigger Delhivery Standard (B2C) shipment
router.post("/:id/delhivery/standard-shipment", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  
  try {
    const result = await tryCreateDelhiveryShipment(order);
    return res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message || "shipment_creation_failed" });
  }
});

export default router;
