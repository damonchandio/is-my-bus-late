-- For every position report, the nearest timetabled stop on that trip and how late the bus was there.
-- A bus is only measured when it is within 100 m of a stop, so "late" means late AT a stop, not mid-road.
with near as (
    select
        p.vehicle_id, p.trip_id, p.observed_at, p.start_date,
        st.stop_name, st.departure_s,
        -- haversine in metres; DuckDB has no geo extension by default and this is accurate enough at 100 m
        2 * 6371000 * asin(sqrt(
            pow(sin(radians(st.stop_lat - p.lat) / 2), 2)
            + cos(radians(p.lat)) * cos(radians(st.stop_lat)) * pow(sin(radians(st.stop_lon - p.lon) / 2), 2)
        )) as metres,
        row_number() over (partition by p.vehicle_id, p.observed_at order by metres) as rn
    from {{ ref('stg_positions') }} p
    join {{ ref('stg_stop_times') }} st using (trip_id)
),
scored as (
    select
        n.*,
        t.route_id,
        -- scheduled departure as a real instant: service day in London time plus the timetable offset
        timezone('Europe/London', strptime(n.start_date, '%Y%m%d')::timestamp) + to_seconds(n.departure_s) as scheduled_at,
        epoch(n.observed_at) - epoch(timezone('Europe/London', strptime(n.start_date, '%Y%m%d')::timestamp) + to_seconds(n.departure_s)) as delay_s
    from near n
    join {{ source('raw', 'gtfs_trips') }} t using (trip_id)
    where n.rn = 1 and n.metres <= 100
)
select vehicle_id, trip_id, route_id::varchar as route_id, observed_at, stop_name, metres, scheduled_at, delay_s
from scored
-- outside this window the trip id is almost certainly wrong (yesterday's duty, a stale report), not a 2-hour delay
where delay_s between -1800 and 5400
