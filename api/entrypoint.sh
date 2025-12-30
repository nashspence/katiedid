#!/bin/sh
set -eu

ADDR="${TEMPORAL_ADDRESS:-scheduler:7233}"

POSTGRES_URI="${POSTGRES_URI:?set POSTGRES_URI (e.g. postgres://user:pass@host:5432/dbname)}"
export PGRST_DB_URI="${PGRST_DB_URI:-$POSTGRES_URI}"

# postgres://user:pass@host:port/db -> jdbc:postgresql://host:port/db
rest="${POSTGRES_URI#postgres://}"
creds="${rest%%@*}"
hostdb="${rest#*@}"
user="${creds%%:*}"
pass="${creds#*:}"
hostport="${hostdb%%/*}"
dbname="${hostdb#*/}"
dbname="${dbname%%\?*}"

FLYWAY_JDBC_URL="jdbc:postgresql://${hostport}/${dbname}"

flyway \
  -locations=filesystem:/flyway/sql \
  -connectRetries="${CONNECT_RETRIES:-60}" \
  -url="$FLYWAY_JDBC_URL" \
  -user="$user" \
  -password="$pass" \
  -validateMigrationNaming=true \
  ${NOTIFICATIONS_ENDPOINT:+-placeholders.notifications_endpoint="$NOTIFICATIONS_ENDPOINT"} \
  migrate

for i in $(seq 1 60); do temporal operator cluster health --address "$ADDR" && break || sleep 1; done
temporal operator namespace create --address "$ADDR" --namespace reminders --retention 30d || true

cat >/tmp/postgrest.conf <<EOF
db-uri = "${PGRST_DB_URI:?}"
db-schema = "${PGRST_DB_SCHEMA:-api}"
db-anon-role = "${PGRST_DB_ANON_ROLE:-anon}"
server-host = "0.0.0.0"
server-port = ${PORT:-80}
EOF

[ -n "${PGRST_JWT_SECRET:-}" ] && echo "jwt-secret = \"${PGRST_JWT_SECRET}\"" >>/tmp/postgrest.conf

exec postgrest /tmp/postgrest.conf
