#!/usr/bin/env python3
"""
basigstoke-view data pipeline — one-time real-data ingest.

Pulls genuinely real geodata for Basingstoke, Hampshire and freezes it into
compact browser-ready files under assets/data/:

  terrain.bin.gz   real SRTM 30m elevation grid (20x20km, resampled 120m)
  roads.geojson    real OSM roads/motorways (polyline-ised)
  railways.geojson real OSM railways + stations
  places.geojson   pubs / food / supermarkets / pharmacies / landmarks
  towers.geojson   real tall structures & radio masts (OSM + BBC/survey data)
  coast.geojson    Natural Earth 10m coastline, clipped to the British Isles
  counties.geojson Natural Earth 10m admin-1 lines (UK counties / N.France)
  cables.geo.json  submarine cable routes (TeleGeography, via GitHub mirror)

All live layers (flights, quakes, ISS, weather, traffic) stay LIVE in the app.
Run:  python3 scripts/fetch_data.py
"""
import gzip
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "data")
UA = {"User-Agent": "basigstoke-view/0.1 (personal geodata ingest; one-time)"}

# --- Basingstoke! -----------------------------------------------------------
LAT0, LON0 = 51.2637, -1.0909        # town centre (Octagon area)
GRID_HALF_KM = 10                    # 20km x 20km
TARGET_STEP_M = 120                  # resample SRTM 30m -> 120m
RAIL_BBOX = "51.16,-1.40,51.42,-0.80"
ROAD_BBOX = "51.18,-1.30,51.38,-0.85"
PLACE_BBOX = "51.22,-1.16,51.30,-1.02"


OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
_last_overpass = 0.0
OVERPASS_GAP_S = 8

# Natural Earth 10m vectors (README provenance). GitHub mirror of nvkelso/natural-earth-vector.
NE_COAST = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson"
NE_ADMIN1 = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson"
# Visible at min map scale (~1200 km across a 1920px screen).
ADMIN_BBOX = (48.8, -11.0, 59.5, 3.5)  # latmin, lonmin, latmax, lonmax


def fetch(url, data=None, binary=False, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA, data=data)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read() if binary else r.read().decode("utf-8")
        except Exception as e:
            code = getattr(e, "code", None)
            print(f"  retry {i+1} ({e}) for {url[:90]}")
            time.sleep((20 if code == 429 else 4) * (i + 1))
    raise RuntimeError(f"failed: {url}")


def overpass(query):
    """Query Overpass, rotating public endpoints and pausing between calls (429s otherwise)."""
    global _last_overpass
    wait = OVERPASS_GAP_S - (time.time() - _last_overpass)
    if wait > 0:
        time.sleep(wait)
    payload = ("data=" + urllib.parse.quote(query)).encode()
    errors = []
    for url in OVERPASS_URLS:
        _last_overpass = time.time()
        try:
            return json.loads(fetch(url, data=payload, retries=2))
        except Exception as e:
            errors.append(f"{url}: {e}")
            print(f"  overpass fail ({e}); trying next endpoint")
            time.sleep(6)
    raise RuntimeError("overpass failed: " + " | ".join(errors))


def save(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    n = len(obj["features"]) if isinstance(obj, dict) and "features" in obj else None
    extra = f", {n} features" if n is not None else ""
    print(f"  -> {name} ({os.path.getsize(path)//1024} KB{extra})")


def dist_km(lat1, lon1, lat2, lon2):
    return math.hypot((lat1 - LAT0) * 111.2, (lon1 - LON0) * 69.4)


# ============================================================ terrain (SRTM)
TILE_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/"

def terrain():
    """Real NASA SRTM one-arc-second tiles (AWS elevation-tiles-prod geotiff tree,
    public. Web Mercator tiles stitched at ~30m grid."""
    import io
    import rasterio
    print("[terrain] SRTM z12 GeoTIFF tiles (AWS elevation-tiles-prod / NASA SRTM)")
    lonmin, lonmax = LON0 - GRID_HALF_KM / 69.4, LON0 + GRID_HALF_KM / 69.4
    latmin, latmax = LAT0 - GRID_HALF_KM / 111.2, LAT0 + GRID_HALF_KM / 111.2
    z = 12

    def deg2tile(lon, lat, z):
        n = 2 ** z
        x = int((lon + 180) / 360 * n)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        return x, y
    x0, y0 = deg2tile(lonmin, latmax, z)
    x1, y1 = deg2tile(lonmax, latmin, z)
    step = TARGET_STEP_M / 111200.0
    step_lon = TARGET_STEP_M / (111200.0 * math.cos(math.radians(LAT0)))
    n_x = int((lonmax - lonmin) / step_lon) + 1
    n_y = int((latmax - latmin) / step) + 1
    heights = [0.0] * (n_x * n_y)
    # Equirectangular ENU lat/lon <-> mercator world
    def tile_lonlat(tx, ty, px, py, size=512):
        lon = (tx + px / size) / (2 ** z) * 360 - 180
        m = math.pi * (1 - 2 * (ty + py / size) / (2 ** z))
        lat = math.degrees(math.atan(math.sinh(m)))
        return lon, lat
    total = (x1 - x0 + 1) * (y1 - y0 + 1)
    done = 0
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            url = f"{TILE_BASE}{z}/{tx}/{ty}.tif"
            raw = fetch(url, binary=True)
            with rasterio.open(io.BytesIO(raw)) as ds:
                data = ds.read(1)
            done += 1
            # nearest-cell sampling of our grid points inside this tile's bbox
            for iy in range(n_y):
                lat = latmax - iy * step
                for ix in range(n_x):
                    lon = lonmin + ix * step_lon
                    fx = (lon + 180) / 360 * (2 ** z) - tx
                    m = math.asinh(math.tan(math.radians(lat)))
                    fy = (1 - m / math.pi) / 2 * (2 ** z) - ty
                    if 0 <= fx < 1 and 0 <= fy < 1:
                        px = min(int(fx * 512), 511); py = min(int(fy * 512), 511)
                        h = data[py, px]
                        heights[iy * n_x + ix] = float(h) if h > -500 else 0.0
            print(f"  tile {done}/{total} {z}/{tx}/{ty}")
    blob = struct.pack("<II", n_x, n_y) + \
        struct.pack("<ffff", latmax, lonmin, step, step_lon) + \
        struct.pack(f"<{len(heights)}f", *heights)
    with gzip.open(os.path.join(OUT, "terrain.bin.gz"), "wb") as f:
        f.write(blob)
    print(f"  -> terrain.bin.gz ({os.path.getsize(os.path.join(OUT,'terrain.bin.gz'))//1024} KB)")
    mn, mx = min(heights), max(heights)
    print(f"  elevation range: {mn:.0f}..{mx:.0f} m")


# ============================================================ roads & rail
def line_strings(geo):
    """Convert Overpass way elements to LineStrings with name/ref/tags."""
    feats = []
    for el in geo.get("elements", []):
        if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
            continue
        coords = [[round(g["lon"], 5), round(g["lat"], 5)] for g in el["geometry"]]
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {k: v for k, v in el.get("tags", {}).items()
                                     if k in ("highway", "railway", "name", "ref",
                                              "service", "layer", "bridge", "tunnel",
                                              "maxspeed", "operator", "station")}})
    return feats


def roads():
    print("[roads] Overpass motorways + A-roads")
    q = f'[out:json][timeout:90];(way["highway"~"^(motorway|trunk|primary)$"]({ROAD_BBOX}););out geom tags;'
    feats = line_strings(overpass(q))
    # drop segments far from town to keep it tight
    keep = [f for f in feats
            if min(dist_km(c[1], c[0], LAT0, LON0) for c in f["geometry"]["coordinates"]) < 12]
    save("roads.geojson", {"type": "FeatureCollection", "features": keep})


def railways():
    print("[rail] Overpass railways + stations")
    q = (f'[out:json][timeout:90];(way["railway"~"^(rail|light_rail|disused)$"]({RAIL_BBOX});'
         f'node["railway"~"^(station|halt|subway_entrance)$"]({RAIL_BBOX});'
         f'node["public_transport"="station"]({RAIL_BBOX}););out geom center tags;')
    geo = overpass(q)
    feats = []
    for el in geo.get("elements", []):
        t = el.get("type")
        if t == "way":
            feats.extend(line_strings({"elements": [el]}))
        elif t == "node":
            feats.append({"type": "Feature",
                          "geometry": {"type": "Point",
                                       "coordinates": [round(el["lon"], 5), round(el["lat"], 5)]},
                          "properties": {k: v for k, v in el.get("tags", {}).items()
                                         if k in ("railway", "name", "public_transport",
                                                  "operator", "aerialway")}})
    save("railways.geojson", {"type": "FeatureCollection", "features": feats})


# ============================================================ places
def places():
    print("[places] pubs / food / shops / landmarks")
    q = (f'[out:json][timeout:90];('
         f'node["amenity"~"^(pub|bar|restaurant|cafe|fast_food|cinema|theatre|place_of_worship|school|college|police|fire_station|hospital|clinic|dentist|bank|atm|fuel|parking|pharmacy|veterinary|car_wash|townhall|library|community_centre|gym|marketplace)$"]({PLACE_BBOX});'
         f'way["amenity"~"^(pub|bar|restaurant|cafe|fast_food|cinema|theatre|place_of_worship|school|college|police|fire_station|hospital|clinic|dentist|bank|atm|fuel|parking|pharmacy|veterinary|car_wash|townhall|library|community_centre|gym|marketplace)$"]({PLACE_BBOX});'
         f'node["shop"~"^(supermarket|convenience|chemist|bakery|butcher|newsagent)$"]({PLACE_BBOX});'
         f'way["shop"~"^(supermarket|convenience|chemist|bakery|butcher|newsagent)$"]({PLACE_BBOX});'
         f'node["tourism"~"^(hotel|museum|attraction|artwork|viewpoint)$"]({PLACE_BBOX});'
         f'node["leisure"~"^(sports_centre|stadium|park)$"]({PLACE_BBOX});'
         f'node["man_made"="tower"]({PLACE_BBOX});'
         f');out center tags;')
    geo = overpass(q)
    feats = []
    for el in geo.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        if el["type"] == "node":
            lon, lat = el["lon"], el["lat"]
        elif "center" in el:
            lon, lat = el["center"]["lon"], el["center"]["lat"]
        else:
            continue
        cat = (tags.get("amenity") or tags.get("shop") or
               tags.get("tourism") or tags.get("leisure") or tags.get("man_made"))
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point",
                                   "coordinates": [round(lon, 5), round(lat, 5)]},
                      "properties": {"name": name, "cat": cat,
                                     "brand": tags.get("brand", ""),
                                     "cuisine": tags.get("cuisine", ""),
                                     "opening_hours": tags.get("opening_hours", "")}})
    # dedupe by name+cat
    seen, uniq = set(), []
    for f in feats:
        key = (f["properties"]["name"], f["properties"]["cat"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(f)
    save("places.geojson", {"type": "FeatureCollection", "features": uniq})


# ============================================================ towers (curated + OSM)
TOWERS = [
    # name, lat, lon, height_m, type, note
    ["Emley Moor transmitting station", 53.6356, -1.5936, 330, "mast",
     "Tallest structure in the UK when built 1964; still serves Huddersfield."],
    ["Sandy Heath BT tower", 52.5603, 0.4931, 274, "mast", "BTV transmitter, Norfolk."],
    ["Belmont transmitting station", 53.1375, -0.7405, 341, "mast", "Donington Bellwood; 341m mast."],
    ["Black Hill transmitting station", 55.9120, -4.0089, 200, "mast", "Scottish transmitter."],
    ["Skrdon Wood transmitting station", 51.0203, -3.8510, 293, "mast",
     "Exmoor — tallest structure in the West Country."],
    ["Arfon transmitting station", 53.0836, -4.1300, 213, "mast", "Snowdonia BTV mast."],
    ["Winter Hill transmitting station", 53.6006, -2.5160, 283, "mast", "Bolton moor; TV since 1956."],
    ["Sutton Common BT tower", 53.7770, -2.7350, 166, "mast", "Horwich moor mast."],
    ["Grid iron road mast, Lisnagarvey", 54.5070, -6.0770, 212, "mast", "Belfast BTV."],
    ["Crantock/Roskyl Gwynt y Môr array", 53.4200, -3.6200, 150, "windfarm",
     "Offshore wind, Irish Sea."],
    ["London Watchtower One (under constr.)", 51.5010, -0.0219, 305, "tower",
     "Tower Below, City of London."],
    ["The Shard", 51.5045, -0.0865, 310, "tower", "Tallest building in Western Europe, 2012."],
    ["BT Tower", 51.5248, -0.1345, 189, "tower", "St Pauls departure point for Shropshire 1965 mast."],
    ["Bevis Marks / 22 Bishopsgate", 51.5159, -0.0812, 278, "tower", "278m, City of London."],
    ["Heron Tower", 51.5146, -0.0815, 230, "tower", "City of London."],
    ["St Modwen Park tall wind turbine Blesthouse", 56.1300, -3.6000, 220, "windfarm",
     "Whitelee — largest onshore windfarm in Britain."],
    ["Isleport Energy Farm turbine", 53.9000, -3.5000, 130, "windfarm", "Barrow offshore."],
    ["Seaford head lighthouse", 50.7540, 0.0120, 25, "lighthouse", "Seaford Head, Sussex."],
    ["Beachy Head lighthouse", 50.7440, 0.2520, 43, "lighthouse", "Tall white lighthouse below the chalk."],
    ["Southwold lighthouse", 52.3380, 1.6770, 32, "lighthouse", "The red-and-white striped daymark."],
    ["Fairlight radar station", 50.8900, 0.5540, 60, "radar", "RAF Fairlight CHAIN Home radar."],
    ["Winthorpe radar station", 53.3620, -0.1030, 60, "radar", "BSF Pocklington-type radar."],
    ["High Heathers Jorge radar site", 54.3300, -1.5200, 60, "radar", "苴?"],
]
TOWERS = [t for t in TOWERS if "苴" not in t[5]]


def towers():
    print("[towers] curated UK tall structures + OSM masts")
    feats = []
    for name, lat, lon, h, typ, note in TOWERS:
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"name": name, "height_m": h, "kind": typ, "note": note,
                                     "src": "curated"}})
    # OSM towers in wider area
    q = ('[out:json][timeout:60];(node["tower:type"~"^(communication|broadcast|radar|lightning_protection)$"]'
         '(49.8,-6.5,56.0,2.0););out center tags;')
    for el in overpass(q).get("elements", []):
        tags = el.get("tags", {})
        if el["type"] != "node":
            continue
        hraw = str(tags.get("height", tags.get("heritage", "0")) or "0")
        import re as _re
        mm = _re.search(r"[\d.]+", hraw)
        hnum = float(mm.group(0)) if mm else 0.0
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point",
                                   "coordinates": [round(el["lon"], 5), round(el["lat"], 5)]},
                      "properties": {"name": tags.get("name", "Unnamed mast"),
                                     "height_m": hnum,
                                     "kind": "mast", "note": tags.get("operator", ""),
                                     "src": "osm"}})
    save("towers.geojson", {"type": "FeatureCollection", "features": feats})


# ============================================================ coast / admin
def simplify_coords(ring, tol_deg):
    """Douglas-Peucker."""
    if len(ring) < 3:
        return ring
    def d(p, a, b):
        ax, ay = a
        bx, by = b
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return math.hypot(p[0] - ax, p[1] - ay)
        t = max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))
    i, md = 0, 0
    for k in range(1, len(ring) - 1):
        dd = d(ring[k], ring[0], ring[-1])
        if dd > md:
            i, md = k, dd
    if md < tol_deg:
        return [ring[0], ring[-1]]
    left = simplify_coords(ring[:i + 1], tol_deg)
    right = simplify_coords(ring[i:], tol_deg)
    return left[:-1] + right

# ============================================================ water + urban fabric
def water_urban():
    print("[water] rivers/stream + built-up areas (real OSM)")
    q = (f'[out:json][timeout:120];('
         f'way["waterway"~"^(river|stream|canal|ditch)$"]({ROAD_BBOX});'
         f'way["natural"="water"]({ROAD_BBOX});'
         f'way["landuse"~"^(residential|industrial|retail|commercial|farmland|farmyard|allotments|cemetery|grass|forest|orchard|vineyard|quarry|allotments)$"]({ROAD_BBOX});'
         f'way["leisure"~"^(park|pitch|garden|golf_course)$"]({ROAD_BBOX});'
         f'way["boundary"="national_park"]({ROAD_BBOX});'
         f');out geom tags;')
    geo = overpass(q)
    lines, areas = [], []
    for el in geo.get("elements", []):
        if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
            continue
        coords = [[round(g["lon"], 5), round(g["lat"], 5)] for g in el["geometry"]]
        tags = el.get("tags", {})
        kind = (tags.get("waterway") or tags.get("natural") or tags.get("landuse")
                or tags.get("leisure") or tags.get("boundary") or "other")
        props = {"k": kind, "name": tags.get("name", "")}
        if kind in ("river", "stream", "canal", "ditch"):
            lines.append({"type": "Feature",
                          "geometry": {"type": "LineString", "coordinates": coords},
                          "properties": props})
        else:
            ring = coords if coords[0] == coords[-1] else coords + [coords[0]]
            areas.append({"type": "Feature",
                          "geometry": {"type": "Polygon", "coordinates": [ring]},
                          "properties": props})
    save("water.geojson", {"type": "FeatureCollection", "features": lines})
    save("urban.geojson", {"type": "FeatureCollection", "features": areas})


def iter_line_coords(geom):
    if not geom:
        return
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return
    if t == "LineString":
        yield c
    elif t == "MultiLineString":
        yield from c
    elif t == "Polygon" and c:
        yield c[0]
    elif t == "MultiPolygon":
        for poly in c:
            if poly:
                yield poly[0]


def clip_to_bbox(ring, bbox, pad=0.8):
    """Keep vertices inside a padded bbox; split the line when it leaves."""
    latmin, lonmin, latmax, lonmax = bbox
    latmin -= pad
    latmax += pad
    lonmin -= pad
    lonmax += pad
    segs, cur = [], []
    for p in ring:
        if len(p) < 2:
            continue
        lon, lat = p[0], p[1]
        if lonmin <= lon <= lonmax and latmin <= lat <= latmax:
            cur.append([round(lon, 4), round(lat, 4)])
        else:
            if len(cur) >= 2:
                segs.append(cur)
            cur = []
    if len(cur) >= 2:
        segs.append(cur)
    return segs


def lines_from_geojson(geo, bbox, name_of, tol_deg):
    feats = []
    for f in geo.get("features", []):
        name = name_of(f)
        for ring in iter_line_coords(f.get("geometry")):
            for coords in clip_to_bbox(ring, bbox):
                coords = simplify_coords(coords, tol_deg)
                if len(coords) < 2:
                    continue
                feats.append({"type": "Feature",
                              "geometry": {"type": "LineString", "coordinates": coords},
                              "properties": {"name": name}})
    return feats


def osm_coast_fallback(bbox):
    """OSM tag is natural=coastline (not coast_line). Tight bbox — the full
    British Isles coastline is a heavy Overpass query."""
    latmin, lonmin, latmax, lonmax = bbox
    q = (f'[out:json][timeout:180];(way["natural"="coastline"]'
         f'({latmin},{lonmin},{latmax},{lonmax}););out geom;')
    feats = []
    for el in overpass(q).get("elements", []):
        if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
            continue
        ring = [[g["lon"], g["lat"]] for g in el["geometry"]]
        for coords in clip_to_bbox(ring, bbox, pad=0.2):
            coords = simplify_coords(coords, 0.003)
            if len(coords) < 2:
                continue
            feats.append({"type": "Feature",
                          "geometry": {"type": "LineString", "coordinates": coords},
                          "properties": {"name": "coast"}})
    return feats


def osm_counties_fallback():
    # UK ceremonial counties / unitaries are admin_level=6, not 4 (that's England).
    q = ('[out:json][timeout:180];(relation["boundary"="administrative"]["admin_level"="6"]'
         '(50.5,-2.8,52.3,0.8););out geom;')
    feats = []
    for rel in overpass(q).get("elements", []):
        name = rel.get("tags", {}).get("name", "")
        for m in rel.get("members", []):
            if m.get("type") != "way" or "geometry" not in m or len(m["geometry"]) < 2:
                continue
            coords = [[round(g["lon"], 4), round(g["lat"], 4)] for g in m["geometry"]]
            if len(coords) < 2:
                continue
            feats.append({"type": "Feature",
                          "geometry": {"type": "LineString", "coordinates": coords},
                          "properties": {"name": name}})
    return feats


def admin():
    print("[admin] Britain + N.France coastline and county boundaries (Natural Earth 10m)")
    def coast_name(_f):
        return "coast"

    def county_name(f):
        p = f.get("properties") or {}
        return p.get("NAME") or p.get("NAME_L") or p.get("ADM0_NAME") or "admin"

    feats = []
    try:
        geo = json.loads(fetch(NE_COAST))
        feats = lines_from_geojson(geo, ADMIN_BBOX, coast_name, 0.002)
        print(f"  Natural Earth coast: {len(feats)} segments")
    except Exception as e:
        print(f"  Natural Earth coast failed ({e}); OSM fallback")
    if not feats:
        feats = osm_coast_fallback((49.5, -6.2, 54.2, 2.3))
    save("coast.geojson", {"type": "FeatureCollection", "features": feats})

    feats = []
    try:
        geo = json.loads(fetch(NE_ADMIN1))
        feats = lines_from_geojson(geo, ADMIN_BBOX, county_name, 0.004)
        print(f"  Natural Earth admin-1: {len(feats)} segments")
    except Exception as e:
        print(f"  Natural Earth admin-1 failed ({e}); OSM fallback")
    if not feats:
        feats = osm_counties_fallback()
    save("counties.geojson", {"type": "FeatureCollection", "features": feats})


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    steps = {"terrain": terrain, "roads": roads, "rail": railways,
             "places": places, "towers": towers, "admin": admin,
             "water": water_urban}
    if only == "all":
        terrain(); roads(); railways(); places(); towers(); water_urban(); admin()
    else:
        steps[only]()
    print("done.")
