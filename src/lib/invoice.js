import Bill from "../models/Bill.js";
import Counter from "../models/Counter.js";

export const computeTotals = (products, items) => {
  const enriched = [];
  let subtotal = 0;
  let gstTotal = 0;
  const map = new Map();
  for (const it of items) {
    const p = products.find((x) => x._id.toString() === it.productId);
    if (!p) throw new Error("product_not_found");
    const qty = Number(it.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("invalid_quantity");

    const variant = it.variantId ? (p.variants || []).find(v => v._id.toString() === it.variantId) : null;
    let effectivePrice = variant?.price ?? p.price;
    if (!variant && p.bulkDiscountQuantity > 0 && qty >= p.bulkDiscountQuantity) {
      effectivePrice = Math.max(0, p.price - (p.bulkDiscountPriceReduction || 0));
    }

    const lineSubtotal = effectivePrice * qty;
    const lineGst = Number((((lineSubtotal * (p.gst || 0)) / 100)).toFixed(2));
    const lineTotal = lineSubtotal + lineGst;
    subtotal += lineSubtotal;
    gstTotal += lineGst;
    const rate = p.gst || 0;
    map.set(rate, (map.get(rate) || 0) + lineGst);
    const attrText = variant ? Object.entries(variant.attributes || {}).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ") : "";
    enriched.push({
      product: p._id,
      variantId: variant ? variant._id : undefined,
      name: variant ? `${p.name} (${attrText})` : p.name,
      category: p.category || "General",
      price: effectivePrice,
      gst: rate,
      quantity: qty,
      lineSubtotal,
      lineGst,
      lineTotal
    });
  }
  const gstBreakdown = [...map.entries()].map(([rate, amount]) => ({ rate, amount }));
  const total = subtotal + gstTotal;
  return { items: enriched, subtotal, gstTotal, total, gstBreakdown };
};

export const generateInvoiceNumber = async () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const key = `invoice:${y}${m}${day}`;
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { upsert: true, new: true }
  );
  const seq = String(doc.value).padStart(4, "0");
  return `INV-${y}${m}${day}-${seq}`;
};
