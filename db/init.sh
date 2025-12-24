#!/bin/sh
set -eu

:
  "${APPRISE_ENDPOINT:=http://apprise-api:8000/notify/}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

: "${PGRST_DB_URI:?PGRST_DB_URI is required}"

echo "Seeding schema with APPRISE_ENDPOINT=${APPRISE_ENDPOINT}"

psql -v ON_ERROR_STOP=1 \
  "$PGRST_DB_URI" \
  -v apprise_endpoint="$APPRISE_ENDPOINT" \
  -f "$SCRIPT_DIR/schema.sql"
