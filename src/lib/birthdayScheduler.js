
import cron from "node-cron";
import Customer from "../models/Customer.js";
import Partner from "../models/Partner.js";
import { sendEmail } from "./mailer.js";

const sendBirthdayWish = async (user, userType) => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject = `🎉 Happy Birthday ${user.name}! - ${company}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03);text-align:center;">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:12px;letter-spacing:.3em;color:#7c3aed;background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase;margin-bottom:24px;">${company}</div>
        <div style="font-size:64px;margin-bottom:16px;">🎂</div>
        <h1 style="margin:0 0 12px;font-size:36px;line-height:1.1;color:#0f172a;font-weight:900;letter-spacing:-0.02em">Happy Birthday, ${user.name}!</h1>
        <p style="margin:0 0 32px;font-size:16px;color:#64748b;line-height:1.7;font-weight:500">
          We hope your special day is filled with joy, laughter, and wonderful memories! 🎉
        </p>
      </div>

      <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);border-radius:20px;padding:32px;margin-bottom:32px;color:#ffffff;">
        <h2 style="margin:0 0 12px;font-size:24px;font-weight:800">A Special Gift For You!</h2>
        <p style="margin:0;font-size:15px;opacity:0.95">Enjoy your day with our best wishes!</p>
      </div>

      <div style="margin-top:40px;padding:24px;background:#f8fafc;border-radius:16px;color:#64748b;font-size:13px;line-height:1.6;text-align:center;border:1px solid #f1f5f9">
        This is a premium automated birthday wish from <strong>${company}</strong>.<br/>If you have any questions, our support team is here to help.<br/><br/>Mail us at: <a href="mailto:support@click2kart.net" style="color:#7c3aed;font-weight:700;text-decoration:none">support@click2kart.net</a>
      </div>
      <div style="margin-top:32px;text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${new Date().getFullYear()} ${company.toUpperCase()}. ALL RIGHTS RESERVED.
      </div>
    </div>
  `;

  if (user.email) {
    try {
      await sendEmail({ to: user.email, subject, html });
      console.log(`Birthday wish sent to ${userType} ${user.email}`);
    } catch (err) {
      console.error(`Failed to send birthday wish to ${user.email}:`, err);
    }
  }
};

const checkAndSendBirthdayWishes = async () => {
  try {
    const today = new Date();
    const day = today.getDate();
    const month = today.getMonth(); // 0-11

    // Find customers with birthday today
    const customers = await Customer.find({
      dob: {
        $exists: true,
        $ne: null
      }
    });

    const birthdayCustomers = customers.filter(customer => {
      const dob = new Date(customer.dob);
      return dob.getDate() === day && dob.getMonth() === month;
    });

    // Find partners with birthday today
    const partners = await Partner.find({
      dob: {
        $exists: true,
        $ne: null
      }
    });

    const birthdayPartners = partners.filter(partner => {
      const dob = new Date(partner.dob);
      return dob.getDate() === day && dob.getMonth() === month;
    });

    console.log(`Found ${birthdayCustomers.length} customers and ${birthdayPartners.length} partners with birthdays today!`);

    // Send wishes to customers
    for (const customer of birthdayCustomers) {
      await sendBirthdayWish(customer, "customer");
    }

    // Send wishes to partners
    for (const partner of birthdayPartners) {
      await sendBirthdayWish(partner, "partner");
    }

  } catch (err) {
    console.error("Error checking and sending birthday wishes:", err);
  }
};

// Schedule to run every day at 12:00 AM IST (Indian Standard Time)
// IST is UTC+5:30, so cron time is 18:30 UTC of previous day
// However, to make it timezone-aware, we can use the timezone option
export const startBirthdayScheduler = () => {
  cron.schedule(
    "0 0 0 * * *",
    checkAndSendBirthdayWishes,
    {
      timezone: "Asia/Kolkata"
    }
  );
  console.log("Birthday scheduler started! Will check for birthdays daily at 12:00 AM IST.");
};
