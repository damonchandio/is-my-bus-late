"""Fetch the timetable and one snapshot of live bus positions from the DfT Bus Open Data Service.

Both downloads are open: no account, no API key.
    python -m pipeline.fetch timetable          # Yorkshire GTFS -> data/gtfs/ (skips the 1.2 GB shapes.txt)
    python -m pipeline.fetch snapshot           # live positions -> data/positions/<date>.csv (appends)
"""
from __future__ import annotations

import csv
import io
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
GTFS_URL = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/{region}/"
RT_URL = "https://data.bus-data.dft.gov.uk/avl/download/gtfsrt"
REGION = os.getenv("BUS_REGION", "yorkshire")
# West Yorkshire: Bradford, Leeds, Wakefield, Kirklees, Calderdale. Override with BUS_BBOX="minlat,minlon,maxlat,maxlon".
BBOX = tuple(float(x) for x in os.getenv("BUS_BBOX", "53.52,-2.18,53.96,-1.20").split(","))
FRESH_SECONDS = 300      # positions older than this (stale AVL) are dropped
FIELDS = ["observed_at", "trip_id", "route_id", "start_date", "start_time", "vehicle_id", "lat", "lon", "bearing"]


def get(url: str, timeout: int = 600) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "is-my-bus-late/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def timetable(region: str = REGION) -> Path:
    out = DATA / "gtfs"
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(get(GTFS_URL.format(region=region)))) as z:
        for name in z.namelist():
            if name != "shapes.txt":          # route geometry; not needed for lateness and 1.2 GB
                z.extract(name, out)
    return out


def parse_rt(blob: bytes, now: int | None = None) -> list[dict]:
    """Vehicles inside BBOX with a trip, seen in the last FRESH_SECONDS."""
    from google.transit import gtfs_realtime_pb2 as rt
    msg = rt.FeedMessage()
    msg.ParseFromString(blob)
    now = now or msg.header.timestamp or int(time.time())
    rows = []
    for e in msg.entity:
        v = e.vehicle
        p, t = v.position, v.trip
        if not t.trip_id or not (BBOX[0] <= p.latitude <= BBOX[2] and BBOX[1] <= p.longitude <= BBOX[3]):
            continue
        if not v.timestamp or now - v.timestamp > FRESH_SECONDS:
            continue
        rows.append({"observed_at": v.timestamp, "trip_id": t.trip_id, "route_id": t.route_id,
                     "start_date": t.start_date, "start_time": t.start_time, "vehicle_id": v.vehicle.id,
                     "lat": p.latitude, "lon": p.longitude, "bearing": p.bearing})
    return rows


def snapshot() -> int:
    blob = zipfile.ZipFile(io.BytesIO(get(RT_URL, 120))).read("gtfsrt.bin")
    rows = parse_rt(blob)
    out = DATA / "positions"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{datetime.now(timezone.utc):%Y-%m-%d}.csv"
    new = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, FIELDS)
        if new:
            w.writeheader()
        w.writerows(rows)
    return len(rows)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if what == "timetable":
        print("timetable in", timetable())
    else:
        print(snapshot(), "positions")
