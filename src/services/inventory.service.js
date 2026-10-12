import Product from "../models/Product.js";
import StockTxn from "../models/StockTxn.js";
import AuditLog from "../models/AuditLog.js";
import { bumpCacheVersion } from "../lib/redis.js";

/**
 * Deducts inventory when an order is confirmed or placed.
 * Creates a "SOLD" StockTxn log and AuditLog for full tracking.
 * Idempotent: will not deduct multiple times if order.stockDeducted is true.
 *
 * @param {Object} order - Mongoose Order document or object with items
 * @param {Object} actor - User / system performing the action { id, role }
 */
export async function deductInventoryForOrder(order, actor = {}) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    return { success: false, error: "no_items" };
  }

  // Prevent duplicate deductions
  if (order.stockDeducted) {
    return { success: true, alreadyDeducted: true };
  }

  const orderShortId = order._id.toString().slice(-6).toUpperCase();
  const customerName = order.customer?.name || "Customer";

  for (const item of order.items) {
    const qty = Number(item.quantity || 0);
    if (qty <= 0) continue;

    const productId = item.product || item.productId;
    const p = await Product.findById(productId);
    if (!p) continue;

    let before = 0;
    let after = 0;
    const sku = item.variantSku ? String(item.variantSku) : (p.sku || "");

    if (item.variantSku && Array.isArray(p.variants) && p.variants.length > 0) {
      const vIdx = p.variants.findIndex(v => v.sku === String(item.variantSku));
      if (vIdx !== -1) {
        before = p.variants[vIdx].stock || 0;
        after = Math.max(0, before - qty);
        p.variants[vIdx].stock = after;

        // Sync total product stock from variants
        p.stock = p.variants
          .filter(v => v.isActive !== false)
          .reduce((sum, v) => sum + (v.stock || 0), 0);
        await p.save();
      } else {
        // Fallback if variant SKU not matched in array
        before = p.stock || 0;
        after = Math.max(0, before - qty);
        p.stock = after;
        await p.save();
      }
    } else {
      before = p.stock || 0;
      after = Math.max(0, before - qty);
      p.stock = after;
      await p.save();
    }

    // 1. Create StockTxn (SOLD deduction log)
    try {
      await StockTxn.create({
        product: p._id,
        variantSku: sku,
        type: "SOLD",
        quantity: qty,
        before,
        after,
        refType: "ORDER",
        refId: order._id.toString(),
        note: `Order #${orderShortId} placed (${customerName})`
      });
    } catch (txnErr) {
      console.error("Failed to create StockTxn on deduction:", txnErr);
    }

    // 2. Create AuditLog
    try {
      await AuditLog.create({
        actorId: actor.id || order.customer?.id?.toString() || "",
        actorRole: actor.role || "customer",
        type: "STOCK",
        entityType: "PRODUCT",
        entityId: p._id.toString(),
        note: `Stock DEDUCT -${qty} for Order #${orderShortId} ${sku ? '(SKU: ' + sku + ')' : ''}`,
        before: { stock: before },
        after: { stock: after }
      });
    } catch {}
  }

  // Update order flag
  order.stockDeducted = true;
  await order.save();

  // Invalidate product caches
  try {
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
  } catch {}

  return { success: true };
}

/**
 * Restores inventory when an order is cancelled or payment fails.
 * Creates a "RESTOCKED" StockTxn log and AuditLog for complete reversal tracking.
 * Idempotent: will not restore multiple times if order.stockRestored is true.
 *
 * @param {Object} order - Mongoose Order document
 * @param {Object} actor - User / system performing the action { id, role }
 * @param {string} reason - Cancellation reason
 */
export async function restoreInventoryForOrder(order, actor = {}, reason = "") {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    return { success: false, error: "no_items" };
  }

  // Prevent duplicate stock reversals
  if (order.stockRestored) {
    return { success: true, alreadyRestored: true };
  }

  const orderShortId = order._id.toString().slice(-6).toUpperCase();
  const cancelNote = reason || order.cancellation?.reason || "Order Cancellation";

  for (const item of order.items) {
    const qty = Number(item.quantity || 0);
    if (qty <= 0) continue;

    const productId = item.product || item.productId;
    const p = await Product.findById(productId);
    if (!p) continue;

    let before = 0;
    let after = 0;
    const sku = item.variantSku ? String(item.variantSku) : (p.sku || "");

    if (item.variantSku && Array.isArray(p.variants) && p.variants.length > 0) {
      const vIdx = p.variants.findIndex(v => v.sku === String(item.variantSku));
      if (vIdx !== -1) {
        before = p.variants[vIdx].stock || 0;
        after = before + qty;
        p.variants[vIdx].stock = after;

        // Sync total product stock from variants
        p.stock = p.variants
          .filter(v => v.isActive !== false)
          .reduce((sum, v) => sum + (v.stock || 0), 0);
        await p.save();
      } else {
        before = p.stock || 0;
        after = before + qty;
        p.stock = after;
        await p.save();
      }
    } else {
      before = p.stock || 0;
      after = before + qty;
      p.stock = after;
      await p.save();
    }

    // 1. Create StockTxn (RESTOCKED reversal log)
    try {
      await StockTxn.create({
        product: p._id,
        variantSku: sku,
        type: "RESTOCKED",
        quantity: qty,
        before,
        after,
        refType: "ORDER",
        refId: order._id.toString(),
        note: `Order #${orderShortId} Cancelled - Stock Restored (${cancelNote})`
      });
    } catch (txnErr) {
      console.error("Failed to create StockTxn on restoration:", txnErr);
    }

    // 2. Create AuditLog
    try {
      await AuditLog.create({
        actorId: actor.id || "",
        actorRole: actor.role || "system",
        type: "STOCK",
        entityType: "PRODUCT",
        entityId: p._id.toString(),
        note: `Stock RESTORE +${qty} for Cancelled Order #${orderShortId} ${sku ? '(SKU: ' + sku + ')' : ''}. Reason: ${cancelNote}`,
        before: { stock: before },
        after: { stock: after }
      });
    } catch {}
  }

  // Mark as restored so it cannot be restored again
  order.stockRestored = true;
  await order.save();

  // Invalidate product caches
  try {
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
  } catch {}

  return { success: true };
}
