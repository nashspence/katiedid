import os, re, uuid, enum
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx, isodate
from dateutil.parser import isoparse
from humanfriendly import parse_timespan
from cattrs.preconf.json import make_converter
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from temporalio.client import (
    Client, Schedule, ScheduleActionStartWorkflow, SchedulePolicy, ScheduleSpec,
    ScheduleState, ScheduleUpdate, ScheduleUpdateInput
)

from reminder_worker import ReminderRecord  # your module

PORT = int(os.getenv("PORT", "80"))
PGRST = os.getenv("PGRST_INTERNAL", "http://127.0.0.1:3000")
TEMPORAL_ADDRESS = os.getenv("TEMPORAL_ADDRESS", "scheduler:7233")
TEMPORAL_NAMESPACE = os.getenv("TEMPORAL_NAMESPACE", "default")
TASK_QUEUE = os.getenv("TASK_QUEUE", "reminders")

app = FastAPI(title="Tasks+Reminders API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Prefer", "Authorization"],
)

J = {"Content-Type": "application/json", "Prefer": "return=representation"}

conv = make_converter()
conv.register_structure_hook(datetime, lambda v, _: isoparse(v) if isinstance(v, str) else v)
conv.register_structure_hook(
    timedelta,
    lambda v, _: timedelta(seconds=float(v)) if isinstance(v, (int, float)) else isodate.parse_duration(v),
)
conv.register_structure_hook_func(
    lambda t: isinstance(t, type) and issubclass(t, enum.Enum),
    lambda v, t: t[v] if isinstance(v, str) else t(v),
)

_client: Optional[Client] = None


@app.on_event("startup")
async def _startup():
    global _client
    _client = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)


def _c() -> Client:
    if not _client:
        raise RuntimeError("Temporal not ready")
    return _client


async def _pgrst(method: str, path_qs: str, *, headers=None, json=None):
    async with httpx.AsyncClient(timeout=60) as h:
        r = await h.request(method, f"{PGRST}{path_qs}", headers=headers, json=json)
    try:
        body = r.json() if r.text else None
    except Exception:
        body = r.text
    if r.status_code >= 400:
        raise HTTPException(r.status_code, body)
    return body


def _esc(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _words(s: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9_\-]+", s or "")


def _first(sa: dict, k: str):
    v = (sa or {}).get(k)
    return v[0] if isinstance(v, list) and v else v


def _wf_to_dict(e):
    sa = dict(e.search_attributes or {})
    return {
        "workflow_id": e.id,
        "run_id": e.run_id,
        "type": e.workflow_type,
        "status": str(e.status),
        "start_time": e.start_time,
        "search_attributes": sa,
    }


def _flt(
    reminder_id=None, schedule_id=None, record_workflow_id=None,
    entity_type=None, entity_id=None,
    tag=None, tag_any=None, tag_all=None,
    target=None, q=None, upcoming_after=None, extra=None
) -> str:
    p = ['WorkflowType = "reminder.Record"', "ExecutionStatus = 'Running'"]
    if reminder_id: p += [f'ReminderId = "{_esc(reminder_id)}"']
    if schedule_id: p += [f'ReminderScheduleId = "{_esc(schedule_id)}"']
    if record_workflow_id: p += [f'ReminderRecordWorkflowId = "{_esc(record_workflow_id)}"']
    if entity_type: p += [f'ReminderEntityType = "{_esc(entity_type)}"']
    if entity_id: p += [f'ReminderEntityId = "{_esc(entity_id)}"']
    if tag: p += [f'ReminderTags = "{_esc(tag)}"']
    if tag_any: p += ["(" + " OR ".join([f'ReminderTags = "{_esc(t)}"' for t in tag_any if t]) + ")"]
    if tag_all: p += [f'ReminderTags = "{_esc(t)}"' for t in (tag_all or []) if t]
    if target: p += [f'ReminderTargets = "{_esc(target)}"']
    for w in _words(q or ""): p += [f'ReminderText = "{_esc(w)}"']
    if upcoming_after: p += [f'ReminderNextFireTime >= "{upcoming_after.astimezone(timezone.utc).isoformat()}"']
    if extra: p += [f"({extra})"]
    return " AND ".join(p)


async def _list_records(limit: int = 1000, **kw) -> List[dict]:
    out, c = [], _c()
    async for e in c.list_workflows(_flt(**kw)):
        out.append(_wf_to_dict(e))
        if len(out) >= max(1, min(limit, 5000)):
            break
    return sorted(
        out,
        key=lambda x: (
            _first(x["search_attributes"], "ReminderNextFireTime") is None,
            _first(x["search_attributes"], "ReminderNextFireTime"),
        ),
    )


def _sa(r: dict) -> dict:
    return r.get("search_attributes") or {}


def _pick(r: dict, k: str):
    v = _sa(r).get(k)
    return v[0] if isinstance(v, list) and v else v


def _arr(r: dict, k: str) -> Optional[List[str]]:
    v = _sa(r).get(k)
    if isinstance(v, list):
        return [str(x) for x in v if x is not None] or None
    return [str(v)] if v is not None else None


def _iso_no_ms(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc).replace(microsecond=0)
    return dt.isoformat().replace("+00:00", "Z")


def _to_utc(v: Any) -> Optional[datetime]:
    if v is None or v == "":
        return None
    try:
        dt = isoparse(str(v))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _calendar(dt: datetime) -> dict:
    return {
        "year": [{"start": dt.year}],
        "month": [{"start": dt.month}],
        "day_of_month": [{"start": dt.day}],
        "hour": [{"start": dt.hour}],
        "minute": [{"start": dt.minute}],
        "second": [{"start": int(dt.second)}],
    }


def _spec(fire_iso: str) -> Optional[dict]:
    dt = _to_utc(fire_iso)
    return None if not dt else {"calendars": [_calendar(dt)], "time_zone_name": "UTC", "start_at": _iso_no_ms(dt)}


def _targets_for(tags: List[str], alerts: List[dict]) -> List[str]:
    s = set()
    for a in (alerts or []):
        if a and a.get("enabled") and a.get("tag") in tags:
            s.add(a.get("url"))
    return list(s)


def _fire_time(due_iso: str, before: str) -> Optional[str]:
    dt = _to_utc(due_iso)
    if not dt:
        return None
    try:
        sec = float(parse_timespan(before))
    except Exception:
        return None
    return _iso_no_ms(dt - timedelta(seconds=sec))


async def _get_task(task_id: int):
    rows = await _pgrst(
        "GET",
        f"/tasks?select=id,title,description,tags,due_date,done,created_at,parent_id,position&id=eq.{task_id}",
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def _all_alerts():
    return await _pgrst(
        "GET",
        "/apprise_targets?select=tag,url,enabled,created_at&order=tag.asc,url.asc&limit=1000",
    )


async def _alert_tags(search: str, page: int, page_size: int):
    rows = await _pgrst(
        "POST",
        "/rpc/list_alert_tags",
        headers=J,
        json={"search": search, "page": page, "page_size": page_size},
    )
    items = rows if isinstance(rows, list) else []
    return {"items": items[:page_size], "hasMore": len(items) > page_size}


# -------------------- Optional raw PostgREST passthrough --------------------
@app.api_route("/db/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"])
async def db_proxy(path: str, req: Request):
    if req.method == "OPTIONS":
        return Response(status_code=204)
    url = f"{PGRST}/{path}" + (f"?{req.url.query}" if req.url.query else "")
    hdr = {k: req.headers[k] for k in ["content-type", "prefer", "authorization", "accept-profile", "content-profile"] if k in req.headers}
    async with httpx.AsyncClient(timeout=60) as h:
        r = await h.request(req.method, url, headers=hdr, content=await req.body())
    out_hdr = {k: v for k, v in r.headers.items() if k.lower() in ["content-type", "content-range", "location"]}
    return Response(content=r.content, status_code=r.status_code, headers=out_hdr)


# ==================== Temporal reminder cores ====================
async def _create_reminder_core(body: Dict[str, Any]) -> Dict[str, Any]:
    rid = body.get("reminder_id") or str(uuid.uuid4())
    schedule_id = body.get("schedule_id") or f"rem-{rid}"
    record_wf_id = body.get("record_workflow_id") or f"record-{rid}"

    title = body.get("title", "")
    message = body.get("message", "")
    reminder_text = body.get("reminder_text") or None
    tags = body.get("tags") or []
    apprise_targets = body.get("apprise_targets") or []
    entity_type = body.get("entity_type") or None
    entity_id = body.get("entity_id") or None

    spec = conv.structure(body.get("spec") or {}, ScheduleSpec)
    policies = conv.structure(body.get("policies") or {}, SchedulePolicy)
    state = conv.structure(body.get("state") or {}, ScheduleState)

    fire_payload = {
        "reminder_id": rid,
        "schedule_id": schedule_id,
        "record_workflow_id": record_wf_id,
        "title": title,
        "message": message,
        "apprise_targets": apprise_targets,
        "entity_type": entity_type,
        "entity_id": entity_id,
    }

    c = _c()
    await c.start_workflow(
        "reminder.Record",
        ReminderRecord(
            reminder_id=rid,
            schedule_id=schedule_id,
            title=title,
            message=message,
            tags=list(tags),
            apprise_targets=list(apprise_targets),
            entity_type=entity_type,
            entity_id=entity_id,
            reminder_text=reminder_text,
        ),
        id=record_wf_id,
        task_queue=TASK_QUEUE,
    )

    await c.create_schedule(
        schedule_id,
        Schedule(
            action=ScheduleActionStartWorkflow(
                "reminder.Fire", fire_payload, id=f"fire-{rid}", task_queue=TASK_QUEUE
            ),
            spec=spec,
            policy=policies,
            state=state,
        ),
    )

    d = await c.get_schedule_handle(schedule_id).describe()
    nxt = d.info.next_action_times[0] if d.info.next_action_times else None
    await c.get_workflow_handle(record_wf_id).signal("set_next_fire_time", nxt)
    return {
        "reminder_id": rid,
        "schedule_id": schedule_id,
        "record_workflow_id": record_wf_id,
        "next_action_times": d.info.next_action_times,
    }


async def _update_reminder_core(reminder_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    rid = reminder_id
    schedule_id = body.get("schedule_id") or f"rem-{rid}"
    record_wf_id = body.get("record_workflow_id") or f"record-{rid}"

    title = body.get("title", "")
    message = body.get("message", "")
    reminder_text = body.get("reminder_text") if "reminder_text" in body else None
    tags = body.get("tags") or []
    apprise_targets = body.get("apprise_targets") or []
    entity_type = body.get("entity_type") if "entity_type" in body else None
    entity_id = body.get("entity_id") if "entity_id" in body else None

    spec = conv.structure(body.get("spec") or {}, ScheduleSpec)
    policies = conv.structure(body.get("policies") or {}, SchedulePolicy)
    state = conv.structure(body.get("state") or {}, ScheduleState)

    fire_payload = {
        "reminder_id": rid,
        "schedule_id": schedule_id,
        "record_workflow_id": record_wf_id,
        "title": title,
        "message": message,
        "apprise_targets": apprise_targets,
        "entity_type": entity_type,
        "entity_id": entity_id,
    }

    c = _c()
    h = c.get_schedule_handle(schedule_id)

    async def updater(inp: ScheduleUpdateInput):
        s = inp.description.schedule
        s.spec, s.policy, s.state = spec, policies, state
        s.action = ScheduleActionStartWorkflow(
            "reminder.Fire", fire_payload, id=f"fire-{rid}", task_queue=TASK_QUEUE
        )
        return ScheduleUpdate(schedule=s)

    await h.update(updater)

    patch: Dict[str, Any] = {"title": title, "message": message, "tags": tags, "apprise_targets": apprise_targets}
    if "reminder_text" in body:
        patch["reminder_text"] = reminder_text
    if "entity_type" in body:
        patch["entity_type"] = entity_type
    if "entity_id" in body:
        patch["entity_id"] = entity_id

    await c.get_workflow_handle(record_wf_id).signal("update", patch)

    d = await h.describe()
    nxt = d.info.next_action_times[0] if d.info.next_action_times else None
    await c.get_workflow_handle(record_wf_id).signal("set_next_fire_time", nxt)
    return {"ok": True, "next_action_times": d.info.next_action_times}


async def _delete_reminder_core(reminder_id: str) -> Dict[str, Any]:
    rid = reminder_id
    schedule_id = f"rem-{rid}"
    record_wf_id = f"record-{rid}"
    c = _c()
    try:
        await c.get_schedule_handle(schedule_id).delete()
    except Exception:
        pass
    try:
        await c.get_workflow_handle(record_wf_id).terminate("deleted")
    except Exception:
        pass
    return {"ok": True}


# ==================== Automatic sync ====================
async def _sync_task_reminders(task_id: int, task: dict):
    recs = await _list_records(entity_type="task", entity_id=str(task_id))
    due = task.get("due_date") or None
    tags = task.get("tags") if isinstance(task.get("tags"), list) else []
    alerts = await _all_alerts()

    if not _to_utc(due):
        for r in recs:
            rid = _pick(r, "ReminderId") or r.get("workflow_id")
            if rid:
                await _delete_reminder_core(rid)
        return

    for r in recs:
        rid = _pick(r, "ReminderId") or r.get("workflow_id")
        before = _pick(r, "ReminderText") or ""
        fire_iso = _fire_time(due, before)
        if not rid or not fire_iso:
            continue

        payload = {
            "entity_type": "task",
            "entity_id": str(task_id),
            "title": (f"Reminder: {task.get('title','')}".strip() or "Reminder"),
            "message": f'Reminder for "{task.get("title","")}" due {due}',
            "tags": tags,
            "apprise_targets": _targets_for(tags, alerts),
            "reminder_text": before,
            "spec": _spec(fire_iso),
        }
        if payload["spec"]:
            await _update_reminder_core(rid, payload)


async def _sync_tag_reminders(tag: str):
    recs = await _list_records(tag=tag, limit=5000)
    for r in recs:
        et = _pick(r, "ReminderEntityType")
        eid = _pick(r, "ReminderEntityId")
        if et != "task" or not eid:
            continue
        task = await _get_task(int(eid))
        if task:
            await _sync_task_reminders(int(eid), task)


# ==================== Tasks ====================
@app.get("/tasks")
async def list_tasks(
    parentId: Optional[int] = None,
    includeDone: bool = False,
    page: int = 1,
    pageSize: int = 25,
    sort: str = "position",
    dir: str = "asc",
    search: str = "",
    tags: str = "",
):
    page, pageSize = max(1, page), max(1, min(200, pageSize))
    col = {"position": "position", "due": "due_date", "created": "created_at", "title": "title"}.get(sort, "position")
    dir = "desc" if dir == "desc" else "asc"
    nul = ".nullslast" if col == "due_date" else ""

    qs = [
        ("select", "id,title,description,tags,due_date,done,created_at,parent_id,position"),
        ("order", f"{col}.{dir}{nul}"),
        ("limit", str(pageSize + 1)),
        ("offset", str((page - 1) * pageSize)),
        ("parent_id", "is.null" if parentId is None else f"eq.{parentId}"),
    ]
    if not includeDone:
        qs.append(("done", "eq.false"))

    t = [x for x in re.split(r"[,\s]+", (tags or "").strip()) if x]
    if t:
        qs.append(("tags", f"ov.{{{','.join(t)}}}"))

    s = (search or "").strip().lower()
    if s:
        qs.append(("or", f"(title.ilike.*{s}*,description.ilike.*{s}*)"))

    qstr = "&".join([f"{k}={quote(v, safe='().,*{}:=')}" for k, v in qs])
    rows = await _pgrst("GET", f"/tasks?{qstr}")
    items = rows if isinstance(rows, list) else []
    return {"items": items[:pageSize], "hasMore": len(items) > pageSize}


@app.post("/tasks")
async def create_task(body: Dict[str, Any]):
    title = str(body.get("title", "")).strip()
    if not title:
        raise HTTPException(400, "title required")
    send = {
        "title": title,
        "description": str(body.get("description", "")),
        "tags": body.get("tags") if isinstance(body.get("tags"), list) else [],
        "due_date": body.get("dueDate") or None,
        "done": False,
        "parent_id": body.get("parentId", None),
    }
    return await _pgrst("POST", "/rpc/append_task", headers=J, json=send)


@app.get("/tasks/{task_id}")
async def get_task(task_id: int):
    t = await _get_task(task_id)
    if not t:
        raise HTTPException(404, "not found")
    return t


@app.patch("/tasks/{task_id}")
async def patch_task(task_id: int, body: Dict[str, Any]):
    prev = await _get_task(task_id)
    if not prev:
        raise HTTPException(404, "not found")

    patch = dict(body or {})
    if "dueDate" in patch:
        patch["due_date"] = patch.pop("dueDate")
    if "parentId" in patch:
        patch["parent_id"] = patch.pop("parentId")

    updated_rows = await _pgrst("PATCH", f"/tasks?id=eq.{task_id}", headers=J, json=patch)
    updated = updated_rows[0] if isinstance(updated_rows, list) and updated_rows else None

    prev_due = prev.get("due_date") or None
    prev_tags = prev.get("tags") if isinstance(prev.get("tags"), list) else []
    next_due = (patch.get("due_date") or None) if ("due_date" in patch) else prev_due
    next_tags = patch.get("tags") if ("tags" in patch) else prev_tags

    if prev_due != next_due or prev_tags != next_tags:
        task = updated or (await _get_task(task_id)) or prev
        await _sync_task_reminders(task_id, task)

    return updated or updated_rows or {"ok": True}


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: int):
    await _pgrst("DELETE", f"/tasks?id=eq.{task_id}", headers={"Prefer": "return=representation"})
    return {"ok": True}


@app.post("/tasks/{task_id}/move")
async def move_task(task_id: int, body: Dict[str, Any]):
    send = {
        "task_id": task_id,
        "new_parent_id": body.get("newParentId", None),
        "new_position": int(body.get("newPosition")),
    }
    return await _pgrst("POST", "/rpc/move_task", headers=J, json=send) or {"ok": True}


# ==================== Task reminders (UI-friendly) ====================
@app.get("/tasks/{task_id}/reminders")
async def task_reminders(task_id: int):
    recs = await _list_records(entity_type="task", entity_id=str(task_id))
    return [
        {"id": _pick(r, "ReminderId") or r.get("workflow_id") or "", "before": _pick(r, "ReminderText") or "", "nextFireTime": _pick(r, "ReminderNextFireTime") or ""}
        for r in recs
    ]


@app.post("/tasks/{task_id}/reminders")
async def create_task_reminder(task_id: int, body: Dict[str, Any]):
    before = str(body.get("before", "")).strip()
    if not before:
        raise HTTPException(400, "before required (e.g. '10m')")

    task = await _get_task(task_id)
    if not task:
        raise HTTPException(404, "task not found")
    if not task.get("due_date"):
        raise HTTPException(400, "task must have dueDate")

    fire_iso = _fire_time(task["due_date"], before)
    if not fire_iso:
        raise HTTPException(400, "invalid before value")

    alerts = await _all_alerts()
    tags = task.get("tags") if isinstance(task.get("tags"), list) else []
    payload = {
        "entity_type": "task",
        "entity_id": str(task_id),
        "title": (f"Reminder: {task.get('title','')}".strip() or "Reminder"),
        "message": f'Reminder for "{task.get("title","")}" due {task["due_date"]}',
        "tags": tags,
        "apprise_targets": _targets_for(tags, alerts),
        "reminder_text": before,
        "spec": _spec(fire_iso),
    }
    if not payload["spec"]:
        raise HTTPException(400, "bad reminder spec")
    return await _create_reminder_core(payload)


# ==================== Alerts ====================
@app.get("/alerts")
async def list_alerts(search: str = "", page: int = 1, pageSize: int = 25):
    page, pageSize = max(1, page), max(1, min(200, pageSize))
    return await _alert_tags(search.strip(), page, pageSize)


@app.get("/alerts/{tag}")
async def list_alerts_by_tag(tag: str):
    return await _pgrst(
        "GET",
        f"/apprise_targets?select=tag,url,enabled,created_at&tag=eq.{quote(tag)}&order=url.asc",
    )


@app.post("/alerts")
async def create_alert(body: Dict[str, Any]):
    tag = str(body.get("tag", "")).strip()
    url = str(body.get("url", "")).strip()
    if not tag or not url:
        raise HTTPException(400, "tag and url required")
    out = await _pgrst("POST", "/apprise_targets", headers=J, json={"tag": tag, "url": url, "enabled": body.get("enabled", True)})
    await _sync_tag_reminders(tag)
    return out


@app.put("/alerts/{tag}")
async def update_alert(tag: str, url: str, body: Dict[str, Any]):
    if not url:
        raise HTTPException(400, "url query param required")
    out = await _pgrst(
        "PATCH",
        f"/apprise_targets?tag=eq.{quote(tag)}&url=eq.{quote(url)}",
        headers=J,
        json={"enabled": bool(body.get("enabled"))},
    )
    await _sync_tag_reminders(tag)
    return out


@app.delete("/alerts/{tag}")
async def delete_alert(tag: str, url: Optional[str] = None):
    if url:
        out = await _pgrst(
            "DELETE",
            f"/apprise_targets?tag=eq.{quote(tag)}&url=eq.{quote(url)}",
            headers={"Prefer": "return=representation"},
        )
    else:
        out = await _pgrst(
            "DELETE",
            f"/apprise_targets?tag=eq.{quote(tag)}",
            headers={"Prefer": "return=representation"},
        )
    await _sync_tag_reminders(tag)
    return out or {"ok": True}


# ==================== Temporal reminders (direct) ====================
@app.post("/reminders")
async def create_reminder(body: Dict[str, Any]) -> Dict[str, Any]:
    return await _create_reminder_core(body)


@app.get("/reminders/{reminder_id}")
async def get_reminder(reminder_id: str):
    async for e in _c().list_workflows(_flt(reminder_id=reminder_id)):
        return _wf_to_dict(e)
    raise HTTPException(404, "Reminder not found")


@app.get("/reminders")
async def list_reminders(
    reminder_id: Optional[str] = None,
    schedule_id: Optional[str] = None,
    record_workflow_id: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    tag: Optional[str] = None,
    tag_any: Optional[List[str]] = Query(default=None),
    tag_all: Optional[List[str]] = Query(default=None),
    target: Optional[str] = None,
    q: Optional[str] = None,
    upcoming_after: Optional[datetime] = None,
    extra_filter: Optional[str] = None,
    limit: int = 100,
):
    out, c = [], _c()
    async for e in c.list_workflows(_flt(reminder_id, schedule_id, record_workflow_id, entity_type, entity_id, tag, tag_any, tag_all, target, q, upcoming_after, extra_filter)):
        out.append(_wf_to_dict(e))
        if len(out) >= max(1, min(limit, 5000)):
            break
    return sorted(
        out,
        key=lambda x: (
            _first(x["search_attributes"], "ReminderNextFireTime") is None,
            _first(x["search_attributes"], "ReminderNextFireTime"),
        ),
    )


@app.put("/reminders/{reminder_id}")
async def update_reminder(reminder_id: str, body: Dict[str, Any]):
    return await _update_reminder_core(reminder_id, body)


@app.delete("/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str):
    return await _delete_reminder_core(reminder_id)


@app.get("/fires")
async def list_fires(
    scheduledById: Optional[str] = None,
    after: Optional[datetime] = None,
    limit: int = 100,
):
    parts = ['WorkflowType = "reminder.Fire"']
    if scheduledById:
        parts.append(f'TemporalScheduledById = "{_esc(scheduledById)}"')
    if after:
        parts.append(f'TemporalScheduledStartTime >= "{after.astimezone(timezone.utc).isoformat()}"')
    flt = " AND ".join(parts)

    out, c = [], _c()
    async for e in c.list_workflows(flt):
        out.append(_wf_to_dict(e))
        if len(out) >= max(1, min(limit, 5000)):
            break
    return out


@app.get("/healthz")
async def healthz():
    return {"ok": True}
