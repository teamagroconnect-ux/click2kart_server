import fetch from "node-fetch";

const base = () => (process.env.DELHIVERY_BASE_URL || "").replace(/\/+$/, "");
const bearer = () => `Bearer ${process.env.DELHIVERY_TOKEN || ""}`;

export const checkServiceability = async (pincode) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/pincode-service/${encodeURIComponent(pincode)}`, { headers: { Authorization: bearer() } });
  const d = await r.json();
  return d;
};

export const estimateFreight = async (payload) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/freight/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: bearer() },
    body: JSON.stringify(payload || {})
  });
  const d = await r.json();
  return d;
};

export const createShipment = async (manifestPayload) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: bearer() },
    body: JSON.stringify(manifestPayload || {})
  });
  const d = await r.json();
  return d;
};

export const getManifestStatus = async (jobId) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest?job_id=${encodeURIComponent(jobId)}`, { headers: { Authorization: bearer() } });
  const d = await r.json();
  return d;
};

export const trackShipment = async (lrn) => {
  const b = base();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/lrn/track?lrn=${encodeURIComponent(lrn)}`, { headers: { Authorization: bearer() } });
  const d = await r.json();
  return d;
};
