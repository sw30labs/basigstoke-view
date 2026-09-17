/* terrain: real SRTM 30m (downsampled 120m) — hillshade, contours, sampling */
import { LAT0, LON0, KX, KY } from './geo.js';

let GRID = null; // {nx, ny, latmax, lonmin, dlat, dlon, h:Float32Array}

export async function loadTerrain(fetchImpl = fetch) {
  const res = await fetchImpl('assets/data/terrain.bin.gz');
  if (!res.ok) throw new Error('terrain.bin.gz missing — run scripts/fetch_data.py');
  const buf = await gunzipBuf(await res.arrayBuffer());
  const dv = new DataView(buf);
  const nx = dv.getUint32(0, true), ny = dv.getUint32(4, true);
  const latmax = dv.getFloat32(8, true), lonmin = dv.getFloat32(12, true);
  const dlat = dv.getFloat32(16, true), dlon = dv.getFloat32(20, true);
  // header is 2×u32 + 4×f32 = 24 bytes; offset 32 skipped the first two samples
  // and made h.length = nx*ny-2, so reliefCanvas walked off the end of the grid.
  const h = new Float32Array(buf, 24);
  if (h.length !== nx * ny) throw new Error(`terrain grid ${nx}×${ny} != ${h.length} samples`);
  GRID = { nx, ny, latmax, lonmin, dlat, dlon, h };
  return GRID;
}
async function gunzipBuf(ab) {
  // DecompressionStream('gzip') exists in all modern browsers
  const ds = new DecompressionStream('gzip');
  const stream = new Response(ab).body.pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

export function terrainReady() { return !!GRID; }

/* height in metres at lon/lat (bilinear) */
export function heightAt(lon, lat) {
  if (!GRID) return 0;
  const gx = (lon - GRID.lonmin) / GRID.dlon;
  const gy = (GRID.latmax - lat) / GRID.dlat;
  if (gx < 0 || gy < 0 || gx > GRID.nx - 1 || gy > GRID.ny - 1) return NaN;
  const x0 = gx | 0, y0 = gy | 0;
  const x1 = Math.min(x0 + 1, GRID.nx - 1), y1 = Math.min(y0 + 1, GRID.ny - 1);
  const fx = gx - x0, fy = gy - y0;
  const { h, nx } = GRID;
  return (h[y0 * nx + x0] * (1 - fx) + h[y0 * nx + x1] * fx) * (1 - fy) +
         (h[y1 * nx + x0] * (1 - fx) + h[y1 * nx + x1] * fx) * fy;
}

/* render hillshade + hypsometric tint into an offscreen canvas (grid res) */
export function reliefCanvas(palette) {
  if (!GRID) return null;
  const { nx, ny, h, dlat, dlon } = GRID;
  const stepX = dlon * KX, stepY = dlat * KY; // metres per cell
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(nx, ny);
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < hMin) hMin = h[i]; if (h[i] > hMax) hMax = h[i]; }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      const xl = h[y * nx + Math.max(x - 1, 0)], xr = h[y * nx + Math.min(x + 1, nx - 1)];
      const yu = h[Math.max(y - 1, 0) * nx + x], yd = h[Math.min(y + 1, ny - 1) * nx + x];
      const dzdx = (xr - xl) / (2 * stepX), dzdy = (yd - yu) / (2 * stepY);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      let aspect = Math.atan2(dzdy, -dzdx);
      let shade = Math.cos(alt) * Math.cos(slope) +
                  Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
      shade = Math.max(0, Math.min(1, shade * 1.25 - 0.05));
      const t = (h[i] - hMin) / Math.max(1, hMax - hMin);
      const [r, g, b] = palette(h[i], t);
      const k = i * 4;
      img.data[k] = r * shade; img.data[k + 1] = g * shade;
      img.data[k + 2] = b * shade; img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function terrainExtent() {
  return { lonmin: GRID.lonmin, lonmax: GRID.lonmin + (GRID.nx - 1) * GRID.dlon,
           latmax: GRID.latmax, latmin: GRID.latmax - (GRID.ny - 1) * GRID.dlat };
}

/* marching-squares contour lines at given interval (metres) */
export function contours(interval) {
  if (!GRID) return [];
  const { nx, ny, h, dlon, dlat, lonmin, latmax } = GRID;
  const lines = [];
  const levels = [];
  for (let lv = Math.ceil(minH() / interval) * interval; lv < maxH(); lv += interval) levels.push(lv);
  const X = (x) => lonmin + x * dlon;
  const Y = (y) => latmax - y * dlat;
  for (const lv of levels) {
    const segs = [];
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const a = h[y * nx + x], b = h[y * nx + x + 1],
              c = h[(y + 1) * nx + x + 1], d = h[(y + 1) * nx + x];
        let idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const ip = (v1, v2) => (lv - v1) / (v2 - v1);
        const top    = [X(x + ip(a, b)), Y(y)];
        const right  = [X(x + 1), Y(y + ip(b, c))];
        const bottom = [X(x + ip(d, c)), Y(y + 1)];
        const left   = [X(x), Y(y + ip(a, d))];
        const add = (p, q) => segs.push([p, q]);
        switch (idx) {
          case 1: case 14: add(left, bottom); break;
          case 2: case 13: add(bottom, right); break;
          case 3: case 12: add(left, right); break;
          case 4: case 11: add(top, right); break;
          case 6: case 9:  add(top, bottom); break;
          case 7: case 8:  add(left, top); break;
          case 5:  add(left, top); add(bottom, right); break;
          case 10: add(left, bottom); add(top, right); break;
        }
      }
    }
    if (segs.length) lines.push({ level: lv, segs });
  }
  return lines;
}
function minH() { let m = Infinity; for (const v of GRID.h) m = Math.min(m, v); return m; }
function maxH() { let m = -Infinity; for (const v of GRID.h) m = Math.max(m, v); return m; }
export function terrainStats() {
  let sum = 0, m = Infinity, M = -Infinity;
  for (const v of GRID.h) { sum += v; m = Math.min(m, v); M = Math.max(M, v); }
  return { mean: sum / GRID.h.length, min: m, max: M };
}
