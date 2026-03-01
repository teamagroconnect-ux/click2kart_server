import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import { auth, requireRole } from "../middleware/auth.js";
import fetch from "node-fetch";

const router = express.Router();

router.post("/delhivery/create", auth, requireRole("admin"), async (req, res) => {
  const { orderId, address } = req.body || {};
  if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: "not_found" });
  const token = process.env.DELHIVERY_TOKEN;
  const url = process.env.DELHIVERY_CREATE_URL;
  let waybill = "TEMPWB" + Math.floor(Math.random() * 1e6);
  let trackingUrl = `https://www.delhivery.com/track/package/${waybill}`;
  let status = "CREATED";
  if (token && url) {
    try {
      const payload = {
        consignee: { name: order.customer.name, phone: order.customer.phone },
        shipment: {
          waybill: "",
          order: order._id.toString(),
          product_type: "B2C",
          cod_amount: 0,
          total_amount: order.totalEstimate
        },
        return_address: {},
        pickup_location: {},
        delivery_address: {
          add: address?.line1 || "",
          city: address?.city || "",
          state: address?.state || "",
          pincode: address?.pincode || ""
        }
      };
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Token ${token}` }, body: JSON.stringify(payload) });
      const data = await resp.json();
      waybill = data?.waybill || waybill;
      trackingUrl = data?.tracking_url || trackingUrl;
      status = data?.status || status;
    } catch {}
  }
  order.shipping = { provider: "DELHIVERY", waybill, status, trackingUrl };
  order.shippingAddress = { line1: address?.line1 || "", line2: address?.line2 || "", city: address?.city || "", state: address?.state || "", pincode: address?.pincode || "" };
  await order.save();
  res.json({ waybill, trackingUrl, status });
});

router.get("/delhivery/track/:waybill", async (req, res) => {
  const waybill = req.params.waybill;
  const url = process.env.DELHIVERY_TRACK_URL;
  const token = process.env.DELHIVERY_TOKEN;
  if (url && token) {
    try {
      const resp = await fetch(`${url}?wb=${encodeURIComponent(waybill)}`, { headers: { "Authorization": `Token ${token}` } });
      const data = await resp.json();
      return res.json(data);
    } catch {}
  }
  res.json({ waybill, status: "IN_TRANSIT", last_update: new Date().toISOString() });
});

export default router;
