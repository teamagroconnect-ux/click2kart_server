import cron from "node-cron";
import { syncActiveDelhiveryOrders } from "../services/delhiverySync.service.js";

/**
 * Daily scheduler to synchronize Delhivery order status
 * Runs at 12:00 AM (00:00) and 12:00 PM (12:00) IST
 */
export const startOrderSyncScheduler = () => {
  // Cron pattern: at 00:00 (12:00 AM) and 12:00 (12:00 PM) every day
  // Format for node-cron (6 fields): second(optional) minute hour day month day-of-week
  // "0 0 0,12 * * *" => second 0, minute 0, hours 0 and 12
  cron.schedule(
    "0 0 0,12 * * *",
    async () => {
      console.log(`[OrderSyncScheduler] ⏰ Triggering scheduled Delhivery order sync at ${new Date().toISOString()} IST`);
      try {
        const result = await syncActiveDelhiveryOrders();
        console.log(`[OrderSyncScheduler] ✓ Sync completed. Total active: ${result.totalActive}, Statuses updated: ${result.updatedCount}`);
      } catch (err) {
        console.error("[OrderSyncScheduler] ✗ Failed scheduled sync:", err);
      }
    },
    {
      timezone: "Asia/Kolkata"
    }
  );

  console.log("Order sync scheduler started! Scheduled to sync active orders daily at 12:00 AM and 12:00 PM IST.");
};
