import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";
import Review from "../models/Review.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  if (req.user.role === "admin") {
    const Admin = (await import("../models/Admin.js")).default;
    const admin = await Admin.findById(req.user.id).select("name email");
    if (!admin) return res.status(404).json({ error: "not_found" });
    return res.json({
      id: admin._id.toString(),
      name: admin.name,
      email: admin.email,
      role: "admin"
    });
  }

  const user = await Customer.findById(req.user.id).select("name email phone whatsappNumber address isKycComplete kyc dob");
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    whatsappNumber: user.whatsappNumber || "",
    defaultAddress: user.address || "",
    isKycComplete: !!user.isKycComplete,
    kyc: user.kyc || {},
    dob: user.dob,
    role: "customer"
  });
});

router.put("/kyc", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  const allowed = ["businessName", "gstin", "pan", "panCard", "aadhaarCard", "addressLine1", "addressLine2", "city", "district", "state", "pincode", "profilePicture"];
  const restricted = ["businessName", "gstin", "pan"];
  
  const kyc = { ...(user.kyc || {}) };
  
  for (const k of allowed) {
    if (typeof payload[k] === "string") {
      const value = payload[k].trim();
      // Only allow updating if it was empty or if it's not a restricted field
      if (!restricted.includes(k) || !kyc[k]) {
        kyc[k] = value;
      }
    }
  }

  const requiredFilled = (kyc.businessName && kyc.gstin && kyc.pan && kyc.addressLine1 && kyc.city && kyc.district && kyc.state && kyc.pincode);
  
  user.kyc = kyc;
  user.isKycComplete = !!requiredFilled;
  await user.save();

  res.json({ isKycComplete: user.isKycComplete, kyc: user.kyc });
});

router.put("/profile", auth, requireRole("customer"), async (req, res) => {
  const { address, name, phone, dob, whatsappNumber } = req.body;
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  if (address !== undefined) user.address = address;
  if (typeof name === "string") user.name = name.trim();
  if (typeof phone === "string") user.phone = phone.trim();
  if (dob) user.dob = new Date(dob);
  if (typeof whatsappNumber === "string") user.whatsappNumber = whatsappNumber.trim();

  await user.save();
  res.json({ success: true });
});

router.put("/change-password", auth, requireRole("customer"), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: "all_fields_required" });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "passwords_do_not_match" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "password_too_short" });
  }

  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  // Only check current password if one exists and is provided
  if (user.password && currentPassword) {
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ error: "incorrect_password" });
    }
  }

  user.password = newPassword;
  await user.save();

  res.json({ success: true });
});

// Addresses endpoints
router.get("/addresses", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  
  // If no addresses, check if kyc address exists and add it as default
  if (!user.addresses || user.addresses.length === 0) {
    if (user.kyc && user.kyc.addressLine1) {
      const defaultAddress = {
        _id: new mongoose.Types.ObjectId(),
        fullName: user.name,
        phone: user.phone,
        addressLine1: user.kyc.addressLine1,
        addressLine2: user.kyc.addressLine2,
        city: user.kyc.city,
        district: user.kyc.district,
        state: user.kyc.state,
        pincode: user.kyc.pincode,
        isDefault: true
      };
      user.addresses = [defaultAddress];
      await user.save();
    }
  }
  
  res.json(user.addresses || []);
});

router.post("/addresses", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  
  const newAddress = {
    _id: new mongoose.Types.ObjectId(),
    fullName: req.body.fullName || user.name,
    phone: req.body.phone || user.phone,
    addressLine1: req.body.addressLine1,
    addressLine2: req.body.addressLine2,
    city: req.body.city,
    district: req.body.district,
    state: req.body.state,
    pincode: req.body.pincode,
    isDefault: req.body.isDefault || user.addresses.length === 0
  };
  
  // If new address is default, unset others
  if (newAddress.isDefault) {
    user.addresses.forEach(a => { a.isDefault = false; });
  }
  
  user.addresses.push(newAddress);
  await user.save();
  
  // Also update kyc address if this is the first address or it's set as default
  if (user.addresses.length === 1 || newAddress.isDefault) {
    user.kyc.addressLine1 = newAddress.addressLine1;
    user.kyc.addressLine2 = newAddress.addressLine2;
    user.kyc.city = newAddress.city;
    user.kyc.district = newAddress.district;
    user.kyc.state = newAddress.state;
    user.kyc.pincode = newAddress.pincode;
    await user.save();
  }
  
  res.status(201).json(newAddress);
});

router.put("/addresses/:id", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  
  const addrIndex = user.addresses.findIndex(a => a._id.toString() === req.params.id);
  if (addrIndex === -1) return res.status(404).json({ error: "address_not_found" });
  
  // Update fields
  const updated = { ...user.addresses[addrIndex].toObject() };
  if (req.body.fullName) updated.fullName = req.body.fullName;
  if (req.body.phone) updated.phone = req.body.phone;
  if (req.body.addressLine1) updated.addressLine1 = req.body.addressLine1;
  if (req.body.addressLine2 !== undefined) updated.addressLine2 = req.body.addressLine2;
  if (req.body.city) updated.city = req.body.city;
  if (req.body.district) updated.district = req.body.district;
  if (req.body.state) updated.state = req.body.state;
  if (req.body.pincode) updated.pincode = req.body.pincode;
  
  // Handle default
  if (req.body.isDefault) {
    user.addresses.forEach(a => { a.isDefault = false; });
    updated.isDefault = true;
  }
  
  user.addresses[addrIndex] = updated;
  await user.save();
  
  // Also update kyc address if this is the default
  if (updated.isDefault) {
    user.kyc.addressLine1 = updated.addressLine1;
    user.kyc.addressLine2 = updated.addressLine2;
    user.kyc.city = updated.city;
    user.kyc.district = updated.district;
    user.kyc.state = updated.state;
    user.kyc.pincode = updated.pincode;
    await user.save();
  }
  
  res.json(updated);
});

router.put("/addresses/:id/default", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  
  const addr = user.addresses.find(a => a._id.toString() === req.params.id);
  if (!addr) return res.status(404).json({ error: "address_not_found" });
  
  // Set all to false, then this one to true
  user.addresses.forEach(a => { a.isDefault = false; });
  addr.isDefault = true;
  await user.save();
  
  // Update kyc address
  user.kyc.addressLine1 = addr.addressLine1;
  user.kyc.addressLine2 = addr.addressLine2;
  user.kyc.city = addr.city;
  user.kyc.district = addr.district;
  user.kyc.state = addr.state;
  user.kyc.pincode = addr.pincode;
  await user.save();
  
  res.json(user.addresses);
});

router.delete("/addresses/:id", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  
  const initialLength = user.addresses.length;
  user.addresses = user.addresses.filter(a => a._id.toString() !== req.params.id);
  
  // If we deleted the default, set the first one as default
  if (initialLength > 1 && user.addresses.length > 0) {
    user.addresses[0].isDefault = true;
  }
  
  await user.save();
  res.json({ success: true });
});

// Get list of product IDs user has reviewed
router.get("/reviews/products", auth, requireRole("customer"), async (req, res) => {
  const reviews = await Review.find({ customer: req.user.id }).select("product").lean();
  const productIds = reviews.map(r => r.product.toString());
  res.json({ productIds });
});

export default router;
