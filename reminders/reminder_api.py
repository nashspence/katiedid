import os, re, uuid, enum
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import isodate
from cattrs.preconf.json import make_converter
from dateutil.parser import isoparse
from fastapi import FastAPI, Query, HTTPException  # <-- add HTTPException
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    ScheduleUpdateInput,
)

from reminder_worker import ReminderRecord

TEMPORAL_ADDRESS = os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_NAMESPACE = os.getenv("TEMPORAL_NAMESPACE", "default")
TASK_QUEUE = os.getenv("TASK_QUEUE", "reminders")

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

app = FastAPI(title="Temporal Reminder API (minimal)")
_client: Optional[Client] = None


@app.on_event("startup")
async def _startup():
    global _client
    _client = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)


def client() -> Client:
    if not _client:
        raise RuntimeError("Temporal client not ready")
    return _client


def _q_words(s: str) -> List[str]:
    return [w for w in re.findall(r"[A-Za-z0-9_\-]+", s or "") if w]


def _esc_vis(s: str) -> str:
    """Escape a string for use inside Temporal visibility filter double-quotes."""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _or_eq(attr: str, vals: List[str]) -> str:
    return "(" + " OR ".join([f'{attr} = "{_esc_vis(v)}"' for v in vals if v]) + ")"


def _list_filter(
    reminder_id: Optional[str],
    schedule_id: Optional[str],
    record_workflow_id: Optional[str],
    entity_type: Optional[str],
    entity_id: Optional[str],
    tag: Optional[str],
    tag_any: Optional[List[str]],
    tag_all: Optional[List[str]],
    target: Optional[str],
    q: Optional[str],
    upcoming_after: Optional[datetime],
    extra: Optional[str],
) -> str:
    parts = ['WorkflowType = "reminder.Record"', "ExecutionStatus = 'Running'"]

    # NEW: easy supported id filters (Search Attributes)
    if reminder_id:
        parts.append(f'ReminderId = "{_esc_vis(reminder_id)}"')
    if schedule_id:
        parts.append(f'ReminderScheduleId = "{_esc_vis(schedule_id)}"')
    if record_workflow_id:
        parts.append(f'ReminderRecordWorkflowId = "{_esc_vis(record_workflow_id)}"')

    # Generic external association lookup
    if entity_type:
        parts.append(f'ReminderEntityType = "{_esc_vis(entity_type)}"')
    if entity_id:
        parts.append(f'ReminderEntityId = "{_esc_vis(entity_id)}"')

    # Back-compat single tag
    if tag:
        parts.append(f'ReminderTags = "{_esc_vis(tag)}"')

    # NEW: multi-tag helpers
    if tag_any:
        parts.append(_or_eq("ReminderTags", [t for t in tag_any if t]))
    if tag_all:
        for t in [t for t in tag_all if t]:
            parts.append(f'ReminderTags = "{_esc_vis(t)}"')

    # Apprise targets (KeywordList)
    if target:
        parts.append(f'ReminderTargets = "{_esc_vis(target)}"')

    for w in _q_words(q or ""):
        parts.append(f'ReminderText = "{_esc_vis(w)}"')  # Text '=' matches whole words (tokenized)

    if upcoming_after:
        parts.append(
            f'ReminderNextFireTime >= "{upcoming_after.astimezone(timezone.utc).isoformat()}"'
        )

    if extra:
        parts.append(f"({extra})")

    return " AND ".join(parts)


def _first(sa: Dict[str, Any], k: str):
    v = sa.get(k)
    return v[0] if isinstance(v, list) and v else v


def _exec_to_dict(e) -> Dict[str, Any]:
    sa = dict(e.search_attributes or {})
    return {
        "workflow_id": e.id,
        "run_id": e.run_id,
        "type": e.workflow_type,
        "status": str(e.status),
        "start_time": e.start_time,
        "search_attributes": sa,
    }


@app.post("/reminders")
async def create_reminder(body: Dict[str, Any]) -> Dict[str, Any]:
    rid = body.get("reminder_id") or str(uuid.uuid4())
    schedule_id = body.get("schedule_id") or f"rem-{rid}"
    record_wf_id = body.get("record_workflow_id") or f"record-{rid}"

    title = body.get("title", "")
    message = body.get("message", "")
    reminder_text = body.get("reminder_text") or None
    tags = body.get("tags") or []
    apprise_targets = body.get("apprise_targets") or []

    # Generic external association fields (renamed)
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
        # optional: include association for downstream observability/debugging
        "entity_type": entity_type,
        "entity_id": entity_id,
    }

    c = client()
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
                "reminder.Fire",
                fire_payload,
                id=f"fire-{rid}",
                task_queue=TASK_QUEUE,
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


# NEW: Read one reminder by reminder_id
@app.get("/reminders/{reminder_id}")
async def get_reminder(reminder_id: str) -> Dict[str, Any]:
    c = client()
    flt = _list_filter(
        reminder_id=reminder_id,
        schedule_id=None,
        record_workflow_id=None,
        entity_type=None,
        entity_id=None,
        tag=None,
        tag_any=None,
        tag_all=None,
        target=None,
        q=None,
        upcoming_after=None,
        extra=None,
    )
    async for e in c.list_workflows(flt):
        return _exec_to_dict(e)
    raise HTTPException(status_code=404, detail="Reminder not found")


@app.get("/reminders")
async def list_reminders(
    # NEW: id filters
    reminder_id: Optional[str] = Query(default=None, description="Filter by ReminderId search attribute"),
    schedule_id: Optional[str] = Query(default=None, description="Filter by ReminderScheduleId search attribute"),
    record_workflow_id: Optional[str] = Query(default=None, description="Filter by ReminderRecordWorkflowId search attribute"),

    entity_type: Optional[str] = Query(
        default=None,
        description="Generic association type stored in ReminderEntityType search attribute",
    ),
    entity_id: Optional[str] = Query(
        default=None,
        description="Generic association id stored in ReminderEntityId search attribute",
    ),

    # Back-compat single tag
    tag: Optional[str] = Query(default=None, description="Filter by tag (ReminderTags)"),

    # NEW: multi-tag filters
    tag_any: Optional[List[str]] = Query(default=None, description="Match any of these tags (OR)"),
    tag_all: Optional[List[str]] = Query(default=None, description="Match all of these tags (AND)"),

    target: Optional[str] = Query(default=None, description="Filter by Apprise target URL (ReminderTargets)"),
    q: Optional[str] = Query(default=None, description="Tokenized search against ReminderText"),
    upcoming_after: Optional[datetime] = Query(default=None, description="Filter by ReminderNextFireTime >= upcoming_after"),
    extra_filter: Optional[str] = Query(
        default=None, description="Raw Temporal List Filter clause appended with AND"
    ),
    sort: str = Query(default="next", description="next|start"),
    limit: int = 100,
) -> List[Dict[str, Any]]:
    c = client()
    flt = _list_filter(
        reminder_id, schedule_id, record_workflow_id,
        entity_type, entity_id,
        tag, tag_any, tag_all,
        target, q, upcoming_after, extra_filter
    )
    res: List[Dict[str, Any]] = []
    async for e in c.list_workflows(flt):
        res.append(_exec_to_dict(e))
        if len(res) >= max(1, min(limit, 1000)):
            break

    if sort == "start":
        return sorted(res, key=lambda x: x["start_time"])

    return sorted(
        res,
        key=lambda x: (
            _first(x["search_attributes"], "ReminderNextFireTime") is None,
            _first(x["search_attributes"], "ReminderNextFireTime"),
        ),
    )


@app.put("/reminders/{reminder_id}")
async def update_reminder(reminder_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    rid = reminder_id
    schedule_id = body.get("schedule_id") or f"rem-{rid}"
    record_wf_id = body.get("record_workflow_id") or f"record-{rid}"

    title = body.get("title", "")
    message = body.get("message", "")
    reminder_text = body.get("reminder_text") if "reminder_text" in body else None
    tags = body.get("tags") or []
    apprise_targets = body.get("apprise_targets") or []

    # Generic external association fields (renamed)
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

    c = client()
    h = c.get_schedule_handle(schedule_id)

    async def updater(inp: ScheduleUpdateInput):
        s = inp.description.schedule
        s.spec, s.policy, s.state = spec, policies, state
        s.action = ScheduleActionStartWorkflow(
            "reminder.Fire",
            fire_payload,
            id=f"fire-{rid}",
            task_queue=TASK_QUEUE,
        )
        return ScheduleUpdate(schedule=s)

    await h.update(updater)

    patch: Dict[str, Any] = {
        "title": title,
        "message": message,
        "tags": tags,
        "apprise_targets": apprise_targets,
    }
    if "reminder_text" in body:
        patch["reminder_text"] = reminder_text
    # Only include association fields if present in request (prevents accidental clears).
    if "entity_type" in body:
        patch["entity_type"] = entity_type
    if "entity_id" in body:
        patch["entity_id"] = entity_id

    await c.get_workflow_handle(record_wf_id).signal("update", patch)

    d = await h.describe()
    nxt = d.info.next_action_times[0] if d.info.next_action_times else None
    await c.get_workflow_handle(record_wf_id).signal("set_next_fire_time", nxt)
    return {"ok": True, "next_action_times": d.info.next_action_times}


@app.delete("/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str) -> Dict[str, Any]:
    rid = reminder_id
    schedule_id = f"rem-{rid}"
    record_wf_id = f"record-{rid}"
    c = client()
    try:
        await c.get_schedule_handle(schedule_id).delete()
    except Exception:
        pass
    try:
        await c.get_workflow_handle(record_wf_id).terminate("deleted")
    except Exception:
        pass
    return {"ok": True}


@app.get("/fires")
async def list_fires(
    scheduled_by_id: Optional[str] = Query(default=None, description="TemporalScheduledById (Schedule Id)"),
    after: Optional[datetime] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    parts = ['WorkflowType = "reminder.Fire"']
    if scheduled_by_id:
        parts.append(f'TemporalScheduledById = "{_esc_vis(scheduled_by_id)}"')
    if after:
        parts.append(f'TemporalScheduledStartTime >= "{after.astimezone(timezone.utc).isoformat()}"')
    flt = " AND ".join(parts)

    c = client()
    res: List[Dict[str, Any]] = []
    async for e in c.list_workflows(flt):
        res.append(_exec_to_dict(e))
        if len(res) >= max(1, min(limit, 1000)):
            break
    return res
