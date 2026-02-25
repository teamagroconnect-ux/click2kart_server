import Bill from "../models/Bill.js";

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

    let effectivePrice = p.price;
    if (p.bulkDiscountQuantity > 0 && qty >= p.bulkDiscountQuantity) {
      effectivePrice = Math.max(0, p.price - (p.bulkDiscountPriceReduction || 0));
    }

    const lineSubtotal = effectivePrice * qty;
    const lineGst = Number((((lineSubtotal * (p.gst || 0)) / 100)).toFixed(2));
    const lineTotal = lineSubtotal + lineGst;
    subtotal += lineSubtotal;
    gstTotal += lineGst;
    const rate = p.gst || 0;
    map.set(rate, (map.get(rate) || 0) + lineGst);
    enriched.push({
      product: p._id,
      name: p.name,
      category: p.category || "General",
      price: p.price,
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
  let attempt = 0;
  while (attempt < 5) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const num = `INV-${y}${m}${day}-${rand}`;
    const exists = await Bill.findOne({ invoiceNumber: num }).lean();
    if (!exists) return num;
    attempt += 1;
  }
  return `INV-${y}${m}${day}-${Date.now().toString().slice(-4)}`;
};
