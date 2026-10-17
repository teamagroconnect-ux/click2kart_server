import cron from "node-cron";
import { accrueDailyInterestForActiveFacilities } from "../services/businessCredit.service.js";

/**
 * Daily scheduler to accrue interest on active Business Credit Facilities
 * Runs at 12:05 AM (00:05) IST every day
 */
export const startInterestAccrualScheduler = () => {
  cron.schedule(
    "5 0 * * *",
    async () => {
      console.log(`[InterestAccrualScheduler] ⏰ Triggering daily interest accrual at ${new Date().toISOString()} IST`);
      try {
        const result = await accrueDailyInterestForActiveFacilities();
        console.log(`[InterestAccrualScheduler] ✓ Accrual completed. Processed: ${result.processedCount}, Total Interest Accrued: ₹${result.totalInterestAccrued}`);
      } catch (err) {
        console.error("[InterestAccrualScheduler] ✗ Failed daily interest accrual:", err);
      }
    },
    {
      timezone: "Asia/Kolkata"
    }
  );

  console.log("Interest accrual scheduler started! Scheduled to run daily at 12:05 AM IST.");
};
