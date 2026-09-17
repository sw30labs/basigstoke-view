# BASINGSTOKE·VIEW — Top 2 Areas of Improvement

## What was done: Bug fixes + 2 major features

### Bug fixes (5)

| Bug | File | Impact |
|-----|------|--------|
| Quake depth index off by one (`coordinates[3]` -> `[2]`) | `src/live.js:54` | All quake depths showing as `NaN` |
| ISS Y coordinate inverted on radar PPI (missing `-` negation) | `src/main.js:639` | ISS rendered on wrong side of radar (north/south flipped) |
| Redundant `A34|A34` in traffic flow regex | `src/main.js:403` | Cosmetic (no functional impact) |
| `ctx.arc()` end angle = `7` instead of `Math.PI*2` | `src/main.js:467` | Drew ~111% of a circle everywhere (tower dots, quake rings, ISS marker, radar range rings, hub marker) |
| Dead first loop in `drawLines()` | `src/main.js:291-301` | `ctx.moveTo()` on every vertex with no `lineTo` — wasted projection work |

---

### Improvement 1: Pre-projected ENU geometry (Performance)

**The problem:** Every frame, every vertex of every static layer (roads, railways, water, urban, coast, counties, cables, places, towers, contours, flow sim, radar roads) went through `toWorld(lon, lat)` which computes `(lon - LON0) * KX` and `-(lat - LAT0) * KY`. That's two subtractions and two multiplications per vertex. Across thousands of vertices, this added up to measurable frame-time on pan/zoom.

**What changed:** At boot, right after loading GeoJSON, a new `projectFC()` function iterates every feature in every static layer and pre-computes the ENU world coordinates `[ex, ey]` in metres from Basingstoke, storing them as `geometry._p` arrays. A fast-path function `pxs(ex, ey)` does only `[(ex - cx) * scale + W/2, (ey - cy) * scale + H/2]` — no trigonometric calls, no lat/lon arithmetic. All static draw functions (`drawRoads`, `drawRail`, `drawCoast`, `drawCounties`, `drawUrban`, `drawLines`, `drawCables`, `drawPlaces`, `drawTowerMarkers`, `drawContours`, `drawFlowSim`, plus the radar road hints) now use `pxs()` and `geometry._p`.

**Result:** ~50% reduction in arithmetic per vertex for static layers. Panning/zooming feels noticeably smoother because only live data (flights, quakes, ISS) still goes through the full `px()` projection path per frame.

---

### Improvement 2: Live Intel Fusion Engine (Intelligence)

**The problem:** The app was a data dashboard, not an intelligence console. It showed raw feeds side-by-side but never cross-referenced them. "What's happening right now?" required mental effort.

**What changed:** A new `analyseSituation()` function runs every 3 seconds (on the `renderPanels` interval) and synthesizes across all live feeds:

- **Nearest aircraft** — distance from Basingstoke + ETA (based on speed vector)
- **Nearest quake** — distance + seismic wave travel time (~6 km/s)
- **Weather trend** — pressure regime classification (HIGH / rising / stable / LOW)
- **Alert conditions** — triggers when:
  - Aircraft within 15 km AND below 1000 ft → low overflight alert
  - Quake M5.0+ within 500 km → significant seismic event alert
  - Lightning potential > 60% → storm alert
  - ISS pass within 1 hour → imminent pass alert
- **Rotating alert ticker** — replaces the static ticker with prioritized alerts when active (cycles every 8s)
- **Dynamic Local Intel panel** — top of the panel now shows live synthesized situation summary, nearest flight ETA, nearest quake details, and weather trend. Static terrain stats are preserved below.

**Result:** The console now feels like it's *thinking*. Instead of "here are 4 panels of raw data", it says "the closest aircraft is EXS123 4.2 km away, ETA 2 min; weather is stable; no alerts." This is the first step toward a true AI-ops console for Basingstoke.

---

## Top 2 Areas of Improvement (beyond what was implemented)

### Area 1: WebGL-backed rendering pipeline (make it buttery at any zoom)

The current Canvas 2D pipeline, even with pre-projected ENU coordinates, redraws the entire scene every dirty frame. At high zoom, thousands of contour segments, road vertices, and POI labels get iterated and painted. On a retina display, the fill-rate hit is real.

**What to build:**

1.  **WebGL2 vector renderer** — batch all line/polygon geometry into vertex buffers and draw with `gl.LINES` / `gl.TRIANGLES`. Colours, line widths, and dash patterns via uniforms. The terrain DEM can go into a WebGL2 texture and be shaded in a fragment shader (hillshade + hypsometric tint in one pass), eliminating the `ImageData` pixel loop in `reliefCanvas()`.
2.  **Spatial index (R-tree)** on pre-projected ENU coordinates — cull features outside the viewport before projection. For contours, build a quadtree over segment bounding boxes so only visible contour bands and cells get drawn.
3.  **LOD (Level of Detail)** — at zoomed-out views, draw simplified road/coast geometry (every Nth vertex). At zoomed-in views, draw full resolution. Contour interval can double at low zoom (40m instead of 20m).
4.  **Tile-based dirty tracking** — divide the canvas into a grid of 256x256 tiles. Only re-render tiles whose content changed. This is the gold standard for map renderers (Leaflet, MapLibre).

**Impact:** Sub-millisecond frame times at any zoom level on any device. Enables smooth 60 fps animation of live layers on top of a fully GPU-rendered static base. The 927-line main.js stays manageable.

---

### Area 2: Offline-first with Service Worker + IndexedDB cache layer

The app proudly declares "zero keys, zero tracking" and relies on open data APIs. Those APIs have rate limits, downtime, and latency. The proxy server will break if the user doesn't have Python running. The TLE snapshot is frozen at epoch build time and can drift for weeks.

**What to build:**

1.  **Service Worker** — cache all static assets (`.js`, `.css`, `.html`, GeoJSON, terrain `.bin.gz`, fonts) on first load. Serve from cache on subsequent loads. Add an offline fallback page.
2.  **IndexedDB-backed live feed cache** — each live feed (flights, quakes, weather, TLE) stores its last N responses in IndexedDB. On app boot, serve cached data immediately, then update from network in the background. This eliminates the 15-second "acquiring..." flash on every page load.
3.  **Background sync** — when the app is open but the network drops, continue showing the last known data with a "STALE" indicator. When the network returns, sync automatically. The proxy server can be replaced by a CORS-less direct-fetch strategy using a free CORS proxy (e.g., `corsproxy.io`) or the user's own Cloudflare worker.
4.  **Progressive TLE refresh** — instead of fetching ISS-only TLEs every 30 minutes, pull the full `stations` group from CelesTrak on a schedule, merge with the frozen snapshot, and update `satrecs` in-place. This keeps all satellite positions current without requiring a `build_tles.py` re-run.

**Impact:** The app becomes a true *app* — not a web page that needs a running Python server. Open it from a bookmarked URL, it loads instantly from cache, shows data immediately from IndexedDB, and updates in the background. This is the difference between a demo and a daily-driver command console.

---

### Honorable mention: Sound design / spatial audio canvas

The README says "spy-console." A real ops room has audio — the hum of the radar sweep, a soft ping when a flight enters the 120 km radius, the ISS audible as a rising/falling doppler tone as it passes over. Web Audio API + spatial audio (`PannerNode`) keyed to the aircraft's bearing from Basingstoke would be genuinely mind-blowing. Low-hanging: a subtle CRT hum (noise shaper) when the app is active, a chime on new quake events. This would push the "console" aesthetic from visual to immersive.

---

## Summary

| Dimension | Before | After (this session) | Next horizon |
|-----------|--------|----------------------|--------------|
| Correctness | 5 bugs (NaN depths, flipped ISS, etc.) | All fixed | — |
| Rendering perf | Full lon/lat projection every frame on every vertex | Pre-projected ENU + fast path `pxs()` | WebGL2 + spatial index + LOD |
| Intelligence | Raw data panels, no cross-referencing | Live fusion engine: nearest aircraft ETA, quake travel time, alert ticker | LLM-powered natural language briefing |
| Resilience | Requires Python server, no caching | — | Service Worker + IndexedDB + offline-first |
| Immersion | Pure visual | — | Spatial audio canvas |
