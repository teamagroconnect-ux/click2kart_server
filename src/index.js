import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import { connectIfConfigured } from "./lib/db.js";
import http from "http";
import { initSocket } from "./lib/socket.js";
import Admin from "./models/Admin.js";
import productRoutes from "./routes/productRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import billRoutes from "./routes/billRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import couponRoutes from "./routes/couponRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import partnerRoutes from "./routes/partnerRoutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import partnerAccountRoutes from "./routes/partnerAccountRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import userRoutes from "./routes/userRoutes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (req, res) => {
  res.json({ status: "uddhab das", time: new Date().toISOString() });
});

app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/bills", billRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/user", userRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/partner-accounts", partnerAccountRoutes);

const PORT = process.env.PORT || 5000;

const ensureDefaultAdmin = async () => {
  const email = process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "Admin";

  if (!email || !password) return;

  const existing = await Admin.findOne({ email });
  if (existing) return;

  await Admin.create({ name, email, password });
  console.log(`Default admin created with email ${email}`);
};

const start = async () => {
  await connectIfConfigured();
  await ensureDefaultAdmin();
  const server = http.createServer(app);
  initSocket(server);
  server.listen(PORT, () => {
    console.log(`server running on port ${PORT}`);
  });
};

start();

export default app;

