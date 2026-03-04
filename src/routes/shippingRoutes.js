import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import { auth, requireRole } from "../middleware/auth.js";
import fetch from "node-fetch";
import PDFDocument from "pdfkit";

const router = express.Router();

const getBase = () => (process.env.DELHIVERY_BASE_URL || "").replace(/\/+$/, "");
const getToken = () => (process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const getLtlBase = () => (process.env.DELHIVERY_LTL_BASE_URL || "").replace(/\/+$/, "");

router.get("/eta", async (req, res) => {
  const origin = String(req.query.origin || process.env.ORIGIN_PIN || "").trim();
  const dest = String(req.query.dest || "").trim();
  if (!dest) return res.status(400).json({ error: "missing_params" });
  try {
    const q = new URLSearchParams({ pincode: dest });
    const resp = await fetch(`${req.protocol}://${req.get("host")}/api/shipping/delhivery/serviceability?${q.toString()}`);
    const data = await resp.json();
    if (data?.etaStart && data?.etaEnd) return res.json({ origin, dest, etaStart: data.etaStart, etaEnd: data.etaEnd });
  } catch {}
  const now = new Date();
  const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
  return res.json({ origin, dest, etaStart: add(now, 3).toISOString(), etaEnd: add(now, 6).toISOString() });
});

router.post("/estimate", async (req, res) => {
  const { origin, destination, weight } = req.body || {};
  const w = Math.max(0, Number(weight || 0));
  const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
  const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
  const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 0);
  const variable = perKg * w;
  const total = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
  res.json({
    origin: String(origin || ""),
    destination: String(destination || ""),
    weight: w,
    breakdown: { base, perKg, variable, minCharge },
    total
  });
});

// Serviceability: pincode check
router.get("/delhivery/serviceability", async (req, res) => {
  const pincode = String(req.query.pincode || "").trim();
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  const token = getToken();
  if (!token) return res.status(500).json({ error: "delhivery_not_configured" });
  try {
    // Prefer LTL pincode-service if configured
    const ltlBase = getLtlBase();
    let delivery = false, cod = false, etaDaysMin = null, etaDaysMax = null;
    if (ltlBase) {
      const ltlUrl = `${ltlBase}/pincode-service/${encodeURIComponent(pincode)}`;
      const ltlResp = await fetch(ltlUrl, { headers: { Authorization: `Token ${token}` } });
      const ltlData = await ltlResp.json();
      const svc = ltlData?.data || ltlData || {};
      delivery = !!(svc.serviceable ?? svc.is_serviceable ?? svc.delivery ?? svc.pre_paid);
      cod = !!(svc.cod ?? svc.cod_serviceable ?? svc.cash);
      const mins = [svc.min_tat, svc.tat_min, svc.eta_min_days, svc.eta_min];
      const maxs = [svc.max_tat, svc.tat_max, svc.eta_max_days, svc.eta_max];
      for (const v of mins) { const n = Number(v); if (Number.isFinite(n) && n > 0) { etaDaysMin = Math.round(n); break; } }
      for (const v of maxs) { const n = Number(v); if (Number.isFinite(n) && n > 0) { etaDaysMax = Math.round(n); break; } }
      if (etaDaysMin == null && (svc.tat || svc.eta || svc.days)) {
        const n = Number(svc.tat ?? svc.eta ?? svc.days);
        if (Number.isFinite(n) && n > 0) { etaDaysMin = n; etaDaysMax = n + 2; }
      }
    } else {
      const base = getBase();
      if (!base) return res.status(500).json({ error: "delhivery_not_configured" });
      const url = `${base}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
      const resp = await fetch(url, { headers: { Authorization: `Token ${token}` } });
      const data = await resp.json();
      const entry = Array.isArray(data) ? data.find((x) => String(x.pin) === pincode) : (data?.delivery_codes?.[0] || null);
      delivery = !!(entry?.is_oda === false || entry?.pre_paid || entry?.delivery || entry?.serviceable);
      cod = !!(entry?.cod || entry?.cash || entry?.cod_serviceable);
      let tatDays = null;
      const possibleTat = [entry?.tat, entry?.delivery_tat, entry?.etd, entry?.edd, entry?.promise, entry?.commitment, entry?.lead_time];
      for (const v of possibleTat) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) { tatDays = Math.round(n); break; }
      }
      if (tatDays != null) { etaDaysMin = Math.max(1, tatDays); etaDaysMax = tatDays + 2; }
    }
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    const low = etaDaysMin != null ? Math.max(1, etaDaysMin) : 3;
    const high = etaDaysMax != null ? Math.max(low, etaDaysMax) : 6;
    const etaStart = add(now, low).toISOString();
    const etaEnd = add(now, high).toISOString();
    res.json({ pincode, delivery_available: delivery, cod_available: cod, etaStart, etaEnd });
  } catch (e) {
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    res.status(200).json({
      pincode,
      delivery_available: false,
      cod_available: false,
      etaStart: add(now, 4).toISOString(),
      etaEnd: add(now, 7).toISOString()
    });
  }
});

// Generate waybill
router.post("/delhivery/waybill", auth, requireRole("admin"), async (req, res) => {
  const base = getBase();
  const token = getToken();
  if (!base || !token) return res.status(500).json({ error: "delhivery_not_configured" });
  try {
    const count = Math.max(1, Number(req.body?.count || 1));
    const payload = { format: "json", count };
    const resp = await fetch(`${base}/waybill/api/bulk/json/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    const waybills = data?.waybill || data?.waybills || data?.packages || [];
    res.json({ waybills });
  } catch (e) {
    res.status(502).json({ error: "waybill_generation_failed" });
  }
});

router.post("/delhivery/create", auth, requireRole("admin"), async (req, res) => {
  const { orderId, address, waybill: providedWaybill } = req.body || {};
  if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: "not_found" });
  const base = getBase();
  const token = getToken();
  const pickup = process.env.DELHIVERY_PICKUP_LOCATION || "Click2Kart Warehouse";
  const dims = {
    weight: Number(process.env.DELHIVERY_PACKAGE_WEIGHT || 1),
    length: Number(process.env.DELHIVERY_PACKAGE_LENGTH || 10),
    breadth: Number(process.env.DELHIVERY_PACKAGE_WIDTH || 10),
    height: Number(process.env.DELHIVERY_PACKAGE_HEIGHT || 10)
  };

  let waybill = providedWaybill || ("TEMPWB" + Math.floor(Math.random() * 1e6));
  let trackingUrl = `https://www.delhivery.com/track/package/${waybill}`;
  let status = "CREATED";

  if (base && token) {
    try {
      // Generate waybill if not provided
      if (!providedWaybill) {
        try {
          const wbResp = await fetch(`${base}/waybill/api/bulk/json/`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
            body: JSON.stringify({ format: "json", count: 1 })
          });
          const wbData = await wbResp.json();
          const wb = Array.isArray(wbData?.waybill) ? wbData.waybill[0] : (wbData?.waybill || wbData?.waybills?.[0]);
          if (wb) waybill = wb;
        } catch {}
      }

      const paymentMode = order.paymentMethod === "RAZORPAY" ? "Prepaid" : "COD";
      const codAmount = paymentMode === "COD" ? Number(order.codDueAmount || order.totalEstimate || 0).toFixed(2) : "0.00";

      // Create Shipment
      const payload = {
        pickup_location: pickup,
        shipments: [
          {
            waybill,
            name: order.customer.name,
            add: address?.line1 || "",
            address2: address?.line2 || "",
            city: address?.city || "",
            state: address?.state || "",
            country: "India",
            phone: order.customer.phone,
            pin: address?.pincode || "",
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
      waybill = data?.packages?.[0]?.waybill || data?.waybill || waybill;
      trackingUrl = `https://www.delhivery.com/track/package/${waybill}`;
      status = data?.packages?.[0]?.status?.status || data?.status || status;
    } catch {}
  }
  order.shipping = { provider: "DELHIVERY", waybill, status, trackingUrl };
  order.shippingAddress = { line1: address?.line1 || "", line2: address?.line2 || "", city: address?.city || "", state: address?.state || "", pincode: address?.pincode || "" };
  await order.save();
  res.json({ waybill, trackingUrl, status });
});

router.get("/delhivery/track/:waybill", async (req, res) => {
  const waybill = req.params.waybill;
  const base = getBase();
  const token = getToken();
  if (base && token) {
    try {
      const resp = await fetch(`${base}/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`, { headers: { Authorization: `Token ${token}` } });
      const data = await resp.json();
      return res.json(data);
    } catch {}
  }
  res.json({ waybill, status: "IN_TRANSIT", last_update: new Date().toISOString() });
});

router.get("/delhivery/label/:waybill", async (req, res) => {
  const waybill = req.params.waybill;
  const order = await Order.findOne({ "shipping.waybill": waybill }).lean();
  const doc = new PDFDocument({ margin: 24, size: "A6" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
  doc.pipe(res);
  doc.fontSize(16).text("Shipping Label", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Waybill: ${waybill}`);
  if (order) {
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Name: ${order.customer?.name || ""}`);
    doc.fontSize(10).text(`Phone: ${order.customer?.phone || ""}`);
    const a = order.shippingAddress || {};
    const line1 = [a.line1, a.line2].filter(Boolean).join(", ");
    doc.moveDown(0.5);
    doc.fontSize(10).text(line1);
    doc.fontSize(10).text(`${a.city || ""}, ${a.state || ""} - ${a.pincode || ""}`);
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Items: ${order.items?.length || 0}`);
    doc.fontSize(12).text(`Amount: ₹${Number(order.totalEstimate || 0).toLocaleString("en-IN")}`);
  }
  doc.end();
});

router.post("/delhivery/pickup", auth, requireRole("admin"), async (req, res) => {
  const apiUrl = process.env.DELHIVERY_PICKUP_API_URL || "";
  const token = getToken();
  const payload = req.body || {};
  if (!token) return res.status(500).json({ error: "delhivery_not_configured" });
  if (!apiUrl) return res.json({ accepted: true, reference: `SIM-${Date.now()}`, note: "pickup_api_not_configured" });
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "pickup_failed" });
  }
});

// Cancel Shipment
router.post("/delhivery/cancel", auth, requireRole("admin"), async (req, res) => {
  const { waybill, reason } = req.body || {};
  if (!waybill) return res.status(400).json({ error: "missing_waybill" });
  const base = getBase();
  const token = getToken();
  if (!base || !token) return res.status(500).json({ error: "delhivery_not_configured" });
  try {
    const payload = { waybill, status: "Cancelled", remarks: reason || "Order cancelled" };
    const resp = await fetch(`${base}/api/p/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    res.json({ success: true, data });
  } catch (e) {
    res.status(502).json({ error: "cancel_failed" });
  }
});

router.get("/delhivery/pod/:waybill", async (req, res) => {
  const url = process.env.DELHIVERY_POD_URL || "";
  const token = getToken();
  const waybill = req.params.waybill;
  if (!url || !token) return res.status(404).json({ error: "pod_not_configured" });
  try {
    const resp = await fetch(`${url.replace(/\/+$/, "")}/${encodeURIComponent(waybill)}`, { headers: { Authorization: `Token ${token}` } });
    const buf = await resp.arrayBuffer();
    res.setHeader("Content-Type", resp.headers.get("content-type") || "application/pdf");
    res.send(Buffer.from(buf));
  } catch {
    res.status(502).json({ error: "pod_fetch_failed" });
  }
});

export default router;
