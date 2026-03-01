import axios from "axios";

async function getAccessToken() {
  const res = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token"
    }
  });
  return res.data.access_token;
}

export const sendEmail = async ({ to, subject, text, html }) => {
  const content = html || (text ? `<pre>${text}</pre>` : "");
  try {
    const accessToken = await getAccessToken();
    await axios.post(
      `https://mail.zoho.in/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`,
      {
        fromAddress: process.env.ZOHO_MAIL_FROM,
        toAddress: to,
        subject,
        content
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`
        }
      }
    );
    return { sent: true };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Email sending failed:", detail);
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
};

export const sendOTP = async (email, otp) => {
  const subject = `Verification OTP - ${process.env.COMPANY_NAME || "Click2Kart"}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
      <h2 style="color: #2563eb; text-align: center;">${process.env.COMPANY_NAME || "Click2Kart"}</h2>
      <p>Hello,</p>
      <p>Your verification OTP is:</p>
      <div style="background: #f3f4f6; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111827; border-radius: 8px;">
        ${otp}
      </div>
      <p style="margin-top: 20px;">This 4-digit OTP is valid for 10 minutes. Do not share this with anyone.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #6b7280; text-align: center;">
        &copy; ${new Date().getFullYear()} ${process.env.COMPANY_NAME || "Click2Kart"} Premium. All rights reserved.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};
