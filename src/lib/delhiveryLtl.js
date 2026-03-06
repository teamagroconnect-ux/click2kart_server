import fetch from 'node-fetch';

const getDelhiveryToken = () => String(process.env.DELHIVERY_TOKEN || process.env.DELHIVERY_API_TOKEN || "");
const getBaseUrl = () => (process.env.DELHIVERY_LTL_BASE_URL || 'https://ltl-clients-api.delhivery.com').replace(/\/$/, "");

/**
 * Cancel a manifested LRN before delivery.
 * @param {string} lrn - Lorry receipt number to cancel
 */
export const cancelShipment = async (lrn) => {
  const token = getDelhiveryToken();
  const url = `${getBaseUrl()}/lrn/cancel/${lrn}`;
  
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Token ${token}` }
  });
  
  return await resp.json();
};

/**
 * Generate labels to be pasted on the boxes in an LR.
 * @param {string} size - Size of shipping label: [sm|md|a4|std]
 * @param {string} lrn - Lorry receipt number
 */
export const getShippingLabels = async (size, lrn) => {
  const token = getDelhiveryToken();
  const url = `${getBaseUrl()}/label/get_urls/${size}/${lrn}`;
  
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Token ${token}` }
  });
  
  return await resp.json();
};

/**
 * Generate a Pickup request.
 * @param {Object} data - Pickup details
 * @param {string} data.client_warehouse - Pickup warehouse name
 * @param {string} data.pickup_date - Pickup date (YYYY-MM-DD)
 * @param {string} data.start_time - Start time (HH:MM:SS)
 * @param {number} data.expected_package_count - Number of boxes
 */
export const createPickupRequest = async (data) => {
  const token = getDelhiveryToken();
  // Using the specific pickup URL pattern if provided, else fallback to base
  const url = process.env.DELHIVERY_PICKUP_API_URL || `${getBaseUrl()}/pickup_requests/`;
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      Authorization: `Token ${token}` 
    },
    body: JSON.stringify(data)
  });
  
  return await resp.json();
};

/**
 * Cancel a Pickup request.
 * @param {string} pickupId - Pickup request ID
 */
export const cancelPickupRequest = async (pickupId) => {
  const token = getDelhiveryToken();
  const url = `${getBaseUrl()}/pickup_requests/${pickupId}`;
  
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Token ${token}` }
  });
  
  return await resp.json();
};
