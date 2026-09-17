/* geo utilities — projection, OSGB grid, geodesy, OS grid references */
export const LAT0 = 51.2637;   // Basingstoke town centre
export const LON0 = -1.0909;
export const KX = 111320 * Math.cos(LAT0 * Math.PI / 180); // m per deg lon
export const KY = 110574;                                   // m per deg lat

export function toWorld(lon, lat) {
  return [(lon - LON0) * KX, -(lat - LAT0) * KY];
}
export function toLonLat(x, y) {
  return [LON0 + x / KX, LAT0 - y / KY];
}
export function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371000, p = Math.PI / 180;
  const dLa = (lat2 - lat1) * p, dLo = (lon2 - lon1) * p;
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export function bearing(lon1, lat1, lon2, lat2) {
  const p = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) -
            Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p);
  return (Math.atan2(y, x) / p + 360) % 360;
}
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
export function compass(deg) { return COMPASS[Math.round(deg / 22.5) % 16]; }

/* ---- OS National Grid (OSGB36 Airy 1830) ----
   Faithful port of the OS reference series from "A guide to coordinate
   systems in Great Britain" (public formulas, as implemented by the
   Python `osgb` package). ~±5 m (Helmert approximation of OSTN15). */
const D2R = Math.PI / 180;
const A36 = 6377563.396, B36 = 6356256.909, E236 = 0.006670540074149134;
const AW = 6378137.0, EW = 0.006694379990141108;
const F0 = 0.9996012717, LAM0 = -2 * D2R, PHI0 = 49 * D2R, OX = 400000, OY = -100000;
const N36 = (A36 - B36) / (A36 + B36);

function airyM(phi) {
  const n = N36, pp = phi + PHI0, pm = phi - PHI0;
  return B36 * (
    (1 + n * (1 + 5 / 4 * n * (1 + n))) * pm
    - 3 * n * (1 + n * (1 + 7 / 8 * n)) * Math.sin(pm) * Math.cos(pp)
    + 15 / 8 * n * n * (1 + n) * Math.sin(2 * pm) * Math.cos(2 * pp)
    - 35 / 24 * n * n * n * Math.sin(3 * pm) * Math.cos(3 * pp));
}
function project(lat, lon) { // OSGB36 lat/lon -> [e, n]
  const phi = lat * D2R, cp = Math.cos(phi), sp = Math.sin(phi), tp = sp / cp;
  const nu = F0 * A36 / Math.sqrt(1 - E236 * sp * sp);
  const etasq = (1 - E236 * sp * sp) / (1 - E236) - 1;
  const II = nu / 2 * sp * cp;
  const III = nu / 24 * sp * cp ** 3 * (5 - tp * tp + 9 * etasq);
  const IIIA = nu / 720 * sp * cp ** 5 * (61 + (-58 + tp * tp) * tp * tp);
  const IV = nu * cp;
  const V = nu / 6 * cp ** 3 * (etasq + 1 - tp * tp);
  const VI = nu / 120 * cp ** 5 * (5 + (-18 + tp * tp) * tp * tp + 14 * etasq - 58 * tp * tp * etasq);
  const dl = lon * D2R - LAM0;
  return [OX + (IV + (V + VI * dl * dl) * dl * dl) * dl,
          OY + F0 * airyM(phi) + (II + (III + IIIA * dl * dl) * dl * dl) * dl * dl];
}
function llh2xyz(lat, lon, h, e2, a) {
  const phi = lat * D2R, lam = lon * D2R;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [(nu + h) * Math.cos(phi) * Math.cos(lam),
          (nu + h) * Math.cos(phi) * Math.sin(lam),
          ((1 - e2) * nu + h) * Math.sin(phi)];
}
function xyz2llh(x, y, z, e2, a) {
  const p = Math.hypot(x, y), lam = Math.atan2(y, x);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(z + e2 * nu * Math.sin(phi), p);
  }
  return [phi / D2R, lam / D2R];
}
export function wgs84ToOSGB(lat, lon) {
  // WGS84 -> OSGB36 via the OS Helmert approximation (dir=+1 form)
  const [xa, ya, za] = llh2xyz(lat, lon, 0, EW, AW);
  const tx = -446.448, ty = 125.157, tz = -542.060, sp = 1 + 0.0000204894;
  const rx = -0.1502 / 3600 * D2R, ry = -0.2470 / 3600 * D2R, rz = -0.8421 / 3600 * D2R;
  const xb = tx + sp * xa - rz * ya + ry * za;
  const yb = ty + rz * xa + sp * ya - rx * za;
  const zb = tz - ry * xa + rx * ya + sp * za;
  return xyz2llh(xb, yb, zb, E236, A36);
}
function kmToGrid(e, n) {
  const lngIdx = Math.floor(e / 500000), latIdx = Math.floor(n / 500000);
  const lng = "STABCDEFGHJKLM"[lngIdx + 1] || "?";   // S= -2.., T= -1..
  const lat = "ABCDEFGHJKLMNPQRSTUV"[latIdx - 3] || "?"; // A starts at n=1.5M
  const gx = Math.floor((e % 500000) / 100000), gy = Math.floor((n % 500000) / 100000);
  const col = "VWXYZQRSTU"[gx], row = "JKLMNOPQR"[9 - gy];
  return { pair: lng + lat, dig: col + row,
           e10: Math.floor((e % 100000) / 10000), n10: Math.floor((n % 100000) / 10000) };
}
export function osGridRef(lon, lat) {
  const [oLat, oLon] = wgs84ToOSGB(lat, lon);
  const [e, n] = project(oLat, oLon);
  const g = kmToGrid(e, n);
  return `${g.pair}${g.dig} ${g.e10}${g.n10} ${Math.floor((e % 10000) / 1000)}${Math.floor((n % 10000) / 1000)}`.replace(/  +/g, " ");
}

/* point-in-polygon (ray cast), coords [ [lon,lat], ... ] */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function fmtKm(m) { return m < 9995 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }
export function fmtDist(lat1, lon1, lat2, lon2) {
  const km = haversine(lon1, lat1, lon2, lat2) / 1000;
  return km < 10 ? km.toFixed(1) + " km" : Math.round(km) + " km";
}
