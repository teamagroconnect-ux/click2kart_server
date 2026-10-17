import mongoose from "mongoose";
import { ensureBusinessCreditIndexes } from "../services/businessCredit.service.js";

export const connectIfConfigured = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) return;
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || undefined });
  await ensureBusinessCreditIndexes().catch((err) => {
    console.warn("[DB] Failed to ensure business credit indexes:", err.message);
  });
};


