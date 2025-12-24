import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from temporalio import activity, workflow
from temporalio.client import Client

TASK_QUEUE = os.getenv("TASK_QUEUE", "reminders")
TEMPORAL_ADDRESS = os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_NAMESPACE = os.getenv("TEMPORAL_NAMESPACE", "default")


@dataclass
class ReminderRecord:
    reminder_id: str
    schedule_id: str
    title: str
    message: str
    tags: List[str]
    apprise_targets: List[str]
    # Generic external association
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    reminder_text: Optional[str] = None
    next_fire_time: Optional[datetime] = None


def _clean_text(s: Optional[str]) -> str:
    tokens = re.findall(r"[A-Za-z0-9_\-]+", s or "")
    return " ".join(tokens)


def _sa_for_record(r: ReminderRecord, record_workflow_id: Optional[str] = None) -> Dict[str, Any]:
    # Temporal Search Attributes must be lists (even singletons). Empty list clears.
    text = _clean_text(r.reminder_text) or _clean_text(f"{r.title} {r.message}")
    out: Dict[str, Any] = {
        "ReminderId": [r.reminder_id],
        "ReminderTitle": [r.title],
        "ReminderTags": list(r.tags or []),  # KeywordList
        "ReminderTargets": list(r.apprise_targets or []),  # KeywordList
        "ReminderText": [text] if text else [],  # Text
        "ReminderNextFireTime": [r.next_fire_time] if r.next_fire_time else [],  # Datetime

        # Generic association (renamed)
        "ReminderEntityType": [r.entity_type] if r.entity_type else [],
        "ReminderEntityId": [r.entity_id] if r.entity_id else [],

        # NEW: easy supported filters
        "ReminderScheduleId": [r.schedule_id] if r.schedule_id else [],
        "ReminderRecordWorkflowId": [record_workflow_id] if record_workflow_id else [],
    }
    return out


@workflow.defn(name="reminder.Record")
class RecordWorkflow:
    def __init__(self) -> None:
        self.r: Optional[ReminderRecord] = None
        self._wf_id: Optional[str] = None  # NEW

    @workflow.run
    async def run(self, r: ReminderRecord) -> None:
        self.r = r
        self._wf_id = workflow.info().workflow_id  # NEW
        workflow.upsert_search_attributes(_sa_for_record(r, self._wf_id))
        await workflow.wait_condition(lambda: False)  # forever

    @workflow.signal
    def update(self, patch: Dict[str, Any]) -> None:
        if not self.r:
            return
        for k, v in patch.items():
            if hasattr(self.r, k):
                setattr(self.r, k, v)
        workflow.upsert_search_attributes(_sa_for_record(self.r, self._wf_id))

    @workflow.signal
    def set_next_fire_time(self, t: Optional[datetime]) -> None:
        if not self.r:
            return
        self.r.next_fire_time = t
        workflow.upsert_search_attributes(_sa_for_record(self.r, self._wf_id))


@activity.defn
async def send_apprise(payload: Dict[str, Any]) -> bool:
    # Import here to avoid Temporal workflow sandbox restrictions (apprise uses locale at import time)
    import apprise

    a = apprise.Apprise()
    for t in (payload.get("apprise_targets") or []):
        a.add(t)
    targets = payload.get("apprise_targets") or []
    return bool(a.notify(title=payload.get("title", ""), body=payload.get("message", ""))) if targets else True


@activity.defn
async def refresh_next_fire_time(payload: Dict[str, Any]) -> None:
    c = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    sh = c.get_schedule_handle(payload["schedule_id"])
    d = await sh.describe()
    nxts = d.info.next_action_times or []
    # If there's no next action time and the schedule isn't paused, treat it as finished and clean up.
    if not nxts and not d.schedule.state.paused:
        try:
            await sh.delete()
        except Exception:
            pass
        try:
            await c.get_workflow_handle(payload["record_workflow_id"]).terminate("completed")
        except Exception:
            pass
        return
    nxt = nxts[0] if nxts else None
    await c.get_workflow_handle(payload["record_workflow_id"]).signal("set_next_fire_time", nxt)


@workflow.defn(name="reminder.Fire")
class FireWorkflow:
    @workflow.run
    async def run(self, payload: Dict[str, Any]) -> None:
        await workflow.execute_activity(send_apprise, payload, start_to_close_timeout=timedelta(seconds=30))
        await workflow.execute_activity(refresh_next_fire_time, payload, start_to_close_timeout=timedelta(seconds=30))


async def main() -> None:
    c = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    from temporalio.worker import Worker

    await Worker(
        c,
        task_queue=TASK_QUEUE,
        workflows=[RecordWorkflow, FireWorkflow],
        activities=[send_apprise, refresh_next_fire_time],
    ).run()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
