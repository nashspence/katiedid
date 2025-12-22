# cycle-tasks-ui

Ultra-minimal, conventional Cycle.js SPA to exercise the PostgREST tasks API.

## Run
```bash
docker compose up --build
```
Open http://localhost:8080

- Default API is proxied at `/api` -> `http://host.docker.internal:3000/` (no CORS issues).
- Override with `?api=http://127.0.0.1:3000` if you prefer direct calls (then your API must allow CORS).

## DnD
Browser DnD, using the API RPCs:
- Drop above => `rpc/move_before`
- Drop below => `rpc/move_after`
- Drop onto row => `rpc/move_into` (append as last child)

## Add
Each task has: `+ above`, `+ below`, `+ subtask`.
