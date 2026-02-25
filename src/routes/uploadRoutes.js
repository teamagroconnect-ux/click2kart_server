import express from "express";
import multer from "multer";
import { auth, requireRole } from "../middleware/auth.js";
import { configureCloudinary, uploadBuffer } from "../lib/cloudinary.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/image", auth, requireRole("admin"), upload.single("file"), async (req, res) => {
  if (!configureCloudinary()) return res.status(503).json({ error: "cloudinary_not_configured" });
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const result = await uploadBuffer(req.file.buffer, "products");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "upload_failed" });
  }
});

export default router;

