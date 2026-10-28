"""Take a live snapshot every minute for N minutes (the feed updates about every 10-30 s per vehicle).
    python -m pipeline.collect 55
Duplicate (vehicle, timestamp) rows across snapshots are removed downstream in dbt."""
import sys
import time

from .fetch import snapshot

minutes = int(sys.argv[1]) if len(sys.argv) > 1 else 55
end = time.time() + minutes * 60
while time.time() < end:
    t0 = time.time()
    try:
        print(time.strftime("%H:%M:%S"), snapshot(), "positions", flush=True)
    except Exception as e:  # noqa: BLE001  (a bad minute shouldn't end the hour)
        print(time.strftime("%H:%M:%S"), "failed:", str(e)[:120], flush=True)
    time.sleep(max(0, 60 - (time.time() - t0)))
