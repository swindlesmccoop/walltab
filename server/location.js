const fs = require('fs');
const path = require('path');

const SAVED_FILE = path.join(__dirname, '..', 'data', 'location.json');
const UA = 'walltab/1.0 (self-hosted dashboard)';

let resolved = null;

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

// Accepts "Town" or "Town, Region" where Region is a state/province, state code, country, or country code.
async function geocodeName(query) {
  const [name, ...rest] = query.split(',').map((s) => s.trim());
  const qualifier = rest.join(' ').toLowerCase();
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=20&language=en&format=json&name=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode upstream ${res.status}`);
  const results = (await res.json()).results || [];
  const want = (US_STATES[qualifier.toUpperCase()] || qualifier).toLowerCase();
  const hit = qualifier
    ? results.find((r) => [r.admin1, r.country, r.country_code].some((v) => v && v.toLowerCase() === want))
    : results[0];
  if (!hit) throw new Error(`no geocoding match for "${query}"`);
  return { lat: hit.latitude, lon: hit.longitude, city: hit.name };
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return '';
    const a = (await res.json()).address || {};
    return a.city || a.town || a.village || a.hamlet || a.county || '';
  } catch {
    return '';
  }
}

async function lookupIp() {
  const res = await fetch('https://ipinfo.io/json');
  if (!res.ok) throw new Error(`ip location upstream ${res.status}`);
  const info = await res.json();
  const [lat, lon] = (info.loc || '').split(',');
  if (!lat || !lon) throw new Error('ip location missing coordinates');
  return { lat: Number(lat), lon: Number(lon), city: info.city || '' };
}

function envOverride() {
  return Boolean((process.env.LAT && process.env.LON) || process.env.CITY_NAME);
}

// Precedence: .env LAT/LON > .env CITY_NAME (geocoded) > browser-shared location > public IP.
async function getLocation() {
  if (resolved) return resolved;
  const { LAT, LON, CITY_NAME } = process.env;

  if (LAT && LON) {
    resolved = { lat: Number(LAT), lon: Number(LON), city: CITY_NAME || '', source: 'env' };
  } else if (CITY_NAME) {
    try {
      resolved = { ...(await geocodeName(CITY_NAME)), source: 'env' };
    } catch (err) {
      console.warn(`CITY_NAME lookup failed (${err.message}); falling back`);
    }
  }
  if (!resolved) {
    const saved = readSaved();
    resolved = saved ? { ...saved, source: 'browser' } : { ...(await lookupIp()), source: 'ip' };
  }

  console.log(`weather location (${resolved.source}): ${resolved.city} (${resolved.lat},${resolved.lon})`);
  return resolved;
}

async function saveBrowserLocation(lat, lon) {
  if (envOverride()) return { ignored: true, reason: 'overridden by .env' };
  const prev = readSaved();
  // Skip writes (and reverse-geocode calls) when the position barely moved (~1 km).
  if (prev && Math.abs(prev.lat - lat) < 0.01 && Math.abs(prev.lon - lon) < 0.01) {
    return { ignored: true, reason: 'unchanged' };
  }
  const city = await reverseGeocode(lat, lon);
  // ~1 km precision is plenty for weather and avoids storing an exact home position.
  const loc = { lat: Number(lat.toFixed(2)), lon: Number(lon.toFixed(2)), city };
  fs.writeFileSync(SAVED_FILE, JSON.stringify(loc, null, 2));
  resolved = null;
  return { ignored: false, location: loc };
}

module.exports = { getLocation, saveBrowserLocation };
