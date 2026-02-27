import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";

const router = express.Router();

router.get("/me", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id).select("name email phone address");
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    defaultAddress: user.address || ""
  });
});

export default router;

