"""Split the 285 MB timetable into one small JSON file per West Yorkshire route, for the live site.
The browser loads only the route it is looking at, so the timetable never has to be downloaded whole.
    python -m pipeline.site_data            # -> site-data/routes.json + site-data/r/<route_id>.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb

from .fetch import BBOX, DATA, ROOT

OUT = ROOT / "site-data"
DAYS = 8  # rebuilt daily; a week of slack if a rebuild fails


def build(out: Path = OUT) -> int:
    (out / "r").mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    for t in ("stops", "stop_times", "trips", "routes", "agency"):
        con.sql(f"create view {t} as select * from read_csv_auto('{(DATA / 'gtfs' / t).as_posix()}.txt', header=true, all_varchar=true)")
    con.sql(f"""create table wy_routes as
        select distinct t.route_id from trips t join stop_times st using (trip_id) join stops s using (stop_id)
        where s.stop_lat::double between {BBOX[0]} and {BBOX[2]} and s.stop_lon::double between {BBOX[1]} and {BBOX[3]}""")
    for t in ("calendar", "calendar_dates"):
        con.sql(f"create view {t} as select * from read_csv_auto('{(DATA / 'gtfs' / t).as_posix()}.txt', header=true, all_varchar=true)")
    # bit k of a trip's mask = it runs on service day d0 + k, for the next DAYS days (the site needs "does it run today")
    d0 = con.sql("select strftime(current_date, '%Y%m%d')").fetchall()[0][0]
    con.sql(f"""create table runs as
        with days as (select k, d, strftime(d, '%Y%m%d') as ds from (
            select k, current_date + k::int as d from range({DAYS}) r(k))),
        on_days as (
            select c.service_id, days.k, days.ds from calendar c join days
              on days.ds between c.start_date and c.end_date
             and [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday][isodow(days.d)] = '1'
            except select cd.service_id, days.k, days.ds from calendar_dates cd join days on cd.date = days.ds where cd.exception_type = '2'
            union select cd.service_id, days.k, days.ds from calendar_dates cd join days on cd.date = days.ds where cd.exception_type = '1')
        select t.trip_id, sum(1 << k)::int as mask from trips t join on_days using (service_id) group by 1""")
    rows = con.sql("""
        select t.route_id, t.trip_id, coalesce(t.trip_headsign, '') as headsign, st.stop_id,
            split_part(st.departure_time, ':', 1)::int * 3600 + split_part(st.departure_time, ':', 2)::int * 60
                + split_part(st.departure_time, ':', 3)::int as dep,
            coalesce(r.mask, 0) as mask, t.direction_id
        from trips t join wy_routes using (route_id) join stop_times st using (trip_id) left join runs r using (trip_id)
        order by t.route_id, t.trip_id, st.stop_sequence::int""").fetchall()
    stops = {r[0]: (r[1], round(float(r[2]), 5), round(float(r[3]), 5))
             for r in con.sql("select stop_id, stop_name, stop_lat, stop_lon from stops").fetchall()}
    meta = {r[0]: {"id": r[0], "route": r[1], "operator": r[2]} for r in con.sql(
        "select r.route_id, r.route_short_name, a.agency_name from routes r join agency a using (agency_id) join wy_routes using (route_id)").fetchall()}

    files = {}
    for route_id, trip_id, headsign, stop_id, dep, mask, direction in rows:
        f = files.setdefault(route_id, {"stops": [], "sidx": {}, "heads": [], "trips": {}})
        if stop_id not in f["sidx"]:
            f["sidx"][stop_id] = len(f["stops"])
            f["stops"].append(stops[stop_id])
        trip = f["trips"].get(trip_id)
        if trip is None:
            if headsign not in f["heads"]:
                f["heads"].append(headsign)
            # [headsign index, first departure (s since service day), [stop indexes], [s after first stop], day mask, direction]
            trip = f["trips"][trip_id] = [f["heads"].index(headsign), dep, [], [], mask, int(direction or 0)]
        trip[2].append(f["sidx"][stop_id])
        trip[3].append(dep - trip[1])

    index = []
    for route_id, f in files.items():
        (out / "r" / f"{route_id}.json").write_text(json.dumps(
            {"d0": d0, "stops": f["stops"], "heads": f["heads"], "trips": f["trips"]}, separators=(",", ":")))
        counts = {}
        for trip in f["trips"].values():
            counts[trip[0]] = counts.get(trip[0], 0) + 1
        top = sorted(counts, key=counts.get, reverse=True)[:2]
        index.append({**meta[route_id], "to": [f["heads"][i] for i in top if f["heads"][i]]})
    index.sort(key=lambda r: (r["route"].zfill(6), r["operator"]))
    (out / "routes.json").write_text(json.dumps(index, separators=(",", ":")))
    return len(index)


if __name__ == "__main__":
    print(build(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT), "routes")
