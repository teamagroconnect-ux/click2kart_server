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

export const sendOTP = async (email, otp, purpose = "ACCOUNT_VERIFICATION") => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject =
    purpose === "FORGOT_PASSWORD"
      ? `Password Reset OTP - ${company}`
      : `Verification OTP - ${company}`;
  const title =
    purpose === "FORGOT_PASSWORD"
      ? "Reset Your Password"
      : "Verify Your Email";
  const intro =
    purpose === "FORGOT_PASSWORD"
      ? "You requested to reset your password. Use the OTP below to proceed."
      : "Use the OTP below to verify your email address and complete account setup.";
  const cta =
    purpose === "FORGOT_PASSWORD"
      ? "If you did not request this, you can safely ignore this email."
      : "If you did not initiate this request, you can ignore this email.";
  const html = `
    <div style="font-family: ui-sans-serif, system-ui; max-width: 640px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 14px;">
      <h2 style="color: #111827; text-align: center; margin: 0 0 8px; font-weight: 800;">${company}</h2>
      <div style="text-align:center; color:#6b7280; font-size:14px; margin-bottom:12px">${title}</div>
      <p style="color:#374151; line-height:1.7">${intro}</p>
      <div style="background: #111827; color:#fff; padding: 18px; text-align: center; font-size: 32px; font-weight: 900; letter-spacing: 6px; border-radius: 12px;">
        ${otp}
      </div>
      <p style="margin-top: 14px; color:#6b7280">This 4-digit OTP is valid for 10 minutes. Do not share it with anyone.</p>
      <p style="margin-top: 6px; color:#6b7280">${cta}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #6b7280; text-align: center;">
        &copy; ${new Date().getFullYear()} ${company}. All rights reserved.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};
