#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash Backend/Test/test_schedule_order.sh
# Optional:
#   API_BASE=http://127.0.0.1:8000 bash Backend/Test/test_schedule_order.sh

API_BASE="${API_BASE:-http://127.0.0.1:8000}"

echo "Triggering planner: POST ${API_BASE}/schedule"
curl -fsS -X POST "${API_BASE}/schedule" >/dev/null

echo "Reading full schedule: GET ${API_BASE}/schedule"
schedule_json="$(curl -fsS "${API_BASE}/schedule")"

python3 - <<'PY' <<<"${schedule_json}"
import json
import sys
from datetime import datetime, timezone
from collections import defaultdict

raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit("ERROR: empty response from GET /schedule")

payload = json.loads(raw)
if not isinstance(payload, dict) or "items" not in payload:
    raise SystemExit("ERROR: GET /schedule did not return {'items': [...]} format")
items = payload["items"]
if not isinstance(items, list):
    raise SystemExit("ERROR: GET /schedule 'items' is not a list")
if not items:
    raise SystemExit("ERROR: schedule is empty; seed data and retry")

by_day = defaultdict(list)
for it in items:
    day = it["day"]
    hour = int(it["hour"])
    if hour < 9 or hour > 21:
        raise SystemExit(f"ERROR: hour out of range 9..21 -> day={day} hour={hour}")
    dt = datetime.fromisoformat(f"{day}T{hour:02d}:00:00+00:00").astimezone(timezone.utc)
    by_day[day].append((dt, it))

for day, rows in sorted(by_day.items()):
    rows.sort(key=lambda x: x[0])
    hours = [row[0].hour for row in rows]
    if any(hours[i] > hours[i + 1] for i in range(len(hours) - 1)):
        raise SystemExit(f"ERROR: non-ascending hours in day {day}: {hours}")
    if hours and hours[0] != 9:
        raise SystemExit(f"ERROR: day {day} does not start at 09:00, starts at {hours[0]:02d}:00")

print("OK: schedule hours are ascending from 09:00 to 21:00 by day.")
print(f"Total items: {len(items)}")
for day, rows in sorted(by_day.items()):
    print(f"{day}: {len(rows)} items, hours={[r[0].hour for r in sorted(rows, key=lambda x: x[0])]}")
PY
