import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: "Click2Kart" },
    companyGst: { type: String, default: "" },
    companyAddress: { type: String, default: "" },
    companyPhone: { type: String, default: "" },
    companyEmail: { type: String, default: "" },
    // Pickup address fields
    pickupName: { type: String, default: "Click2kart Main" },
    pickupLine1: { type: String, default: "JJ SQUARE,MAIN ROAD GUNUPUR" },
    pickupLine2: { type: String, default: "" },
    pickupCity: { type: String, default: "Gunupur" },
    pickupState: { type: String, default: "Orissa" },
    pickupPincode: { type: String, default: "765022" },
    pickupCountry: { type: String, default: "India" },
    pickupPhone: { type: String, default: "+917978880244" },
    pickupContactPerson: { type: String, default: "" },
    pickupEmail: { type: String, default: "" },
    pickupDefaultSlot: { type: String, default: "Evening 14:00:00 - 18:00:00" },
    pickupReturnSameAsPickup: { type: Boolean, default: true },
    lowStockThreshold: { type: Number, default: 5 },
    minimumOrderAmount: { type: Number, default: 5000 },
    currency: { type: String, default: "INR" },
    taxRate: { type: Number, default: 18 },
    shippingFee: { type: Number, default: 0 },
    enableBirthdayWishes: { type: Boolean, default: true },
    enableOrderNotifications: { type: Boolean, default: true },
    supportPhone: { type: String, default: "" },
    supportEmail: { type: String, default: "" },
    returnPolicy: { type: String, default: "" },
    termsOfService: { type: String, default: "" },
    privacyPolicy: { type: String, default: "" }
  },
  { timestamps: true }
);

// Create default settings if none exist
settingsSchema.statics.getDefaultSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export default mongoose.models.Settings || mongoose.model("Settings", settingsSchema);
