-- Which timetabled trips run on each service day we have positions for (GTFS calendar + calendar_dates).
with days as (
    select distinct start_date as service_date, strptime(start_date, '%Y%m%d') as d from {{ ref('stg_positions') }}
),
services as (
    select c.service_id, days.service_date
    from {{ source('raw', 'gtfs_calendar') }} c join days
      on days.service_date between c.start_date and c.end_date
     and [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday][isodow(days.d)] = '1'
    except
    select service_id, date from {{ source('raw', 'gtfs_calendar_dates') }} where exception_type = '2'
    union
    select cd.service_id, cd.date from {{ source('raw', 'gtfs_calendar_dates') }} cd join days on days.service_date = cd.date
    where cd.exception_type = '1'
)
select t.trip_id, t.route_id, t.direction_id, s.service_date
from {{ source('raw', 'gtfs_trips') }} t join services s using (service_id)
