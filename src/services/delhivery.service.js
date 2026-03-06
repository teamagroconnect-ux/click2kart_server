import fetch from "node-fetch";

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const ltlBase = () => _sanitize(process.env.DELHIVERY_LTL_BASE_URL || "");
const legacyBase = () => _sanitize(process.env.DELHIVERY_BASE_URL || "");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

export const checkServiceability = async (pincode) => {
  const ltl = ltlBase();
  const legacy = legacyBase();
  if (!ltl && !legacy) throw new Error("delhivery_not_configured");
  if (ltl) {
    try {
      const r = await fetch(`${ltl}/pincode-service/${encodeURIComponent(pincode)}`, { headers: authHeader() });
      if (r.ok) return await r.json();
    } catch {}
  }
  if (legacy) {
    const url = `${legacy}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
    const r2 = await fetch(url, { headers: authHeader() });
    return await r2.json();
  }
  throw new Error("serviceability_failed");
};

export const estimateFreight = async (payload) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/freight/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload || {})
  });
  const d = await r.json();
  return d;
};

export const createShipment = async (manifestPayload) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(manifestPayload || {})
  });
  const d = await r.json();
  return d;
};

export const getManifestStatus = async (jobId) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest?job_id=${encodeURIComponent(jobId)}`, { headers: authHeader() });
  const d = await r.json();
  return d;
};

export const trackShipment = async (lrn) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/lrn/track?lrn=${encodeURIComponent(lrn)}`, { headers: authHeader() });
  const d = await r.json();
  return d;
};
