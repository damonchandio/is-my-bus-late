-- For every position report, the nearest timetabled stop on that trip and how late the bus was there.
-- A bus is only measured when it is within 100 m of a stop, so "late" means late AT a stop, not mid-road.
-- Known limit: a bus running a full loop (often an hour) late would be scored against its later visit instead.
with near as (
    select
        p.vehicle_id, p.trip_id, p.observed_at, p.start_date,
        st.stop_id, st.stop_name, st.departure_s,
        st.stop_sequence = min(st.stop_sequence) over w or st.stop_sequence = max(st.stop_sequence) over w as at_terminus,
        -- haversine in metres; DuckDB has no geo extension by default and this is accurate enough at 100 m
        2 * 6371000 * asin(sqrt(
            pow(sin(radians(st.stop_lat - p.lat) / 2), 2)
            + cos(radians(p.lat)) * cos(radians(st.stop_lat)) * pow(sin(radians(st.stop_lon - p.lon) / 2), 2)
        )) as metres,
        -- scheduled departure as a real instant: service day in London time plus the timetable offset
        timezone('Europe/London', strptime(p.start_date, '%Y%m%d')::timestamp) + to_seconds(st.departure_s) as scheduled_at
    from {{ ref('stg_positions') }} p
    join {{ ref('stg_stop_times') }} st using (trip_id)
    window w as (partition by p.vehicle_id, p.observed_at)
),
ranked as (
    select *, epoch(observed_at) - epoch(scheduled_at) as delay_s,
        -- ~10% of trips pass a stop (or its twin across the road) twice on loops and circulars, so of the stops within
        -- 100 m take the visit due nearest now, not simply the nearest stop
        row_number() over (partition by vehicle_id, observed_at
                           order by metres > 100, abs(epoch(observed_at) - epoch(scheduled_at)), metres) as rn
    from near
),
scored as (
    select n.*, t.route_id
    from ranked n
    join {{ source('raw', 'gtfs_trips') }} t using (trip_id)
    where n.rn = 1 and n.metres <= 100
)
select vehicle_id, trip_id, route_id::varchar as route_id, observed_at, stop_name, metres, scheduled_at, delay_s
from scored
-- outside this window the trip id is almost certainly wrong (yesterday's duty, a stale report), not a 2-hour delay
where delay_s between -1800 and 5400
  -- ahead of time at the first or last stop is a bus waiting to start or finishing early, not running early
  and not (at_terminus and delay_s < 0)
  -- very late, but another trip on this route and direction was due here within 5 min: the bus is usually running
  -- that later trip while still broadcasting the earlier one, so the reading is ambiguous rather than a real delay
  and not (delay_s > 900 and exists (
      select 1
      from {{ ref('stg_active_trips') }} me
      join {{ ref('stg_active_trips') }} alt
        on alt.route_id = me.route_id and alt.direction_id = me.direction_id
       and alt.service_date = me.service_date and alt.trip_id <> me.trip_id
      join {{ ref('stg_stop_times') }} ast on ast.trip_id = alt.trip_id and ast.stop_id = scored.stop_id
      where me.trip_id = scored.trip_id and me.service_date = scored.start_date
        and abs(epoch(scored.observed_at) - epoch(timezone('Europe/London', strptime(scored.start_date, '%Y%m%d')::timestamp)
                + to_seconds(ast.departure_s))) <= 300))
