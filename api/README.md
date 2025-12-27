# Tasks + Reminders API (single image)

This container runs:
- PostgREST (internal, on 127.0.0.1:3000) backed by an external Postgres side-service
- FastAPI (public, on :80) exposing a clean REST API for UI apps + Temporal reminders API

## Public API
Tasks:
- GET/POST /tasks
- GET/PATCH/DELETE /tasks/{id}
- POST /tasks/{id}/move

Task reminders (UI):
- GET /tasks/{id}/reminders
- POST /tasks/{id}/reminders  body: { "before": "10m" }

Alerts:
- GET /alerts
- GET /alerts/{tag}
- POST /alerts
- PUT /alerts/{tag}?url=...  body: { "enabled": true|false }
- DELETE /alerts/{tag}        (optionally ?url=...)

Temporal (direct):
- GET/POST /reminders
- GET/PUT/DELETE /reminders/{id}
- GET /fires

Optional raw PostgREST passthrough:
- /db/*

## Required env vars
PostgREST:
- PGRST_DB_URI (required)
- PGRST_DB_SCHEMA (default public)
- PGRST_DB_ANON_ROLE (default anon)
- PGRST_JWT_SECRET (optional)

Temporal:
- TEMPORAL_ADDRESS (default localhost:7233)
- TEMPORAL_NAMESPACE (default default)
- TASK_QUEUE (default reminders)

Temporal Worker:
- NOTIFICATIONS_ENDPOINT
- TEMPORAL_ADDRESS (default localhost:7233)
- TEMPORAL_NAMESPACE (default default)
- TASK_QUEUE (default reminders)

## Run
docker compose up --build

Then hit:
- http://localhost:8080/tasks
- http://localhost:8080/alerts
- http://localhost:8080/tasks/{id}/reminders

## Temporal worker
Temporal worker that implements workflows:
- "reminder.Record"
- "reminder.Fire"
on the TASK_QUEUE (default "reminders").