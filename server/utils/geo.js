import fetch from 'node-fetch';

// Off unless GEO_LOOKUP=true: it sends the employee's IP address to ipapi.co.
export async function geoLookup(ip) {
  if (process.env.GEO_LOOKUP !== 'true' || !ip) return null;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const res = await fetch(`https://ipapi.co/${ip}/json/`, { signal: controller.signal }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data.city
      ? `${data.city}, ${data.region}`
      : data.country_name || null;
  } catch {
    return null;
  }
} 