select r.route_id::varchar as route_id, r.route_short_name as route, a.agency_name as operator
from {{ source('raw', 'gtfs_routes') }} r
join {{ source('raw', 'gtfs_agency') }} a using (agency_id)
