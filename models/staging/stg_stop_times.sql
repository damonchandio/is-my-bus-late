-- GTFS times can pass 24:00 for trips that run past midnight, so keep them as seconds since the service day
select
    st.trip_id,
    st.stop_id,
    st.stop_sequence::int as stop_sequence,
    split_part(st.departure_time, ':', 1)::int * 3600 + split_part(st.departure_time, ':', 2)::int * 60
        + split_part(st.departure_time, ':', 3)::int as departure_s,
    s.stop_name,
    s.stop_lat::double as stop_lat,
    s.stop_lon::double as stop_lon
from {{ source('raw', 'gtfs_stop_times') }} st
join {{ source('raw', 'gtfs_stops') }} s using (stop_id)
