#!/bin/sh
set -eu

: "${PGRST_DB_URI:?PGRST_DB_URI is required}"
: "${APPRISE_ENDPOINT:=http://apprise-api:8000/notify/}"

# Wait for the database to become reachable before running migrations.
until psql "$PGRST_DB_URI" -c 'select 1' >/dev/null 2>&1; do
  sleep 1
done

PGRST_DB_URI="$PGRST_DB_URI" APPRISE_ENDPOINT="$APPRISE_ENDPOINT" "$(dirname "$0")/init.sh"

exec postgrest "$@"
