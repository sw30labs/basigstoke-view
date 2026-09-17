/* BASINGSTOKE·VIEW main — canvas tactical map over real Basingstoke geodata */
import { LAT0, LON0, KX, KY, toWorld, toLonLat, osGridRef, haversine, bearing, compass, fmtDist } from './geo.js';
import { loadTerrain, heightAt, reliefCanvas, contours, terrainExtent, terrainStats } from './terrain.js';
import { live, refreshFlights, refreshQuakes, refreshWx, refreshTLE, setSatrec, computePass, fmtCountdown } from './live.js';
import { twoline2satrec, propagate, gstime, eciToGeodetic, geodeticToEcf, eciToEcf, ecfToLookAngles } from '../assets/satellite.es.js';

/* ------------------------------------------------------------------ state */
const $ = (s) => document.querySelector(s);
const canvas = $('#map'), ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = Math.max(1, window.devicePixelRatio || 1);

const state = {
  mode: 'tactical',
  layers: {},
  cx: 0, cy: 0,            // map centre in ENU metres
  scale: 0.9,               // px per metre
  dragging: false, moved: 0, lastX: 0, lastY: 0,
  hover: null, popup: null,
  d: {},                     // loaded data (geometry with pre-projected ENU coords)
  contours: [],
  relief: {},                // per-mode canvases
  tles: [],
  satrecs: new Map(),        // name -> {satrec, group}
  issTrack: null, issNow: null,
  dirty: true,
  time: Date.now(),
};

const MODES = {
  tactical: { sea: '#04100c', land: '#0a1913', grid: 'rgba(53,255,158,.06)', ink: '#b8ffe2',
    roads: { motorway: '#ffd166', trunk: '#ffb347', primary: '#e8e0b0' },
    rail: '#ff7b7b', water: '#1d4e63', urban: 'rgba(63,201,142,.10)', text: '#7effc4' },
  relief: { sea: '#06212e', land: null, grid: 'rgba(255,255,255,.04)', ink: '#e8f6ff',
    roads: { motorway: '#ff5c5c', trunk: '#ff9e42', primary: '#fff' },
    rail: '#444', water: '#2d7fa8', urban: 'rgba(255,255,255,.06)', text: '#dfe' },
  radar: { sea: '#020605', land: '#04120c', grid: 'rgba(53,255,158,.10)', ink: '#35ff9e',
    roads: { motorway: 'rgba(53,255,158,.5)', trunk: 'rgba(53,255,158,.4)', primary: 'rgba(53,255,158,.3)' },
    rail: 'rgba(53,255,158,.3)', water: 'rgba(53,255,158,.12)', urban: 'rgba(53,255,158,.05)', text: '#35ff9e' },
  night: { sea: '#120405', land: '#1a0708', grid: 'rgba(255,90,90,.07)', ink: '#ffb0b0',
    roads: { motorway: '#ff6a6a', trunk: '#d44', primary: '#faa' },
    rail: '#f66', water: '#5a1d24', urban: 'rgba(255,80,80,.07)', text: '#ff9a9a' },
};

/* palettes for hillshade by mode */
function palFactory(mode) {
  if (mode === 'relief') return (h, t) => {
    if (h < 20) return [40, 90, 110];
    const ramp = [[60,110,70],[110,140,70],[170,160,90],[190,150,110],[200,190,180]];
    const i = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
    return ramp[i];
  };
  if (mode === 'radar') return (h, t) => [10 + t * 26, 40 + t * 66, 28 + t * 44];
  if (mode === 'night') return (h, t) => [40 + t * 60, 14 + t * 18, 16 + t * 20];
  return (h, t) => [24 + t * 40, 52 + t * 68, 40 + t * 52]; // tactical
}

/* ------------------------------------------------------------------ boot */
const QUOTES = [
  '"It was the executing of William the Conqueror\'s William Rufus here in 1100 that first put it on the map..." — not a quote, but the hunt was real.',
  'Every contour on this map came from the Space Shuttle Radar Topography Mission.',
  'The M3 may be a motorway, but locals will tell you it was a battleground.',
  'Sir William Chandler Roberts, RAF aerobatics legend, learned to fly at nearby Everinghame — that one is true.',
  'A Saxon word before the Domesday, still steaming after all these centuries.',
];
async function boot() {
  const log = $('#boot-log'), fill = $('#boot-fill');
  $('#boot-quote').textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  const step = async (label, fn) => {
    fill.style.width = (bootN += 12) + '%';
    try { await fn(); logLine(label, true); }
    catch (e) { logLine(label + ' — ' + e.message, false); }
  };
  let bootN = 4;
  function logLine(s, ok) {
    const d = document.createElement('div');
    d.innerHTML = `<span class="${ok ? 'ok' : 'err'}">[${ok ? ' OK ' : 'FAIL'}]</span> ${s}`;
    log.appendChild(d); log.scrollTop = 1e9;
  }
  await step('terrain (real SRTM 30m grid)', async () => {
    await loadTerrain();
    state.contours = contours(20);
    for (const m of Object.keys(MODES)) state.relief[m] = reliefCanvas(palFactory(m));
  });
  await step('open geodata (OSM / SRTM / Telegeography)', async () => {
    const names = ['places', 'roads', 'railways', 'water', 'urban', 'coast', 'counties', 'towers', 'cables'];
    const urls = { cables: 'assets/data/cables.geo.json' };
    const get = async (n) => (await fetch(urls[n] || `assets/data/${n}.geojson`)).json();
    const [places, roads, railways, water, urban, coast, counties, towers, cables] =
      await Promise.all(names.map(get));
    Object.assign(state.d, { places, roads, railways, water, urban, coast, counties, towers, cables });
  });
  await step('pre-compute ENU coordinates for static geometry', () => {
    // Transform all static GeoJSON from [lon,lat] to pre-projected ENU [ex,ey]
    // so draw functions skip the lon/lat -> world coordinate multiplication.
    projectFC(state.d.places);
    projectFC(state.d.roads);
    projectFC(state.d.railways);
    projectFC(state.d.water);
    projectFC(state.d.urban);
    projectFC(state.d.coast);
    projectFC(state.d.counties);
    projectFCTowers();
    projectFCCables();
    projectContourENU();
  });
  await step('satellite catalogue (CelesTrak, epoch-frozen)', loadTles);
  await step('live: air traffic (OpenSky)', () => refreshFlights().then(() => {}));
  await step('live: seismicity (USGS)', () => refreshQuakes().then(() => {}));
  await step('live: weather + sun (Open-Meteo)', () => refreshWx().then(() => {}));
  await step('ISS ground-track + next pass (SGP4)', () => {
    const rec = state.satrecs.get('ISS (ZARYA)');
    if (!rec) throw new Error('no ISS satrec');
    setSatrec(rec.satrec);
    state.issTrack = groundTrack(rec.satrec, 96);
    live.issPass = computePass(lookAngles, 48);
  });
  logLine(`next ISS pass visible: ${live.issPass ? fmtCountdown(live.issPass.start) : 'none in 48 h'}`, true);
  fill.style.width = '100%';
  setTimeout(() => {
    $('#boot').classList.add('hidden');
    $('#topbar').classList.remove('hidden');
    $('#app').classList.remove('hidden');
    onResize(); buildGotolist(); buildTicker();
    loop();
  }, 600);
  // background refreshers
  setInterval(() => refreshFlights().catch(() => {}), 15000);
  setInterval(() => refreshQuakes().catch(() => {}), 120000);
  setInterval(() => refreshWx().catch(() => {}), 300000);
}

/* ---- pre-project geometry to ENU world coordinates ---- */
function projectFC(fc) { // transforms in-place, storing _p arrays on geometry
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Point') {
      g._p = toWorld(g.coordinates[0], g.coordinates[1]);
    } else if (g.type === 'LineString') {
      g._p = g.coordinates.map(([lon, lat]) => toWorld(lon, lat));
    } else if (g.type === 'Polygon') {
      g._p = g.coordinates.map(ring => ring.map(([lon, lat]) => toWorld(lon, lat)));
    } else if (g.type === 'MultiLineString') {
      g._p = g.coordinates.map(line => line.map(([lon, lat]) => toWorld(lon, lat)));
    }
  }
}
function projectFCTowers() {
  for (const f of state.d.towers.features) {
    const [lon, lat] = f.geometry.coordinates;
    f.geometry._p = toWorld(lon, lat);
  }
}
function projectFCCables() {
  for (const f of state.d.cables.features) {
    const g = f.geometry;
    if (g.type === 'LineString') {
      g._p = g.coordinates.map(([lon, lat]) => toWorld(lon, lat));
    } else if (g.type === 'MultiLineString') {
      g._p = g.coordinates.map(line => line.map(([lon, lat]) => toWorld(lon, lat)));
    }
  }
}
function projectContourENU() {
  for (const c of state.contours) {
    for (const seg of c.segs) {
      seg[0] = toWorld(seg[0][0], seg[0][1]);
      seg[1] = toWorld(seg[1][0], seg[1][1]);
    }
  }
}

/* ---- fast projection from pre-computed ENU ---- */
function pxs(ex, ey) {
  return [(ex - state.cx) * state.scale + W / 2, (ey - state.cy) * state.scale + H / 2];
}

/* slow projection from lon/lat (live data) */
function px(lon, lat) { const [x, y] = toWorld(lon, lat); return [(x - state.cx) * state.scale + W / 2, (y - state.cy) * state.scale + H / 2]; }
function unpx(x, y) { return toLonLat(state.cx + (x - W / 2) / state.scale, state.cy + (y - H / 2) / state.scale); }
function onResize() {
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  state.dirty = true;
}
window.addEventListener('resize', onResize);

/* ------------------------------------------------------------------ draw */
function loop() {
  state.time = Date.now();
  if (state.dirty) { draw(); }
  drawRadar();
  updateClock();
  requestAnimationFrame(loop);
}

function draw() {
  state.dirty = false;
  const M = MODES[state.mode];
  ctx.fillStyle = M.sea; ctx.fillRect(0, 0, W, H);

  // relief base
  if (state.layers.terrain && state.relief[state.mode]) {
    const e = terrainExtent();
    const [x0, y0] = px(e.lonmin, e.latmax), [x1, y1] = px(e.lonmax, e.latmin);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.relief[state.mode], x0, y0, x1 - x0, y1 - y0);
  }

  if (state.layers.contours) drawContours(M);
  drawCoast(M);
  drawCounties(M);
  if (state.layers.urban) drawUrban(M);
  if (state.layers.water) drawLines(state.d.water, M.water, 1, (f) => f.properties.k === 'river' ? 2.2 : 1);
  if (state.layers.cables) drawCables(M);
  if (state.layers.roads) drawRoads(M);
  if (state.layers.rail) drawRail(M);
  if (state.layers.trafficflow) drawFlowSim(M);
  if (state.layers.places) drawPlaces(M);
  drawTowerMarkers(M);
  if (state.layers.quakes) drawQuakes(M);
  if (state.layers.flights) drawFlights(M);
  if (state.layers.iss) drawISS(M);
  drawHubRings(M);
  drawScaleBar(M);
}

function drawContours(M) {
  if (state.scale < 0.02) return;
  ctx.lineWidth = 1;
  const majorEvery = 5;
  let li = 0;
  for (const c of state.contours) {
    li++;
    ctx.strokeStyle = state.mode === 'relief'
      ? `rgba(70,50,30,${li % majorEvery ? 0.25 : 0.5})`
      : `rgba(53,255,158,${li % majorEvery ? 0.10 : 0.22})`;
    ctx.beginPath();
    for (const [p, q] of c.segs) {
      const [ax, ay] = pxs(p[0], p[1]); const [bx, by] = pxs(q[0], q[1]);
      if (Math.abs(ax - bx) > W) continue;
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }
}

function drawCoast(M) {
  ctx.strokeStyle = state.mode === 'relief' ? 'rgba(230,250,255,.7)' : 'rgba(80,180,255,.5)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const f of state.d.coast.features) {
    const cs = f.geometry._p;
    if (!cs) continue;
    let started = false;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (x < -3000 || x > W + 3000 || y < -3000 || y > H + 3000) { started = false; continue; }
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}
function drawCounties(M) {
  if (state.scale > 0.05) return;
  ctx.strokeStyle = 'rgba(255,214,102,.35)'; ctx.setLineDash([4, 5]); ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of state.d.counties.features) {
    const cs = f.geometry._p;
    if (!cs) continue;
    let started = false;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }
  ctx.stroke(); ctx.setLineDash([]);
}
function polyRing(geom) {
  const c = geom && geom._p;
  if (!c || !c.length) return [];
  return typeof c[0][0] === 'number' ? c : (c[0] || []);
}
function drawUrban(M) {
  if (state.scale < 0.03) return;
  ctx.fillStyle = M.urban;
  ctx.beginPath();
  for (const f of state.d.urban.features) {
    const cs = polyRing(f.geometry);
    if (cs.length < 3) continue;
    let started = false;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }
  ctx.fill();
}
function drawLines(fc, color, lw, styleFn) {
  ctx.lineWidth = lw;
  for (const f of fc.features) {
    ctx.strokeStyle = styleFn ? styleFn(f) || color : color;
    ctx.beginPath();
    let started = false;
    const cs = f.geometry._p || f.geometry.coordinates;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
function drawCables(M) {
  ctx.strokeStyle = state.mode === 'radar' ? 'rgba(53,255,158,.16)' : 'rgba(80,140,255,.22)';
  ctx.lineWidth = 1; ctx.beginPath();
  for (const f of state.d.cables.features) {
    const coords = f.geometry.type === 'LineString' ? [f.geometry._p]
      : f.geometry.type === 'MultiLineString' ? f.geometry._p : [];
    for (const line of coords) {
      if (!line) continue;
      let started = false;
      for (let i = 0; i < line.length; i += 4) {
        const [x, y] = pxs(line[i][0], line[i][1]);
        if (x < -500 || x > W + 500 || y < -500 || y > H + 500) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    }
  }
  ctx.stroke();
}

const ROAD_STYLE = (f) => {
  const h = f.properties.highway;
  if (h === 'motorway') return { c: 'motorway', w: 2.6 };
  if (h === 'trunk') return { c: 'trunk', w: 1.9 };
  if (h === 'primary') return { c: 'primary', w: 1.3 };
  return null;
};
function drawRoads(M) {
  if (state.scale < 0.015) return;
  const seen = new Set();
  for (const f of state.d.roads.features) {
    const st = ROAD_STYLE(f); if (!st) continue;
    ctx.strokeStyle = M.roads[st.c]; ctx.lineWidth = st.w;
    ctx.beginPath(); let started = false;
    const cs = f.geometry._p;
    if (!cs) continue;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const ref = f.properties.ref || f.properties.name;
    if (ref && state.scale > 0.04 && !seen.has(ref) && /^(M\d|A\d)/.test(ref)) {
      seen.add(ref);
      const mid = cs[Math.floor(cs.length / 2)];
      if (!mid) continue;
      const [x, y] = pxs(mid[0], mid[1]);
      if (x > 60 && x < W - 60 && y > 80 && y < H - 40) {
        ctx.font = '600 10px "IBM Plex Mono"';
        const w = ctx.measureText(ref).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x - w / 2, y - 8, w, 14);
        ctx.strokeStyle = M.roads[st.c]; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2, y - 8, w, 14);
        ctx.fillStyle = M.roads[st.c]; ctx.textAlign = 'center'; ctx.fillText(ref, x, y + 3);
      }
    }
  }
}
function drawRail(M) {
  if (state.scale < 0.02) return;
  ctx.strokeStyle = M.rail; ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 4]);
  for (const f of state.d.railways.features) {
    if (f.geometry.type !== 'LineString') continue;
    ctx.beginPath(); let started = false;
    const cs = f.geometry._p;
    if (!cs) continue;
    for (const [ex, ey] of cs) {
      const [x, y] = pxs(ex, ey);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (state.scale > 0.05) for (const f of state.d.railways.features) {
    if (f.geometry.type !== 'Point') continue;
    const p = f.geometry._p;
    if (!p) continue;
    const [x, y] = pxs(p[0], p[1]);
    const big = /Basingstoke/i.test(f.properties.name || '');
    ctx.strokeStyle = M.rail; ctx.lineWidth = 1.4;
    ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    ctx.fillStyle = big ? '#fff' : M.rail;
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    if (state.scale > 0.2 && f.properties.name) {
      ctx.font = '300 9px "IBM Plex Mono"'; ctx.fillStyle = M.text;
      ctx.fillText(f.properties.name, x + 6, y + 3);
    }
  }
}

/* synthetic flow dots on REAL road geometry */
let flowSeed = null;
function drawFlowSim(M) {
  if (state.scale < 0.05) return;
  if (!flowSeed) {
    flowSeed = [];
    const roads = state.d.roads.features.filter(f => /^(M3|M4|A30|A33|A34|A3)$/.test((f.properties.ref || '')));
    for (const f of roads) {
      const cs = f.geometry._p;
      if (!cs || cs.length < 2) continue;
      const n = f.properties.highway === 'motorway' ? 10 : 5;
      for (let i = 0; i < n; i++)
        flowSeed.push({ fc: cs, t: Math.random(), v: (0.00018 + Math.random() * 0.0002) * (Math.random() > 0.5 ? 1 : -1), ref: f.properties.ref });
    }
  }
  ctx.fillStyle = state.mode === 'night' ? 'rgba(255,120,120,.9)' : 'rgba(120,255,190,.9)';
  for (const s of flowSeed) {
    s.t += s.v * 30; if (s.t > 1) s.t -= 1; if (s.t < 0) s.t += 1;
    const idx = s.t * (s.fc.length - 1);
    const i0 = idx | 0, i1 = Math.min(i0 + 1, s.fc.length - 1);
    const ex = s.fc[i0][0] + (s.fc[i1][0] - s.fc[i0][0]) * (idx - i0);
    const ey = s.fc[i0][1] + (s.fc[i1][1] - s.fc[i0][1]) * (idx - i0);
    const [x, y] = pxs(ex, ey);
    if (x > 0 && x < W && y > 0 && y < H) ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
  }
}

const CAT_ICON = {
  pub: '▲', bar: '▲', restaurant: '◆', cafe: '◇', fast_food: '◆', cinema: '▶', theatre: '▶',
  supermarket: '■', convenience: '▪', chemist: '▪', bakery: '▪', butcher: '▪', newsagent: '▪',
  hotel: 'H', museum: 'M', attraction: '★', artwork: '✦', viewpoint: '★',
  sports_centre: '●', stadium: '◎', park: '♣', tower: '⚡', fuel: '⛽', pharmacy: '✚',
  hospital: '✚', clinic: '✚', dentist: '✚', police: '♦', fire_station: '♦', bank: '$', atm: '$',
  place_of_worship: '✝', school: '✏', college: '✏', townhall: 'T', library: 'B',
  parking: 'P', gym: '●', marketplace: '≋', community_centre: '⌂', veterinary: '✚',
  car_wash: '≈', other: '·',
};
function drawPlaces(M) {
  const th = state.scale > 0.5 ? null : state.scale > 0.15 ? /pub|restaurant|supermarket|cafe|hotel|tower|stadium|cinema|theatre|museum|hospital|place_of_worship/ : /tower|stadium|cinema|museum|hospital|place_of_worship|townhall/;
  ctx.font = '10px "IBM Plex Mono"'; ctx.textAlign = 'center';
  for (const f of state.d.places.features) {
    const c = f.properties.cat;
    if (th && !th.test(c)) continue;
    if (f.properties.name && /camp hospital|workhouse/i.test(f.properties.name)) continue;
    const p = f.geometry._p;
    if (!p) continue;
    const [x, y] = pxs(p[0], p[1]);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    const col = c === 'pub' || c === 'bar' ? '#ffb347' :
                c === 'tower' ? '#ff5c5c' :
                c === 'supermarket' ? '#4fd8ff' :
                state.mode === 'night' ? '#ff9a9a' : '#8ef7c9';
    ctx.fillStyle = col;
    ctx.fillText(CAT_ICON[c] || '·', x, y + 3);
    if (state.scale > 0.35 && f.properties.name && f.properties.name.length < 34) {
      ctx.fillStyle = M.text; ctx.font = '300 9px "IBM Plex Mono"';
      ctx.fillText(f.properties.name, x, y - 7);
      ctx.font = '10px "IBM Plex Mono"';
    }
  }
  ctx.textAlign = 'left';
}
function drawTowerMarkers(M) {
  const towers = state.d.towers.features.filter(f =>
    f.properties.src === 'curated' || (f.properties.height_m || 0) >= 120);
  for (const f of towers) {
    const p = f.geometry._p;
    if (!p) continue;
    const [x, y] = pxs(p[0], p[1]);
    if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
    const h = f.properties.height_m || 100;
    const pxPerM = Math.max(0.05, state.scale * 4);
    const len = Math.min(60, 8 + h * pxPerM);
    ctx.strokeStyle = h > 250 ? '#ff5c5c' : '#ffb347'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - len); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(x, y - len, 2, 0, Math.PI * 2); ctx.fill();
    if (state.scale > 0.02 && h > 150) {
      ctx.font = '300 9px "IBM Plex Mono"'; ctx.fillStyle = M.text;
      ctx.fillText(`${f.properties.name} ${h} m`, x + 5, y - len);
    }
  }
}

function drawQuakes(M) {
  for (const q of live.quakes) {
    const [x, y] = px(q.lon, q.lat);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const r = 3 + q.mag * q.mag * 0.8;
    ctx.strokeStyle = q.mag >= 6 ? '#ff5c5c' : q.mag >= 5 ? '#ffb347' : '#ffe08a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - r - 2, y); ctx.lineTo(x + r + 2, y);
    ctx.moveTo(x, y - r - 2); ctx.lineTo(x, y + r + 2); ctx.stroke();
  }
  const notable = live.quakes.slice(0, 1);
  ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
  for (const q of notable) {
    const [qx, qy] = px(q.lon, q.lat);
    const [bx, by] = px(LON0, LAT0);
    if (Math.hypot(qx - bx, qy - by) > 140) {
      ctx.strokeStyle = 'rgba(255,92,92,.35)';
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(qx, qy); ctx.stroke();
      const mx = (bx + qx) / 2, my = (by + qy) / 2;
      const [lon, lat] = unpx(mx, my);
      ctx.font = '300 9px "IBM Plex Mono"'; ctx.fillStyle = 'rgba(255,140,140,.8)';
      ctx.textAlign = 'center';
      ctx.fillText(`M${q.mag.toFixed(1)} · ${fmtDist(LAT0, LON0, q.lat, q.lon)}`, mx, my - 4);
      ctx.textAlign = 'left';
    }
  }
  ctx.setLineDash([]);
}

function drawFlights(M) {
  const showLabels = state.scale > 0.012;
  for (const f of live.flights) {
    const [x, y] = px(f.lon, f.lat);
    if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
    const a = (f.heading || 0) * Math.PI / 180;
    const altFt = Math.round(f.geoAlt * 3.281);
    const col = state.mode === 'night' ? '#ff6a6a' : '#eafff6';
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2); ctx.lineTo(-5, 5); ctx.closePath();
    ctx.fill(); ctx.restore();
    if (showLabels) {
      ctx.font = '300 9px "IBM Plex Mono"';
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      const t1 = f.callsign, t2 = `FL${Math.round(altFt / 100)}`;
      ctx.fillRect(x + 8, y - 12, Math.max(ctx.measureText(t1).width, 26) + 6, 22);
      ctx.fillStyle = state.mode === 'night' ? '#ff9a9a' : '#b8ffe2';
      ctx.fillText(t1, x + 11, y - 3); ctx.fillText(t2, x + 11, y + 7);
    }
  }
}

function drawISS(M) {
  if (!state.issTrack) return;
  ctx.strokeStyle = 'rgba(79,216,255,.6)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
  ctx.beginPath(); let started = false;
  for (const [lon, lat] of state.issTrack) {
    const [x, y] = px(lon, lat);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.setLineDash([]);
  const rec = state.satrecs.get('ISS (ZARYA)');
  if (rec) {
    const p = satPos(rec.satrec, new Date());
    if (p) {
      state.issNow = p;
      const [x, y] = px(p.lon, p.lat);
      ctx.strokeStyle = '#4fd8ff'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
      ctx.font = '300 9px "IBM Plex Mono"'; ctx.fillStyle = '#4fd8ff';
      ctx.fillText(`ISS · ${p.alt.toFixed(0)} km`, x + 9, y - 8);
    }
  }
}

function drawHubRings(M) {
  const [bx, by] = px(LON0, LAT0);
  ctx.strokeStyle = M.roads.motorway; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx - 12, by); ctx.lineTo(bx + 12, by); ctx.moveTo(bx, by - 12); ctx.lineTo(bx, by + 12); ctx.stroke();
  if (state.scale > 0.05) {
    ctx.font = '500 11px "IBM Plex Mono"'; ctx.fillStyle = M.text;
    ctx.fillText('BASINGSTOKE', bx + 9, by + 14);
  }
}

function drawScaleBar(M) {
  const targetPx = 140, metres = targetPx / state.scale;
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  const m = nice.find(v => v >= metres) || 500000;
  const wpx = m * state.scale;
  ctx.strokeStyle = M.ink; ctx.lineWidth = 1.4; ctx.font = '300 10px "IBM Plex Mono"';
  const x0 = 16, y0 = H - 46;
  ctx.beginPath(); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + wpx, y0); ctx.lineTo(x0 + wpx, y0 - 4); ctx.stroke();
  ctx.fillStyle = M.ink; ctx.fillText(m >= 1000 ? m / 1000 + ' km' : m + ' m', x0 + wpx + 6, y0 + 3);
}

/* ------------------------------------------------------------------ radar */
const radar = $('#radar'), rctx = radar.getContext('2d');
let sweep = 0;
function drawRadar() {
  if (state.mode !== 'radar') { $('#radarbox').classList.add('hidden'); return; }
  $('#radarbox').classList.remove('hidden');
  const R = radar.width / 2, RANGE = 120000;
  rctx.fillStyle = 'rgba(2,8,6,.3)'; rctx.fillRect(0, 0, 560, 560);
  rctx.strokeStyle = 'rgba(53,255,158,.28)'; rctx.lineWidth = 1;
  for (const rr of [30, 60, 90, 120]) {
    rctx.beginPath(); rctx.arc(R, R, rr / RANGE * R, 0, Math.PI * 2); rctx.stroke();
    rctx.fillStyle = 'rgba(53,255,158,.5)'; rctx.font = '9px "IBM Plex Mono"';
    rctx.fillText(rr + ' km', R + 3, R - rr / RANGE * R - 2);
  }
  rctx.beginPath(); rctx.moveTo(0, R); rctx.lineTo(560, R); rctx.moveTo(R, 0); rctx.lineTo(R, 560); rctx.stroke();
  // roads hint within range (use pre-projected ENU)
  rctx.strokeStyle = 'rgba(53,255,158,.14)';
  for (const f of state.d.roads.features) {
    if (!['motorway', 'trunk'].includes(f.properties.highway)) continue;
    const cs = f.geometry._p;
    if (!cs) continue;
    rctx.beginPath(); let started = false;
    for (const [ex, ey] of cs) {
      if (Math.hypot(ex, ey) > RANGE) { started = false; continue; }
      const x = R + ex / RANGE * R, y = R - ey / RANGE * R;
      if (!started) { rctx.moveTo(x, y); started = true; } else rctx.lineTo(x, y);
    }
    rctx.stroke();
  }
  sweep += 0.017;
  rctx.save(); rctx.translate(R, R); rctx.rotate(sweep);
  const grad = rctx.createLinearGradient(0, 0, R, 0);
  grad.addColorStop(0, 'rgba(53,255,158,.45)'); grad.addColorStop(1, 'rgba(53,255,158,.0)');
  rctx.fillStyle = grad; rctx.beginPath(); rctx.moveTo(0, 0);
  rctx.arc(0, 0, R, -0.35, 0); rctx.closePath(); rctx.fill();
  rctx.strokeStyle = 'rgba(150,255,210,.9)'; rctx.beginPath(); rctx.moveTo(0, 0); rctx.lineTo(R, 0); rctx.stroke();
  rctx.restore();
  const now = state.time / 1000;
  rctx.font = '9px "IBM Plex Mono"';
  for (const f of live.flights) {
    const e = (f.lon - LON0) * KX, n = -(f.lat - LAT0) * KY;
    if (Math.hypot(e, n) > RANGE) continue;
    const x = R + e / RANGE * R, y = R - n / RANGE * R;
    const ang = (Math.atan2(x - R, -(y - R)) * 180 / Math.PI + 360) % 360;
    const sw = (sweep * 180 / Math.PI + 360) % 360;
    let age = (sw - ang + 360) % 360 / 360 * 4;
    const bright = Math.max(0.12, 1 - age / 4);
    rctx.fillStyle = `rgba(150,255,210,${bright})`;
    rctx.fillRect(x - 2, y - 2, 4, 4);
    if (bright > 0.5) {
      rctx.fillStyle = `rgba(255,179,71,${bright})`;
      rctx.fillText(`${f.callsign.slice(0, 7)} ${Math.round(f.geoAlt * 3.281 / 1000).toString().padStart(3, '0')}`, x + 5, y + 2);
    }
  }
  if (state.issNow && Math.hypot((state.issNow.lon - LON0) * KX, (state.issNow.lat - LAT0) * KY) < RANGE) {
    const x = R + (state.issNow.lon - LON0) * KX / RANGE * R, y = R - (state.issNow.lat - LAT0) * KY / RANGE * R;
    rctx.fillStyle = '#4fd8ff'; rctx.fillText('SAT', x + 4, y);
    rctx.strokeStyle = '#4fd8ff'; rctx.strokeRect(x - 3, y - 3, 6, 6);
  }
}

/* ------------------------------------------------------------------ interaction */
canvas.addEventListener('mousedown', e => { state.dragging = true; state.moved = 0; state.lastX = e.clientX; state.lastY = e.clientY; });
window.addEventListener('mouseup', () => state.dragging = false);
window.addEventListener('mousemove', e => {
  if (state.dragging) {
    const dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
    state.moved += Math.abs(dx) + Math.abs(dy);
    state.cx -= dx / state.scale; state.cy -= dy / state.scale;
    state.lastX = e.clientX; state.lastY = e.clientY;
    state.dirty = true;
  }
  const [lon, lat] = unpx(e.clientX, e.clientY);
  $('#cursor-coords').textContent = osGridRef(lon, lat);
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const [lon, lat] = unpx(e.clientX, e.clientY);
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  state.scale = Math.max(0.0016, Math.min(3.2, state.scale * k));
  const [nx, ny] = toWorld(lon, lat);
  state.cx = nx - (e.clientX - W / 2) / state.scale;
  state.cy = ny - (e.clientY - H / 2) / state.scale;
  $('#zoom-level').textContent = 'z' + state.scale.toFixed(3);
  state.dirty = true;
}, { passive: false });
canvas.addEventListener('click', e => {
  if (state.moved > 4) return;
  const [lon, lat] = unpx(e.clientX, e.clientY);
  let best = null, bd = 1e18;
  const near = (lon2, lat2, label, body, radiusPx) => {
    const [x, y] = px(lon2, lat2);
    const d = Math.hypot(x - e.clientX, y - e.clientY);
    if (d < radiusPx && d < bd) { bd = d; best = { label, body }; }
  };
  for (const f of live.flights) near(f.lon, f.lat, f.callsign + ' · ' + f.icao,
    `<b>${f.callsign}</b><br>altitude ${Math.round(f.geoAlt * 3.281).toLocaleString()} ft · ${Math.round(f.speed)} km/h<br>heading ${Math.round(f.heading)}° ${compass(f.heading)} · vs ${Math.round(f.vs)} ft/min<br>squawk ${f.squawk || '—'}<br>${fmtDist(LAT0, LON0, f.lat, f.lon)} ${compass(bearing(LON0, LAT0, f.lon, f.lat))} of BASE`, 14);
  for (const q of live.quakes) near(q.lon, q.lat, `M${q.mag} ${q.place}`,
    `<b>M${q.mag.toFixed(1)}</b> — ${q.place}<br>depth ${Math.round(q.depth)} km<br>${new Date(q.time).toUTCString()}<br>${fmtDist(LAT0, LON0, q.lat, q.lon)} from Basingstoke`, 12);
  for (const f of state.d.places.features) {
    if (state.scale < 0.15) continue;
    near(f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties.name,
      `<b>${f.properties.name}</b><br>${f.properties.cat}${f.properties.cuisine ? ' · ' + f.properties.cuisine : ''}${f.properties.opening_hours ? '<br>' + f.properties.opening_hours : ''}<br><span style="opacity:.6">OSM feature · live-plotted</span>`, 10);
  }
  if (best) showPopup(e.clientX, e.clientY, best); else $('#popup').classList.add('hidden');
});
function showPopup(x, y, { label, body }) {
  const p = $('#popup');
  $('#popup-title').textContent = label; $('#popup-body').innerHTML = body;
  p.classList.remove('hidden');
  p.style.left = Math.min(x + 14, W - 320) + 'px';
  p.style.top = Math.min(y + 14, H - 180) + 'px';
}
$('#popup-close').onclick = () => $('#popup').classList.add('hidden');

/* layer toggles + mode tabs */
document.querySelectorAll('[data-layer]').forEach(cb => {
  state.layers[cb.dataset.layer] = cb.checked;
  cb.onchange = () => { state.layers[cb.dataset.layer] = cb.checked; state.dirty = true; };
});
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active'); state.mode = t.dataset.mode; state.dirty = true;
  radar.style.display = state.mode === 'radar' ? 'block' : 'none';
});

const GOTOS = [
  ['⌖ Basingstoke centre', LON0, LAT0, 0.9],
  ['▲ Danebury Hillfort', -1.2919, 51.2198, 0.35],
  ['▲ Old Down Barrow', -1.2260, 51.2130, 0.35],
  ['⚡ Black Download aerial mast', -1.0369, 51.2875, 0.25],
  ['♣ Beaver County Park', -1.1230, 51.2560, 0.35],
  ['♣ Strawberry Place', -1.0830, 51.2560, 0.35],
  ['T Town Hall', -1.0899, 51.2644, 0.6],
  ['⛽ M3/A30 Huntley Junction', -1.1089, 51.2517, 0.3],
  ['▣ The Malls', -1.0930, 51.2630, 0.5],
  ['⚡ No 1 Roundabout', -1.0817, 51.2611, 0.5],
];
function buildGotolist() {
  const box = $('#gotolist');
  for (const [label, lon, lat, sc] of GOTOS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { const [x, y] = toWorld(lon, lat); state.cx = x; state.cy = y; state.scale = sc; state.dirty = true; };
    box.appendChild(b);
  }
}

/* ------------------------------------------------------------------ panels + live intel fusion */
function hubDistanceTable() {
  const HUBS = [
    ['London Waterloo', -0.1139, 51.5031], ['Reading', -0.9710, 51.4543],
    ['Southampton Central', -1.4206, 50.9053], ['Bournemouth', -1.8798, 50.7192],
    ['Gatwick Airport', -0.1900, 51.1537], ['Heathrow Airport', -0.4685, 51.4700],
    ['Portsmouth Harbour', -1.1036, 50.7995], ['Salisbury', -1.7940, 51.0699],
    ['Oxford', -1.2578, 51.7540], ['Newbury', -1.3965, 51.4007],
    ['Winchester', -1.3114, 51.0632], ['London (city centre)', -0.1276, 51.5074],
  ];
  return HUBS.map(([n, lon, lat]) => [n, haversine(LON0, LAT0, lon, lat) / 1000, bearing(LON0, LAT0, lon, lat)])
    .sort((a, b) => a[1] - b[1]);
}

/* Live intel fusion engine — cross-references all live feeds and populates
   synthesized alerts + situational awareness data on the `live` object. */
function analyseSituation() {
  const report = { alerts: [], summary: '', wxTrend: '' };

  // Weather trend
  if (live.wx) {
    const p = live.wx.press || 0;
    report.wxTrend = p > 1025 ? 'HIGH' : p > 1015 ? 'rising' : p > 1005 ? 'stable' : 'LOW (depression)';
    if (live.wx.lightning > 60) report.alerts.push(`⚡ High lightning potential: ${live.wx.lightning}%`);
  }

  // Nearest flight
  if (live.flights.length) {
    let nearest = null, nearDist = 1e9;
    for (const f of live.flights) {
      const d = haversine(LON0, LAT0, f.lon, f.lat);
      if (d < nearDist) { nearDist = d; nearest = f; }
    }
    if (nearest) {
      const km = nearDist / 1000;
      const etaMin = nearest.speed > 10 ? (km / nearest.speed * 60).toFixed(1) : '?';
      report.nearestFlight = { callsign: nearest.callsign, km, alt: nearest.geoAlt, heading: nearest.heading, etaMin };
      if (km < 15 && nearest.geoAlt < 1000) report.alerts.push(`✈ Low overflight: ${nearest.callsign} ${km.toFixed(1)} km @ ${Math.round(nearest.geoAlt * 3.281)} ft`);
    }
  }

  // Nearest quake
  if (live.quakes.length) {
    let nearQ = null, qDist = 1e9;
    for (const q of live.quakes) {
      const d = haversine(LON0, LAT0, q.lon, q.lat);
      if (d < qDist) { qDist = d; nearQ = q; }
    }
    if (nearQ) {
      const km = qDist / 1000;
      const travelS = km / 6; // ~6 km/s seismic wave
      const travelMin = travelS > 60 ? Math.round(travelS / 60) + ' min' : Math.round(travelS) + ' s';
      report.nearestQuake = { mag: nearQ.mag, place: nearQ.place, km, travelMin };
      if (nearQ.mag >= 5 && km < 500) report.alerts.push(`🌍 Significant quake M${nearQ.mag.toFixed(1)} · ${km.toFixed(0)} km away (wave travel ~${travelMin})`);
    }
  }

  // ISS pass imminent?
  if (live.issPass) {
    const until = live.issPass.start - Date.now();
    if (until > 0 && until < 3600000) {
      const min = Math.round(until / 60000);
      report.alerts.push(`🛰 ISS pass in ${min} min — elevation ${live.issPass.maxEl.toFixed(0)}° ${compass(live.issPass.peakAz)}`);
    }
  }

  // Build summary line
  const parts = [];
  if (report.nearestFlight) parts.push(`Closest: ${report.nearestFlight.callsign} ${report.nearestFlight.km.toFixed(1)} km`);
  if (report.nearestQuake) parts.push(`Quake M${report.nearestQuake.mag.toFixed(1)} ${report.nearestQuake.km.toFixed(0)} km away`);
  if (live.wx) parts.push(`WX ${live.wx.temp.toFixed(0)}°C ${live.wx.wind.toFixed(0)} km/h (${report.wxTrend})`);
  report.summary = parts.join(' · ');

  live.alerts = report.alerts;
  live.situation = report;
}

function renderPanels() {
  // Run live intel fusion first
  analyseSituation();

  // ISS
  const p = live.issPass;
  $('#iss-body').innerHTML = p ? `
    <div class="frow"><span>NOW</span><b>${live.issNow ? live.issNow.lat.toFixed(1) + '° ' + live.issNow.lon.toFixed(1) + '° · ' + live.issNow.alt.toFixed(0) + ' km' : '—'}</b></div>
    <div class="frow"><span>T-</span><b class="num">${fmtCountdown(p.start)}</b></div>
    <div class="frow"><span>start</span><b>${p.start.toLocaleTimeString('en-GB')} · az ${Math.round(p.startAz)}° ${compass(p.startAz)}</b></div>
    <div class="frow"><span>max elevation</span><b class="num">${p.maxEl.toFixed(1)}° @ ${Math.round(p.peakAz)}° ${compass(p.peakAz)}</b></div>
    <div class="frow"><span>ends</span><b>${p.end ? p.end.toLocaleTimeString('en-GB') + ' · az ' + compass(p.endAz) : '—'}</b></div>`
    : 'no pass above 10° elevation in next 48 h';
  // flights
  const near = live.flights.map(f => [f, haversine(LON0, LAT0, f.lon, f.lat) / 1000])
    .sort((a, b) => a[1] - b[1]).slice(0, 7);
  $('#flights-body').innerHTML = near.map(([f, km]) =>
    `<div class="frow"><span class="cs">${f.callsign.slice(0, 8)}</span><span>${km.toFixed(0)} km · ${compass(bearing(LON0, LAT0, f.lon, f.lat))} · ${Math.round(f.geoAlt * 3.281 / 1000)}k ft</span></div>`).join('') || '—';
  $('#n-flights').textContent = live.flights.length;
  // quakes
  $('#quakes-body').innerHTML = live.quakes.slice(0, 4).map(q =>
    `<div class="frow"><span>M${q.mag.toFixed(1)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px">${q.place}</span></div>`).join('') || 'quiet world';
  $('#n-quakes').textContent = live.quakes.length;
  // hub analysis
  const hubs = hubDistanceTable();
  $('#hub-body').innerHTML =
    `<div class="frow"><span>grid ref</span><b class="num">${osGridRef(LON0, LAT0)}</b></div>` +
    hubs.map(([n, km, brg]) =>
      `<div class="frow"><span>${n}</span><b>${km.toFixed(0)} km · ${compass(brg)}</b></div>`).join('');
  // local intel — now dynamic synthesised situational awareness
  const sit = live.situation;
  let intelHtml = '';
  if (sit && sit.summary) {
    intelHtml += `<div class="frow"><span>status</span><b class="num">${sit.summary}</b></div>`;
    if (sit.nearestFlight) {
      intelHtml += `<div class="frow"><span>✈ nearest</span><b>${sit.nearestFlight.callsign} · ${sit.nearestFlight.km.toFixed(1)} km · ETA ${sit.nearestFlight.etaMin} min</b></div>`;
    }
    if (sit.nearestQuake) {
      intelHtml += `<div class="frow"><span>🌍 quake</span><b>M${sit.nearestQuake.mag.toFixed(1)} · ${sit.nearestQuake.km.toFixed(0)} km (wave ~${sit.nearestQuake.travelMin})</b></div>`;
    }
    if (live.wx) {
      intelHtml += `<div class="frow"><span>🌡 wx</span><b>${live.wx.temp.toFixed(0)}°C feels ${live.wx.feels.toFixed(0)}°C · ${live.wx.wind.toFixed(0)} km/h ${compass(live.wx.wdir)} · pressure ${sit.wxTrend}</b></div>`;
    }
  }
  if (!renderPanels.cached) {
    const st = terrainStats();
    renderPanels.cached = `
      <div class="frow"><span>town elevation</span><b>${heightAt(LON0, LAT0).toFixed(0)} m AOD</b></div>
      <div class="frow"><span>mean (20km box)</span><b>${st.mean.toFixed(0)} m</b></div>
      <div class="frow"><span>high point</span><b>${st.max.toFixed(0)} m</b></div>
      <div class="frow"><span>low point</span><b>${st.min.toFixed(0)} m</b></div>
      <div class="frow"><span>OSM POIs mapped</span><b class="num">${state.d.places.features.length}</b></div>
      <div class="frow"><span>road segs (M/A)</span><b class="num">${state.d.roads.features.length}</b></div>
      <div class="frow"><span>rail segs</span><b class="num">${state.d.railways.features.filter(f=>f.geometry.type==='LineString').length}</b></div>`;
  }
  $('#intel-body').innerHTML = intelHtml + (renderPanels.cached || '');
  // wx chip
  const w = live.wx;
  if (w) $('#wx-chip').textContent = `WX ${w.temp.toFixed(0)}°C · ${w.wind.toFixed(0)} km/h · ${w.cloud}% ☁`;
  $('#sats-chip').textContent = `SAT ${state.satrecs.size}`;
  $('#fly-count').textContent = 'TRACKS ' + live.flights.length;
  $('#last-sync').textContent = 'SYNC ' + new Date().toLocaleTimeString('en-GB');
}
setInterval(renderPanels, 3000);

function updateClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString('en-GB');
  $('#date').textContent = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}

function buildTicker() {
  const items = [
    'BASINGSTOKE·VIEW online',
    'TERRAIN: NASA SRTM 30 m (AWS open data)',
    'POIs: OpenStreetMap (ODbL)',
    'AIR: OpenSky Network — live',
    'QUAKES: USGS M2.5+ — live',
    'ISS: CelesTrak TLE + SGP4 — computed over-the-town',
    'WX: Open-Meteo — live',
    'OSGB grid transform implemented from OS guide (Helmert OSTN15 params)',
    'You are viewing SU 85 54. Population of the parish: ~111,000. Milk product: Basing. Cream: Double.',
  ];
  $('#ticker-track').textContent = items.join('  ///  ') + '  ///  ';
}

/* Live situation ticker override — replaces static ticker with rotating alerts */
let alertIdx = 0;
setInterval(() => {
  if (live.alerts && live.alerts.length) {
    alertIdx = (alertIdx + 1) % live.alerts.length;
    const ticker = $('#ticker-track');
    if (ticker) ticker.textContent = '⚠ ' + live.alerts[alertIdx] + '  ///  ';
  }
}, 8000);

function refreshTlesLive() {
  fetch('/proxy?url=' + encodeURIComponent('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE'))
    .then(r => { if (!r.ok) throw new Error(); return r.text(); })
    .then(txt => {
      const lines = txt.trim().split(/\r?\n/);
      if (lines.length >= 3) {
        const satrec = twoline2satrec(lines[1], lines[2]);
        if (satrec && !satrec.error) {
          state.satrecs.set('ISS (ZARYA)', { satrec, name: 'ISS (ZARYA)', group: 'stations' });
          state.issTrack = groundTrack(satrec, 96);
          setSatrec(satrec);
          live.issPass = computePass(lookAngles, 48);
          $('#sats-chip').textContent = 'SAT ' + state.satrecs.size + ' +LIVE';
        }
      }
    }).catch(() => { /* snapshot already loaded */ });
}
setInterval(refreshTlesLive, 30 * 60000);

boot();
