import fetch from "node-fetch";
import axios from "axios";
import Settings from "../models/Settings.js";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const base = () => _sanitize(process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

export const checkServiceability = async (pincode) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const url = `${b}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
  const res = await fetch(url, { headers: authHeader() });
  const data = await res.json();
  const hasCodes = Array.isArray(data) ? data.length > 0 : Array.isArray(data?.delivery_codes) ? data.delivery_codes.length > 0 : !!data;
  return {
    pincode,
    delivery_available: hasCodes,
    cod_available: hasCodes
  };
};

export const getDims = () => ({
  weight: Number(process.env.DELHIVERY_PACKAGE_WEIGHT || 1),
  length: Number(process.env.DELHIVERY_PACKAGE_LENGTH || 10),
  breadth: Number(process.env.DELHIVERY_PACKAGE_WIDTH || 10),
  height: Number(process.env.DELHIVERY_PACKAGE_HEIGHT || 10)
});

/**
 * Creates Delhivery shipment for an order if deliveryChannel is DELHIVERY
 */
export const tryCreateDelhiveryShipment = async (order) => {
  try {
    // DO NOT send LOCAL_DELIVERY orders to Delhivery
    if (order.deliveryChannel === "LOCAL_DELIVERY") {
      console.log(`Order #${order._id} is LOCAL_DELIVERY. Skipping Delhivery shipment creation.`);
      return null;
    }

    const tkn = token();
    const bs = base();
    if (!tkn || !bs) throw new Error("Delhivery not configured");

    const settings = await Settings.getDefaultSettings();
    const PICKUP_LOCATION_NAME = String(settings.pickupName || process.env.DELHIVERY_PICKUP_LOCATION || "").trim();
    if (!PICKUP_LOCATION_NAME) throw new Error("DELHIVERY_PICKUP_LOCATION is not configured in environment or settings");

    // Address extraction: Priority 1: order.shippingAddress, Priority 2: Customer.kyc
    let addr = order.shippingAddress || {};
    if (!addr.pincode || !addr.line1) {
      const cust = await Customer.findOne({ phone: order.customer.phone });
      if (cust && cust.kyc) {
        addr = {
          line1: cust.kyc.addressLine1 || cust.address || "",
          line2: cust.kyc.addressLine2 || "",
          city: cust.kyc.city || "",
          state: cust.kyc.state || "",
          pincode: cust.kyc.pincode || ""
        };
      }
    }

    if (!addr.pincode) throw new Error("Customer pincode is missing");
    if (!addr.line1) throw new Error("Customer address is missing");

    const isPrepaid = order.paymentMethod === "RAZORPAY" || order.paymentMethod === "MANUAL" || order.paymentMethod === "CREDIT";
    const paymentMode = isPrepaid ? "Prepaid" : "COD";
    const codAmount = paymentMode === "COD" ? Math.round(order.codDueAmount || 0) : 0;

    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });

    let totalWeightGrams = 0;
    let totalQuantity = 0;
    (order.items || []).forEach(it => {
      const p = products.find(prod => prod._id.toString() === it.product.toString());
      let itemWeight = 0;
      if (p) {
        if (it.variantSku) {
          const variant = p.variants?.find(v => v.sku === it.variantSku);
          itemWeight = variant?.weight || p.weight || 0;
        } else {
          itemWeight = p.weight || 0;
        }
      }
      totalWeightGrams += (itemWeight * it.quantity);
      totalQuantity += it.quantity;
    });

    const weightKg = totalWeightGrams > 0 ? (totalWeightGrams / 1000) : 0.5;
    const dims = getDims();
    const cleanPhone = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);

    const cleanDesc = (order.items || [])
      .map(i => i.name)
      .join(", ")
      .replace(/[^\x00-\x7F]/g, " ")
      .replace(/["']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);

    const shipment = {
      name: String(order.customer.name),
      add: String(addr.line1),
      address2: String(addr.line2 || ""),
      city: String(addr.city),
      state: String(addr.state),
      country: "India",
      phone: String(cleanPhone),
      pin: String(addr.pincode),
      order: String(order._id.toString()),
      payment_mode: paymentMode,
      products_desc: cleanDesc,
      cod_amount: Number(codAmount),
      total_amount: Number(Math.round(order.totalEstimate || 0)),
      quantity: Number(totalQuantity),
      weight: Number(weightKg),
      length: Number(dims.length || 10),
      breadth: Number(dims.breadth || 10),
      height: Number(dims.height || 10)
    };

    const finalPayload = {
      pickup_location: {
        name: PICKUP_LOCATION_NAME,
        add: settings.pickupLine1 || "",
        address2: settings.pickupLine2 || "",
        city: settings.pickupCity || "",
        state: settings.pickupState || "",
        pin: settings.pickupPincode || "",
        country: settings.pickupCountry || "India",
        phone: settings.pickupPhone || ""
      },
      shipments: [shipment]
    };

    const bodyStr = "format=json&data=" + encodeURIComponent(JSON.stringify(finalPayload));
    const { data } = await axios.post(`${bs}/api/cmu/create.json`, bodyStr, {
      headers: {
        Authorization: `Token ${tkn}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const pkg = data?.packages?.[0] || data?.shipment_data?.[0];
    const wbFinal = pkg?.waybill || data?.waybill;
    const success = (data?.success === true || data?.status === "Success") && !!wbFinal;

    if (success && wbFinal) {
      order.shipping = {
        provider: "DELHIVERY",
        waybill: String(wbFinal),
        status: pkg?.status?.status || pkg?.status || "CREATED",
        trackingUrl: `https://www.delhivery.com/track/package/${wbFinal}`
      };
      order.shippingAddress = addr;
      order.pickupAddress = {
        line1: settings.pickupLine1 || "",
        line2: settings.pickupLine2 || "",
        city: settings.pickupCity || "",
        state: settings.pickupState || "",
        pincode: settings.pickupPincode || "",
        country: settings.pickupCountry || "India"
      };
      order.pickupLocationName = PICKUP_LOCATION_NAME;
      order.sellerGst = settings.companyGst || "";
      order.status = "SHIPPED";
      await order.save();
      return order;
    }

    return null;
  } catch (err) {
    console.error("Delhivery shipment error:", err?.response?.data || err?.message || err);
    return null;
  }
};
