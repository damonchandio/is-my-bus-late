"""After `dbt run`: save this run's per-route counts (small, goes in git) and rebuild RESULTS.md from every
run so far. Positions themselves are not kept: an hour is ~5 MB and the counts are all the leaderboard needs.
    python -m pipeline.report
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "data" / "runs"
MIN_TRIPS = 30 if "--dev" not in sys.argv else 3          # a route needs this many measured trips before it's ranked


def save_run(con) -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    out = RUNS / f"{datetime.now(timezone.utc):%Y-%m-%d_%H%M}.csv"
    con.sql(f"""
        copy (
          select r.route, r.operator, count(*) as n, count(distinct o.trip_id) as trips,
                 sum(o.delay_s) as delay_sum, sum((o.delay_s > 300)::int) as n_over5,
                 sum((o.delay_s < -60)::int) as n_early, sum((o.delay_s between -60 and 300)::int) as n_ontime,
                 median(o.delay_s) as run_median
          from fct_observations o join stg_routes r using (route_id) group by 1, 2
        ) to '{out.as_posix()}' (header, delimiter ',')""")
    return out


def results() -> str:
    con = duckdb.connect()
    agg = con.sql(f"""
        with runs as (select * from read_csv_auto('{RUNS.as_posix()}/*.csv', header=true, filename=true))
        select route, operator, sum(n) as n, sum(trips) as trips, count(distinct filename) as runs,
               round(sum(run_median * n) / sum(n) / 60.0, 1) as typical_minutes_late,
               round(100.0 * sum(n_over5) / sum(n), 1) as pct_over_5_late,
               round(100.0 * sum(n_early) / sum(n), 1) as pct_early,
               round(100.0 * sum(n_ontime) / sum(n), 1) as pct_on_time
        from runs group by 1, 2 having sum(trips) >= {MIN_TRIPS}""").df()
    nruns = con.sql(f"select count(*) from glob('{RUNS.as_posix()}/*.csv')").fetchall()[0][0]
    first = sorted(p.name[:10] for p in RUNS.glob("*.csv"))
    head = [f"# Is my bus late? West Yorkshire", "",
            f"{nruns} hourly samples between {first[0]} and {first[-1]}, {int(agg.n.sum()):,} measurements at stops, "
            f"{int(agg.trips.sum()):,} bus trips. On time = within 1 minute early to 5 minutes late at the stop.", ""]
    if agg.empty:
        return "\n".join(head + ["Not enough data yet."]) + "\n"
    def tab(df, title):
        lines = [f"## {title}", "", "| Route | Operator | Typical minutes late | Over 5 min late | Early | On time | Trips |",
                 "|---|---|---|---|---|---|---|"]
        for r in df.itertuples():
            lines.append(f"| {r.route} | {r.operator} | {r.typical_minutes_late} | {r.pct_over_5_late}% | "
                         f"{r.pct_early}% | {r.pct_on_time}% | {int(r.trips)} |")
        return lines + [""]
    by_late = agg.sort_values("typical_minutes_late", ascending=False)
    op = con.sql(f"""
        with runs as (select * from read_csv_auto('{RUNS.as_posix()}/*.csv', header=true))
        select operator, sum(n) as n, sum(trips) as trips, round(100.0 * sum(n_ontime) / sum(n), 1) as pct_on_time,
               round(100.0 * sum(n_over5) / sum(n), 1) as pct_over_5_late
        from runs group by 1 having sum(trips) >= {MIN_TRIPS} order by pct_on_time""").df()
    lines = head + tab(by_late.head(15), "The 15 latest routes") + tab(by_late.tail(10).iloc[::-1], "The 10 most punctual routes")
    lines += ["## By operator", "", "| Operator | On time | Over 5 min late | Trips |", "|---|---|---|---|"]
    lines += [f"| {r.operator} | {r.pct_on_time}% | {r.pct_over_5_late}% | {int(r.trips)} |" for r in op.itertuples()]
    lines += ["", "Typical minutes late = observation-weighted average of each hourly sample's median delay. "
              "Routes need 30 measured trips to appear. Source: DfT Bus Open Data Service (OGL v3.0)."]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    if "--no-save" not in sys.argv:
        with duckdb.connect(str(ROOT / "data" / "buses.duckdb"), read_only=True) as con:
            print("saved", save_run(con).name)
    (ROOT / "RESULTS.md").write_text(results(), encoding="utf-8")
    print((ROOT / "RESULTS.md").read_text()[:1500])
