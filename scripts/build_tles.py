#!/usr/bin/env python3
"""Build assets/data/tles.json — epoch-frozen satellite catalogue snapshot.
Groups: space stations, crewed-remote, weather, starlink, oneweb, gps-ops,
tdrs, geostationary, amateur, resource. ~600 sats -> browser SGP4 layer."""
import json, os, urllib.request, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets", "data", "tles.json")
GROUPS = ["stations", "crewed-remote", "weather", "starlink", "oneweb",
          "gps-ops", "tdrs", "geostationary", "amateur", "resource", "orbus"]
lines_out = [f"EPOCH: {datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}"]
count = 0
for g in GROUPS:
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=tle"
    txt = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "basigstoke-view/0.1"}), timeout=60).read().decode()
    lines = txt.splitlines()
    if len(lines) < 3:
        continue
    lines_out.append(f"GROUP: {g}")
    lines_out.extend([l for l in lines if l.strip()])
    count += (len(lines) - 1) // 3
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(lines_out) + "\n")
print(f"wrote {OUT} — {count} satellites")
