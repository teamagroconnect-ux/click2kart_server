import fetch from "node-fetch";
import Order from "../models/Order.js";

const sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const getBase = () => sanitize(process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com");
const getToken = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");

/**
 * Synchronizes tracking status for all active Delhivery orders
 * Used by the scheduled cron job (12 AM & 12 PM) and admin manual sync
 */
export const syncActiveDelhiveryOrders = async () => {
  const base = getBase();
  const token = getToken();

  if (!base || !token) {
    console.warn("[DelhiverySync] Delhivery credentials not configured. Skipping sync.");
    return { success: false, reason: "delhivery_not_configured", totalActive: 0, updatedCount: 0 };
  }

  // Active orders with a Delhivery waybill that have not reached a terminal state
  const activeOrders = await Order.find({
    "shipping.waybill": { $exists: true, $ne: "" },
    deliveryChannel: { $ne: "LOCAL_DELIVERY" },
    status: { $nin: ["DELIVERED", "FULFILLED", "CANCELLED", "RETURNED"] }
  });

  if (activeOrders.length === 0) {
    return { success: true, totalActive: 0, updatedCount: 0, details: [] };
  }

  let updatedCount = 0;
  const details = [];

  for (const order of activeOrders) {
    const waybill = String(order.shipping.waybill).trim();
    if (!waybill) continue;

    try {
      const url = `${base}/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Token ${token}` },
        timeout: 10000
      });
      const data = await resp.json();

      const shipment = data?.ShipmentData?.[0]?.Shipment || data?.packages?.[0] || data;
      const rawStatus = String(
        shipment?.Status?.Status ||
        shipment?.status?.status ||
        shipment?.status ||
        ""
      ).trim().toUpperCase();

      if (!rawStatus) continue;

      let targetStatus = null;
      let targetShippingStatus = null;

      if (rawStatus.includes("DELIVERED")) {
        targetStatus = "DELIVERED";
        targetShippingStatus = "DELIVERED";
      } else if (rawStatus.includes("OUT FOR DELIVERY") || rawStatus.includes("OUT_FOR_DELIVERY")) {
        targetStatus = "OUT_FOR_DELIVERY";
        targetShippingStatus = "OUT_FOR_DELIVERY";
      } else if (rawStatus.includes("IN TRANSIT") || rawStatus.includes("INTRANSIT") || rawStatus.includes("DISPATCH") || rawStatus.includes("SHIPPED")) {
        targetStatus = "SHIPPED";
        targetShippingStatus = "IN_TRANSIT";
      } else if (rawStatus.includes("RTO") || rawStatus.includes("RETURN")) {
        targetStatus = "RETURNED";
        targetShippingStatus = "RTO";
      } else if (rawStatus.includes("CANCEL")) {
        targetStatus = "CANCELLED";
        targetShippingStatus = "CANCELLED";
      }

      if (targetStatus && (order.status !== targetStatus || order.shipping?.status !== targetShippingStatus)) {
        const prevStatus = order.status;
        order.status = targetStatus;
        order.shipping = order.shipping || {};
        order.shipping.status = targetShippingStatus;
        if (!order.shipping.trackingUrl) {
          order.shipping.trackingUrl = `https://track.delhivery.com/track/package/${waybill}`;
        }
        await order.save();
        updatedCount++;
        details.push({
          orderId: order._id,
          waybill,
          from: prevStatus,
          to: targetStatus,
          shippingStatus: targetShippingStatus
        });
      }
    } catch (err) {
      console.error(`[DelhiverySync] Error syncing waybill ${waybill}:`, err.message);
    }
  }

  return {
    success: true,
    totalActive: activeOrders.length,
    updatedCount,
    details
  };
};
