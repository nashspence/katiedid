#!/bin/sh
set -eu

ADDR="${TEMPORAL_ADDRESS:-scheduler:7233}"
NS="${TEMPORAL_NAMESPACE:-default}"

for i in $(seq 1 60); do temporal operator cluster health --address "$ADDR" && break || sleep 1; done
cat <<'EOF' | while read -r n t; do [ -z "${n:-}" ] || temporal operator search-attribute create --address "$ADDR" -n "$NS" --name "$n" --type "$t" || true; done
ReminderId Keyword
ReminderTags KeywordList
ReminderTitle Keyword
ReminderText Text
ReminderNextFireTime Datetime
ReminderEntityType Keyword
ReminderEntityId Keyword
ReminderTargets KeywordList
ReminderScheduleId Keyword
ReminderRecordWorkflowId Keyword
EOF

cat >/tmp/postgrest.conf <<EOF
db-uri = "${PGRST_DB_URI:?set PGRST_DB_URI}"
db-schema = "${PGRST_DB_SCHEMA:-api}"
db-anon-role = "${PGRST_DB_ANON_ROLE:-anon}"
server-host = "127.0.0.1"
server-port = 3000
EOF

[ -n "${PGRST_JWT_SECRET:-}" ] && echo "jwt-secret = \"${PGRST_JWT_SECRET}\"" >>/tmp/postgrest.conf

postgrest /tmp/postgrest.conf &

exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-80}"
