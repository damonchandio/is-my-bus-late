import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline import fetch  # noqa: E402


def feed(entries, header_ts=1_000_000):
    from google.transit import gtfs_realtime_pb2 as rt
    m = rt.FeedMessage()
    m.header.gtfs_realtime_version = "2.0"
    m.header.timestamp = header_ts
    for i, (trip, lat, lon, ts) in enumerate(entries):
        e = m.entity.add()
        e.id = str(i)
        e.vehicle.trip.trip_id = trip
        e.vehicle.trip.route_id = "r1"
        e.vehicle.position.latitude, e.vehicle.position.longitude = lat, lon
        e.vehicle.timestamp = ts
        e.vehicle.vehicle.id = f"bus{i}"
    return m.SerializeToString()


def test_parse_keeps_fresh_trips_inside_the_box():
    blob = feed([("VJ1", 53.79, -1.75, 999_990),    # Bradford, 10 s old: keep
                 ("VJ2", 51.50, -0.12, 999_990),    # London: out of the box
                 ("", 53.79, -1.75, 999_990),       # no trip: can't be scored
                 ("VJ3", 53.79, -1.75, 990_000)])   # 10,000 s stale
    rows = fetch.parse_rt(blob)
    assert [r["trip_id"] for r in rows] == ["VJ1"]
    assert rows[0]["vehicle_id"] == "bus0" and rows[0]["route_id"] == "r1"
