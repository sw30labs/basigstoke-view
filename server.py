#!/usr/bin/env python3
"""basigstoke-view dev server — static files + CORS-proxy endpoint for feeds
that lack Access-Control-Allow-Origin (CelesTrak, NTIA-adjacent, etc).

Run:  python3 server.py [port]   (default 8123)
Open: http://127.0.0.1:8123
"""
import http.server
import json
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
UA = {"User-Agent": "Mozilla/5.0 (basigstoke-view local console)"}
ALLOW_HOSTS = {"celestrak.org", "api.opensky-network.org", "opensky-network.org",
               "overpass-api.de", "api.open-meteo.com", "earthquake.usgs.gov",
               "nomina.samfish.net", "nominatim.openstreetmap.org"}


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = q.get("url", [""])[0]
            host = urllib.parse.urlparse(url).hostname or ""
            if not any(host == h or host.endswith("." + h) for h in ALLOW_HOSTS):
                self.send_error(403, "host not allowed"); return
            try:
                req = urllib.request.Request(url, headers=UA)
                data = urllib.request.urlopen(req, timeout=30).read()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_error(502, str(e))
            return
        super().do_GET()

    def log_message(self, format, *args):  # noqa: A002
        if "/proxy" not in (args[0] if args else ""):
            super().log_message(format, *args)


if __name__ == "__main__":
    os.chdir(ROOT)
    print(f"BASINGSTOKE·VIEW console  ->  http://127.0.0.1:{PORT}")
    H.protocol_version = "HTTP/1.1"
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
