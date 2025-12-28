#!/usr/bin/env bash
set -euo pipefail

notifications_endpoint="${NOTIFICATIONS_ENDPOINT:-http://notifications:8000/notify/}"
export notifications_endpoint

envsubst < /schema.sql | \
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres
