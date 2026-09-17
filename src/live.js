/* live feeds: OpenSky (air traffic), USGS (quakes), CelesTrak (ISS), Open-Meteo (wx) */
import { haversine, bearing, LAT0, LON0 } from './geo.js';

export const live = {
  flights: [],        // {icao, callsign, lon, lat, alt_m, vs, heading, speed, origin, dest}
  quakes: [],         // {mag, place, lon, lat, time, url}
  iss: null,          // {lon, lat, alt_km, visible}
  issPass: null,      // {start, peak, dir..., } computed client-side w/ satellite-js
  wx: null,           // {temp, wind, gust, precip, cloud, code, today}
  sun: null,          // {rise, set, now, daylightPct}
  lastSync: null,
};

const LOC = { lamin: 50.6, lomin: -2.3, lamax: 52.0, lomax: 0.2 };

async function jget(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status + ' ' + url.slice(0, 60));
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------------- air traffic (OpenSky, no key, live) ---------------- */
export async function refreshFlights() {
  const d = await jget('/proxy?url=' + encodeURIComponent(`https://opensky-network.org/api/states/all?lamin=${LOC.lamin}&lomin=${LOC.lomin}&lamax=${LOC.lamax}&lomax=${LOC.lomax}`));
  const now = Date.now() / 1000;
  live.flights = (d.states || [])
    .filter(s => s[5] && s[6] != null)
    .map(s => ({
      icao: s[0], callsign: (s[1] || '').trim() || s[0].toUpperCase(),
      lon: s[5], lat: s[6],
      alt_m: s[7] ?? 0, baro: s[13] ?? 0,
      vs: s[11] ?? 0, heading: s[10] ?? 0,
      speed: (s[9] ?? 0) * 3.6,
      geoAlt: s[14] ?? s[7] ?? 0,
      squawk: s[19] || '',
      t: s[4],
    }))
    .filter(f => f.alt_m > 300 || f.vs !== 0)
    .sort((a, b) => b.geoAlt - a.geoAlt);
  live.lastSync = Date.now();
  return live.flights.length;
}

/* ---------------- seismicity (USGS live) ---------------- */
export async function refreshQuakes() {
  const d = await jget('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
  live.quakes = (d.features || []).map(f => ({
    mag: f.properties.mag, place: f.properties.place,
    lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
    depth: f.geometry.coordinates[2], time: f.properties.time, url: f.properties.url,
  })).sort((a, b) => b.mag - a.mag).slice(0, 40);
  return live.quakes.length;
}

/* ---------------- weather + sun (Open-Meteo live) ---------------- */
export async function refreshWx() {
  const d = await jget('https://api.open-meteo.com/v1/forecast?latitude=51.2637&longitude=-1.0909' +
    '&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,relative_humidity_2m,weather_code,surface_pressure' +
    '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&minutely_15=lightning_potential&forecast_days=2&timezone=Europe/London');
  const c = d.current, dy = d.daily;
  const now = new Date();
  const rise = new Date(dy.sunrise[0]), set = new Date(dy.sunset[0]);
  const dayLen = (set - rise) / 3600000;
  const pct = Math.max(0, Math.min(100, ((now - rise) / (set - rise)) * 100));
  live.wx = {
    temp: c.temperature_2m, feels: c.apparent_temperature,
    precip: c.precipitation, wind: c.wind_speed_10m, gust: c.wind_gusts_10m,
    wdir: c.wind_direction_10m, cloud: c.cloud_cover, hum: c.relative_humidity_2m,
    code: c.weather_code, press: c.surface_pressure,
    tmax: dy.temperature_2m_max[0], tmin: dy.temperature_2m_min[0],
    psum: dy.precipitation_sum[0],
    lightning: (d.minutely_15?.lightning_potential || [0])[0] ?? 0,
    rise, set, dayLen, pct,
  };
  live.sun = { rise, set };
  return live.wx;
}

/* ---------------- ISS: TLE fetch + SGP4 propagation (real orbital mechanics) ---------------- */
let satrec = null, tle = null;
export async function refreshTLE() {
  const r = await fetch('/proxy?url=' + encodeURIComponent('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle'));
  if (!r.ok) throw new Error('TLE fetch failed ' + r.status);
  const txt = await r.text();
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i].startsWith('ISS (ZARYA)')) { tle = [lines[i], lines[i + 1], lines[i + 2]]; break; }
  }
  if (!tle) throw new Error('ISS TLE not found');
  return tle;
}
export function setSatrec(rec) { satrec = rec; }

/* find next pass over Basingstoke: elevation > 10 deg, next 48h */
export function computePass(propFn, lookAheadH = 48) {
  if (!satrec) return null;
  const stepS = 20, horizon = 10;
  let t = new Date(); let inPass = false, pass = null;
  const end = Date.now() + lookAheadH * 3600000;
  while (t.getTime() < end) {
    const look = propFn(satrec, t);
    if (look) {
      const up = look.el > horizon;
      if (up && !inPass) {
        inPass = true;
        pass = { start: new Date(t), maxEl: look.el, peakAt: new Date(t), startAz: look.az, peakAz: look.az };
      } else if (up && look.el > pass.maxEl) {
        pass.maxEl = look.el; pass.peakAt = new Date(t); pass.peakAz = look.az;
      } else if (!up && inPass) {
        pass.end = new Date(t); pass.endAz = look.az;
        if (pass.start > new Date()) return pass; // next FUTURE pass
        inPass = false; pass = null;
      }
    }
    t = new Date(t.getTime() + stepS * 1000);
  }
  return pass;
}

export function fmtCountdown(target) {
  const s = Math.max(0, (target - Date.now()) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
