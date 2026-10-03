import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

import AdminExcel from "./models/AdminExcel.js";

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not found in env!");
    process.exit(1);
  }
  
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || undefined });
  console.log("Connected to MongoDB");

  const list = await AdminExcel.find({});
  console.log(`Found ${list.length} Excel documents:`);
  
  list.forEach(doc => {
    console.log("-----------------------------------------");
    console.log("ID:", doc._id);
    console.log("fileName:", doc.fileName);
    console.log("data (rows count):", doc.data?.length);
    console.log("Sample row 1:", JSON.stringify(doc.data?.[0]));
    console.log("Sample row 2:", JSON.stringify(doc.data?.[1]));
  });

  await mongoose.disconnect();
}

run().catch(console.error);
