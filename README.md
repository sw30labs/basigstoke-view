# BASINGSTOKE·VIEW

**A local intelligence console pointed permanently at one town: Basingstoke, Hampshire, England.**

Inspired by [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (global spatial
intelligence) — inverted. Instead of the whole Earth, everything about **one place**, down to
the contour interval. OS grid square SU85. 51°15′49″N 01°05′27″W.

The entire app is a custom canvas engine — no Cesium, no Leaflet, no map library.
Every pixel is drawn from real data.

```
python3 server.py            # -> http://127.0.0.1:8123
```

That's it. No build step, no npm install, no API keys.

---

## What you get

**One town, four lenses** — `TACTICAL` (phosphor green ops console), `RELIEF`
(hypsometric hillshade from real SRTM), `RADAR` (PPI scope with live-aircraft
blips fading on a 4-second sweep), `NIGHT OPS` (red-light, preserve-your-dark-adaptation).

**Real terrain, not a basemap.** NASA SRTM one-arc-second tiles, stitched at ingest
into a 120 m grid, rendered client-side as a Lambertian hillshade with hypsometric
tints. 10 m contour lines are extracted with marching squares *in the browser*, from
that DEM. Every contour here came off the Space Shuttle radar payload in 2000.

**OS National Grid, properly.** Cursor position is live-converted to an OSGB36 grid
reference (SU 85545 54120 style) via the full Airy-1830 transverse-Mercator series
plus the Helmert 14-parameter OSTN15-transform approximation. Not UTM wearing a
costume.

**Live feeds (no keys, no signup):**
| Feed | Source | Refresh |
|---|---|---|
| Live air traffic up to ~150 km — real callsigns, altitude, heading, squawk | OpenSky Network | 15 s |
| Seismicity M2.5+ with distance lines measured from Basingstoke | USGS | 2 min |
| Weather, wind, cloud, lightning potential, sunrise/sunset daylight % | Open-Meteo | 5 min |
| ISS position, ±48 h ground track, **next visible pass computed over your town** (real SGP4) | CelesTrak TLE + satellite-js | 30 min (snapshot frozen otherwise) |

**Basingstoke-only intelligence:**
- **Next ISS pass over Basingstoke**: countdown, rise/peak/fall azimuths, max
  elevation — SGP4 propagated in your browser, not an iframe from a website.
- **Station analysis**: distances & bearings from Basingstoke station to Waterloo,
  Reading, Southampton, Gatwick… computed with real geodesy.
- **A Radar PPI scope centred on the town**: range rings, real motorway geometry,
  sweep-synchronised aircraft blips that fade as the beam passes.
- **Synthetic traffic flow** — moving dots on the *real* M3 / A30 / A33 / A34
  geometry from OpenStreetMap.
- **Tall-structure layer**: OSM masts plus curated UK giants (Emley Moor, Belmont,
  Winter Hill…) drawn as height-scaled spikes.
- **Submarine cables** layer (TeleGeography) — Basingstoke is a national fibre hub;
  it's honest to show where the internet lands.
- Real OSM POIs: pubs, the ICT-famous campuses, Beaver County, Danebury hillfort and
  Old Down barrow as *gotos* — click and the camera flies to the Iron Age.

## Architecture

```
index.html / styles.css      console chrome, CRT scanlines, boot sequence
server.py                    static + /proxy (allowlisted CORS shim for CelesTrak)
scripts/fetch_data.py        one-time ingest: SRTM z12 tiles -> terrain.bin.gz,
                             Overpass -> roads/rail/places/water/urban/towers,
                             Natural Earth -> coast/counties outlines
scripts/build_tles.py        epoch-frozen satellite catalogue (~11,700 sats)
assets/satellite.es.js       satellite-js v5 (SGP4/SDP4)
src/geo.js                   ENU projection, OSGB36 grid refs, Helmert transform
src/terrain.js               DEM load (gzip streaming), hillshade, marching squares
src/live.js                  OpenSky / USGS / Open-Meteo / TLE pass solver
src/main.js                  canvas renderer, radar scope, panels, interaction
```

**Zero runtime dependencies served from npm; zero keys; zero tracking.**
`server.py` proxies *only* an allowlist of open data hosts and only on 127.0.0.1.

## Rebuilding the frozen layers

The live layers are live. The offline layers are snapshots — refresh anytime:

```bash
pip3 install rasterio          # one time
python3 scripts/fetch_data.py  # ~4 min: terrain, roads, rail, places, towers, water, admin
python3 scripts/build_tles.py  # satellite catalogue snapshot
```

## Data provenance (the honest list)

- **Terrain**: NASA SRTM 1 arc-second, AWS `elevation-tiles-prod` (public domain).
- **Streets / rail / POIs / masts / water**: © OpenStreetMap contributors (ODbL), via Overpass.
- **Coastline & county outlines**: Natural Earth 10m public vectors.
- **Submarine cables**: TeleGeography (public mirror).
- **Live air traffic**: OpenSky Network — research licence, non-commercial.
- **Quakes**: USGS Earthquake Hazards Program. **Weather**: Open-Meteo.
- **Orbits**: CelesTrak (TLE) + satellite-js (SGP4).
- Grid math follows OS GB, *A guide to coordinate systems in Great Britain*, v5.

Basingstoke: first recorded as *Basingas' wood* in the 8th century, a Domesday
market town, and for a while in the 1980s the office-park capital of Southern
England. Now with its own spy-console.
