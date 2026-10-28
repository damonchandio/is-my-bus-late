-- one row per (vehicle, timestamp): snapshots overlap, so the same report arrives several times
select distinct
    vehicle_id,
    trip_id,
    route_id,
    coalesce(nullif(start_date, ''), strftime(to_timestamp(observed_at::bigint) at time zone 'Europe/London', '%Y%m%d')) as start_date,
    to_timestamp(observed_at::bigint) as observed_at,
    lat::double as lat, lon::double as lon
from {{ source('raw', 'positions') }}
where trip_id is not null and lat is not null
