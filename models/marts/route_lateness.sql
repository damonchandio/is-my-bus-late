-- The leaderboard: per route and operator, how late buses were at their stops.
select
    r.route,
    r.operator,
    count(*) as observations,
    count(distinct o.trip_id) as trips,
    round(median(o.delay_s) / 60.0, 1) as median_minutes_late,
    round(quantile_cont(o.delay_s, 0.9) / 60.0, 1) as p90_minutes_late,
    round(100.0 * avg((o.delay_s > 300)::int), 1) as pct_over_5_min_late,
    round(100.0 * avg((o.delay_s < -60)::int), 1) as pct_early,
    round(100.0 * avg((o.delay_s between -60 and 300)::int), 1) as pct_on_time
from {{ ref('fct_observations') }} o
join {{ ref('stg_routes') }} r using (route_id)
group by 1, 2
having count(distinct o.trip_id) >= 5
order by median_minutes_late desc
