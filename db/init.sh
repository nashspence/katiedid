#!/usr/bin/env bash
set -euo pipefail

apprise_endpoint="${APPRISE_ENDPOINT:-http://apprise-api:8000/notify/}"
export apprise_endpoint

envsubst < /schema.sql | \
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres