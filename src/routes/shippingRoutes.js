import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import { auth, requireRole } from "../middleware/auth.js";
import fetch from "node-fetch";

const router = express.Router();

const getBase = () => (process.env.DELHIVERY_BASE_URL || "").replace(/\/+$/, "");
const getToken = () => (process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");

// Serviceability: pincode check
router.get("/delhivery/serviceability", async (req, res) => {
  const pincode = String(req.query.pincode || "").trim();
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  const base = getBase();
  const token = getToken();
  if (!base || !token) return res.status(500).json({ error: "delhivery_not_configured" });
  try {
    const url = `${base}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
    const resp = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    const data = await resp.json();
    const entry = Array.isArray(data) ? data.find((x) => String(x.pin) === pincode) : (data?.delivery_codes?.[0] || null);
    const delivery = !!(entry?.is_oda === false || entry?.pre_paid || entry?.delivery);
    const cod = !!(entry?.cod || entry?.cash);
    res.json({ pincode, delivery_available: delivery, cod_available: cod, raw: data });
  } catch (e) {
    res.status(502).json({ error: "delhivery_service_unavailable" });
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

export default router;
