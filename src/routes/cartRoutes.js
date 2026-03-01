import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Cart from "../models/Cart.js";
import Product from "../models/Product.js";

const router = express.Router();

const serializeCart = async (cart) => {
  if (!cart) return { items: [] };
  await cart.populate("items.product", "name price images stock variants");
  return {
    items: cart.items.map((it) => {
      const base = {
        productId: it.product._id.toString(),
        quantity: it.quantity
      };
      if (it.variantId) {
        const v = (it.product.variants || []).find(v => v._id.toString() === it.variantId);
        if (v) {
          return {
            ...base,
            variantId: it.variantId,
            name: it.product.name,
            attributes: v.attributes,
            price: v.price ?? it.product.price,
            stock: v.stock ?? 0,
            sku: v.sku,
            image: (v.images?.[0]?.url || it.product.images?.[0]?.url || "")
          };
        }
      }
      return {
        ...base,
        name: it.product.name,
        price: it.product.price,
        stock: it.product.stock,
        image: it.product.images?.[0]?.url || ""
      };
    })
  };
};

router.use(auth, requireRole("customer"));

router.get("/", async (req, res) => {
  const cart = await Cart.findOne({ customer: req.user.id });
  const payload = await serializeCart(cart);
  res.json(payload);
});

router.post("/add", async (req, res) => {
  const { productId, variantId, quantity } = req.body || {};
  const qty = Number(quantity || 1);
  if (!mongoose.isValidObjectId(productId) || !Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) return res.status(404).json({ error: "product_not_found" });
  let variant = null;
  if (variantId) {
    variant = (product.variants || []).find(v => v._id.toString() === String(variantId));
    if (!variant || !variant.isActive) return res.status(404).json({ error: "variant_not_found" });
  }

  let cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) {
    cart = await Cart.create({ customer: req.user.id, items: [] });
  }

  const existing = cart.items.find((it) => it.product.toString() === productId && String(it.variantId || "") === String(variantId || ""));
  const currentQty = existing ? existing.quantity : 0;
  const available = variant ? (variant.stock || 0) : product.stock;
  if (currentQty + qty > available) return res.status(400).json({ error: "insufficient_stock" });

  if (existing) {
    existing.quantity += qty;
  } else {
    cart.items.push({ product: product._id, variantId: variantId || undefined, quantity: qty });
  }
  await cart.save();

  const payload = await serializeCart(cart);
  res.json(payload);
});

router.put("/update", async (req, res) => {
  const { productId, variantId, quantity } = req.body || {};
  const qty = Number(quantity);
  if (!mongoose.isValidObjectId(productId) || !Number.isInteger(qty)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) return res.json({ items: [] });

  const idx = cart.items.findIndex((it) => it.product.toString() === productId && String(it.variantId || "") === String(variantId || ""));
  if (idx === -1) return res.json(await serializeCart(cart));

  if (qty <= 0) {
    cart.items.splice(idx, 1);
  } else {
    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) return res.status(404).json({ error: "product_not_found" });
    const variant = variantId ? (product.variants || []).find(v => v._id.toString() === String(variantId)) : null;
    const available = variant ? (variant.stock || 0) : product.stock;
    if (qty > available) return res.status(400).json({ error: "insufficient_stock" });
    cart.items[idx].quantity = qty;
  }
  await cart.save();
  res.json(await serializeCart(cart));
});

router.delete("/remove", async (req, res) => {
  const { productId, variantId } = req.body || {};
  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  const cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) return res.json({ items: [] });
  cart.items = cart.items.filter((it) => !(it.product.toString() === productId && String(it.variantId || "") === String(variantId || "")));
  await cart.save();
  res.json(await serializeCart(cart));
});

export default router;
