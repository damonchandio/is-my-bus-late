# is-my-bus-late

[![tests](https://github.com/damonchandio/is-my-bus-late/actions/workflows/tests.yml/badge.svg)](https://github.com/damonchandio/is-my-bus-late/actions/workflows/tests.yml) [![collect](https://github.com/damonchandio/is-my-bus-late/actions/workflows/collect.yml/badge.svg)](https://github.com/damonchandio/is-my-bus-late/actions/workflows/collect.yml) ![licence](https://img.shields.io/badge/licence-MIT-16A6F0) ![python](https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white)

**Which West Yorkshire bus routes actually run on time? Measured every hour from the government's live bus feed, not from complaints.**

Every bus in England reports its position to the Department for Transport about every 30 seconds, and every timetable is published alongside it. Both are open, with no account and no key. This repo joins the two: where was each bus when it reached a stop, and when was it meant to be there. The leaderboard rebuilds itself every hour.

**→ [is-my-bus-late.netlify.app](https://is-my-bus-late.netlify.app): type a bus number, see every bus on that route right now and how late it is.**
**→ [RESULTS.md](RESULTS.md): the leaderboard built from the hourly samples.**

## How it works

```
BODS live positions (GTFS-RT, every minute) ─┐
                                             ├─ DuckDB + dbt ─ nearest stop on the trip ─ delay at that stop ─ RESULTS.md
BODS timetable (GTFS, Yorkshire, weekly)  ───┘
```

1. `pipeline/fetch.py` downloads the Yorkshire GTFS timetable (285 MB, `shapes.txt` skipped) and takes a snapshot of live positions, keeping buses inside the West Yorkshire bounding box that reported in the last 5 minutes and carry a trip id.
2. `pipeline/collect.py` snapshots every minute for an hour: about 1,000 buses a minute.
3. dbt models on DuckDB (`models/`):
   - `stg_*` read the CSVs straight from disk (no load step).
   - `fct_observations` finds, for every position report, the nearest timetabled stop on that bus's trip (haversine), keeps it only when the bus is within 100 m of the stop, and computes `delay = observed - scheduled`. Scheduled time is the GTFS service day in London time plus the timetable offset, so trips past midnight and clock changes come out right.
   - `route_lateness` turns that into median and 90th-percentile lateness, and the share of stops reached over 5 minutes late, early, or on time, per route and operator.
4. `pipeline/report.py` saves the hour's per-route counts (a few KB, committed) and rebuilds `RESULTS.md` from every hour so far.

The hourly run is a GitHub Actions job (`.github/workflows/collect.yml`), 6am to 10pm. GitHub's scheduler only fires a few of those a day, so each run starts the next one itself until 9pm, and the schedule restarts the chain each morning. Positions are never committed: an hour is ~5 MB and the counts are all the leaderboard needs.

**Definitions.** On time = between 1 minute early and 5 minutes late at the stop, the same window the DfT uses for punctuality statistics. A route needs 30 measured trips before it is ranked. A bus is only measured *at a stop*, so a bus that is late between stops but makes it up is not penalised.

## The live site

`site/` is a static page with a 3D map (MapLibre, OpenFreeMap tiles). It needs no server of its own and no API key:

- `netlify/functions/live.mjs` fetches the DfT feed (all of England, ~1.5 MB), keeps West Yorkshire and returns the buses on one route. The feed sends no CORS headers, so the browser can't read it directly. It decodes GTFS-RT with a small built-in protobuf reader instead of a dependency, checked against the Python pipeline on the same feed.
- `.github/workflows/site-data.yml` splits the 285 MB timetable every morning into one small JSON file per route (70 KB compressed at most) on the `site-data` branch, so the browser only loads the route it is looking at.
- `site/match.js` places each bus on its timetabled trip and interpolates between stops, so the delay is right mid-road too. It agrees with the dbt model to within 2 minutes on 498 of 499 Bradford readings.

## Run it yourself

```bash
git clone https://github.com/damonchandio/is-my-bus-late && cd is-my-bus-late
pip install -r requirements.txt

python -m pipeline.fetch timetable     # once a week; ~2 minutes
python -m pipeline.collect 30          # 30 minutes of live positions
DBT_PROFILES_DIR=. dbt run && DBT_PROFILES_DIR=. dbt test
python -m pipeline.report --dev        # --dev lowers the 30-trip bar for a short sample
```

Another part of England: set `BUS_REGION` (the BODS region in the GTFS download URL, e.g. `north_west`, `london`, `south_east`) and `BUS_BBOX="minlat,minlon,maxlat,maxlon"`.

Explore the data: `duckdb data/buses.duckdb` and `select * from route_lateness`.

## Caveats

- Operators' trip ids are not always right. A bus often keeps broadcasting the journey it just finished while it runs the next one, which looks like an hour's delay. A reading more than 15 minutes late is dropped when another journey on the same route and direction was due at that stop within 5 minutes; the live site shows that bus against the journey it is actually running.
- About 10% of trips pass the same stop, or its twin across the road, twice (loops and circulars). Each reading is matched to the visit due nearest the time, not just the nearest stop, which turned a 5-minute delay on the 621 into "77 minutes late" before this was fixed.
- A bus ahead of time at its first or last stop is waiting to start or finishing early, not running early, so those readings are left out.
- The two samples from before 1 November 2026 were scored before those fixes.
- Only buses that report a trip id are measured, and some operators report badly or not at all. Absent from the table is not the same as punctual.
- One hour a day at 6am to 10pm is a sample, not a census. Rush hours and quiet hours are mixed.

## Licence

Code MIT. Data from the [Bus Open Data Service](https://data.bus-data.dft.gov.uk/), Open Government Licence v3.0.

Built by Damon Chandio, [Damon Dynamics](https://damondynamics.co.uk), Bradford.
