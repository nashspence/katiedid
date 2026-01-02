from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from temporalio.client import (
    ScheduleCalendarSpec,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleRange,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    ScheduleUpdateInput,
    Client,
    Schedule,
)


def _ranges(rs: Optional[List[Dict[str, Any]]]) -> Optional[List[ScheduleRange]]:
    if not rs:
        return None
    return [
        ScheduleRange(
            start=int(r["start"]),
            end=int(r.get("end", r["start"])),
            step=int(r.get("step", 1)),
        )
        for r in rs
    ]


def _parse_dt_local(dt_local: Optional[str], tz_name: str) -> Optional[datetime]:
    if not dt_local:
        return None
    naive = datetime.fromisoformat(dt_local)  # "YYYY-MM-DDTHH:MM"
    return naive.replace(tzinfo=ZoneInfo(tz_name))


def parse_schedule_json(payload_json: str) -> Tuple[ScheduleSpec, Optional[SchedulePolicy], Optional[ScheduleState]]:
    payload = json.loads(payload_json)
    spec_in = payload.get("spec", {}) or {}
    policy_in = payload.get("policy", {}) or {}
    state_in = payload.get("state", {}) or {}

    tz = spec_in.get("time_zone_name") or "UTC"

    def cal(d: Dict[str, Any]) -> ScheduleCalendarSpec:
        kwargs: Dict[str, Any] = {}
        if d.get("comment") is not None:
            kwargs["comment"] = d["comment"]
        for field in ("second", "minute", "hour", "day_of_month", "month", "day_of_week", "year"):
            r = _ranges(d.get(field))
            if r is not None:
                kwargs[field] = r
        return ScheduleCalendarSpec(**kwargs)

    calendars = [cal(d) for d in (spec_in.get("calendars") or [])]
    skip = [cal(d) for d in (spec_in.get("skip") or [])]

    intervals: List[ScheduleIntervalSpec] = []
    for it in (spec_in.get("intervals") or []):
        every_s = int(it["every_seconds"])
        offset_s = int(it.get("offset_seconds", 0))
        if every_s <= 0:
            raise ValueError("every_seconds must be > 0")
        if offset_s < 0:
            raise ValueError("offset_seconds must be >= 0")
        intervals.append(
            ScheduleIntervalSpec(
                every=timedelta(seconds=every_s),
                offset=timedelta(seconds=offset_s),
            )
        )

    jitter_s = int(spec_in.get("jitter_seconds", 0) or 0)

    spec = ScheduleSpec(
        time_zone_name=tz,
        calendars=calendars,
        intervals=intervals,
        cron_expressions=spec_in.get("cron_expressions") or [],
        skip=skip,
        start_at=_parse_dt_local(spec_in.get("start_at_local"), tz),
        end_at=_parse_dt_local(spec_in.get("end_at_local"), tz),
        jitter=(timedelta(seconds=jitter_s) if jitter_s else None),
    )

    policy: Optional[SchedulePolicy] = None
    if policy_in:
        overlap_name = policy_in.get("overlap")
        overlap = ScheduleOverlapPolicy[overlap_name] if overlap_name else None
        catchup_s = int(policy_in.get("catchup_window_seconds", 0) or 0)

        policy = SchedulePolicy(
            overlap=overlap if overlap is not None else ScheduleOverlapPolicy.SKIP,
            catchup_window=(timedelta(seconds=catchup_s) if catchup_s else timedelta(days=365)),
        )

    state: Optional[ScheduleState] = None
    if state_in:
        remaining = int(state_in.get("remaining_actions", 0))
        limited = bool(state_in.get("limited_actions", False))
        if remaining != 0 and not limited:
            raise ValueError("remaining_actions != 0 requires limited_actions=true")
        if remaining == 0 and limited:
            raise ValueError("remaining_actions == 0 requires limited_actions=false")

        state = ScheduleState(
            paused=bool(state_in.get("paused", False)),
            limited_actions=limited,
            remaining_actions=remaining,
        )

    return spec, policy, state


async def create_schedule_from_form(
    client: Client,
    schedule_id: str,
    action,          # provided by caller
    form_json: str,
) -> None:
    spec, policy, state = parse_schedule_json(form_json)
    await client.create_schedule(schedule_id, Schedule(action=action, spec=spec, policy=policy, state=state))


async def update_schedule_from_form(
    client: Client,
    schedule_id: str,
    form_json: str,
) -> None:
    new_spec, new_policy, new_state = parse_schedule_json(form_json)
    handle = client.get_schedule_handle(schedule_id)

    async def updater(inp: ScheduleUpdateInput) -> ScheduleUpdate:
        sched = inp.description.schedule
        sched.spec = new_spec
        if new_policy is not None:
            sched.policy = new_policy
        if new_state is not None:
            sched.state = new_state
        return ScheduleUpdate(schedule=sched)

    await handle.update(updater)
