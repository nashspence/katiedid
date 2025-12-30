import os, json, asyncio
from datetime import datetime, timedelta, timezone
from urllib import request, error
from zoneinfo import ZoneInfo

import asyncpg
from temporalio import activity, workflow
from temporalio.client import (
    Client, Schedule, ScheduleActionStartWorkflow, ScheduleAlreadyRunningError,
    ScheduleCalendarSpec, ScheduleIntervalSpec, ScheduleOverlapPolicy,
    SchedulePolicy, ScheduleRange, ScheduleSpec, ScheduleUpdate,
)

TASK_QUEUE = os.getenv("TASK_QUEUE", "reminders")
TEMPORAL_ADDRESS = os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_NAMESPACE = os.getenv("TEMPORAL_NAMESPACE", "reminders")
API_UPSTREAM = os.getenv("API_UPSTREAM", "http://api:80").rstrip("/")
POSTGRES_URI = os.getenv("POSTGRES_URI")

POLL_SECONDS = float(os.getenv("OUTBOX_POLL_SECONDS", "1.0"))
BATCH_SIZE = int(os.getenv("OUTBOX_BATCH_SIZE", "200"))
CONCURRENCY = int(os.getenv("OUTBOX_CONCURRENCY", "50"))

CLEAN_EVERY = float(os.getenv("CLEAN_SECONDS", "60"))
WF_TYPE = "reminder_fire"


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _sid(rid: int) -> str:
    return f"reminder-{rid}"


def _cal_for(dt: datetime, tz: str) -> ScheduleCalendarSpec:
    tz = tz or "UTC"
    try:
        dt = _utc(dt).astimezone(ZoneInfo(tz))
    except Exception:
        tz, dt = "UTC", _utc(dt)
    r = lambda v: [ScheduleRange(v)]
    return ScheduleCalendarSpec(
        year=r(dt.year), month=r(dt.month), day_of_month=r(dt.day),
        hour=r(dt.hour), minute=r(dt.minute), second=r(dt.second),
    )


def _postgrest_fire(rid: int) -> None:
    url = f"{API_UPSTREAM}/rpc/fire_reminder"
    data = json.dumps({"_reminder_id": rid}).encode("utf-8")
    req = request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with request.urlopen(req, timeout=10) as resp:
        if resp.status not in (200, 201, 204):
            raise RuntimeError(f"PostgREST RPC failed: {resp.status}")


@activity.defn
async def fire_reminder(rid: int) -> None:
    try:
        await asyncio.to_thread(_postgrest_fire, rid)
    except error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError(f"PostgREST HTTPError {e.code}: {body}") from e


@activity.defn
async def delete_schedule(rid: int) -> None:
    c = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    try:
        await c.get_schedule_handle(_sid(rid)).delete()
    except Exception:
        pass


@workflow.defn(name=WF_TYPE)
class ReminderFireWorkflow:
    @workflow.run
    async def run(self, rid: int, delete_after: bool = False) -> None:
        await workflow.execute_activity(
            fire_reminder, rid,
            start_to_close_timeout=timedelta(seconds=20),
            schedule_to_close_timeout=timedelta(minutes=2),
        )
        if delete_after:
            await workflow.execute_activity(
                delete_schedule, rid, start_to_close_timeout=timedelta(seconds=20)
            )


async def _sched_delete(c: Client, rid: int) -> None:
    try:
        await c.get_schedule_handle(_sid(rid)).delete()
    except Exception:
        pass


async def _sched_upsert(c: Client, rid: int, spec: ScheduleSpec, delete_after: bool) -> None:
    sch = Schedule(
        action=ScheduleActionStartWorkflow(
            WF_TYPE,
            args=[rid, delete_after],
            id=_sid(rid),
            task_queue=TASK_QUEUE,
        ),
        spec=spec,
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )
    try:
        await c.create_schedule(_sid(rid), sch)
    except ScheduleAlreadyRunningError:
        await c.get_schedule_handle(_sid(rid)).update(
            lambda _: ScheduleUpdate(schedule=sch)
        )
    except Exception:
        await c.get_schedule_handle(_sid(rid)).update(
            lambda _: ScheduleUpdate(schedule=sch)
        )


FETCH_SQL = """
select r.id, r.kind, r.enabled, r.before, r.at, r.every, r.cron, r.start_at, r.end_at, r.tz,
       r.task_id, t.due_date, t.done
from api.reminders r
left join api.tasks t on t.id = r.task_id
where r.id = $1;
"""

CLAIM_SQL = """
with cte as (
  select id
  from api.reminder_outbox
  where processed_at is null and available_at <= now()
  order by id
  limit $1
  for update skip locked
)
update api.reminder_outbox o
set attempts = attempts + 1,
    available_at = now() + interval '30 seconds'
from cte
where o.id = cte.id
returning o.id, o.op, o.reminder_id, o.attempts;
"""

MARK_OK = "update api.reminder_outbox set processed_at=now(), last_error=null where id=$1;"
MARK_FAIL = """
update api.reminder_outbox
set last_error=$2, available_at=now() + ($3::int * interval '1 second')
where id=$1;
"""

CLEAN_SQL = """
select id
from api.reminders
where enabled
  and end_at is not null
  and end_at <= now()
  and kind in ('interval','cron');
"""

DISABLE_SQL = "update api.reminders set enabled=false where id = any($1::bigint[]);"


def _backoff(attempts: int) -> int:
    return min(300, 2 ** max(0, attempts - 1))


async def _sync_one(pg: asyncpg.Connection, c: Client, rid: int) -> None:
    row = await pg.fetchrow(FETCH_SQL, rid)
    if not row or not row["enabled"]:
        await _sched_delete(c, rid)
        return

    k = row["kind"]
    tz = row["tz"] or "UTC"
    sa, ea = row["start_at"], row["end_at"]

    now = datetime.now(timezone.utc)
    if ea and _utc(ea) <= now:
        await _sched_delete(c, rid)
        return

    if k == "one_off":
        at = row["at"]
        if not at:
            await _sched_delete(c, rid)
            return
        at = _utc(at)
        spec = ScheduleSpec(
            calendars=[_cal_for(at, tz)],
            start_at=at,
            end_at=at + timedelta(seconds=1),
            time_zone_name=tz,
        )
        await _sched_upsert(c, rid, spec, True)
        return

    if k == "task_due_before":
        if row["done"] or row["due_date"] is None or row["before"] is None:
            await _sched_delete(c, rid)
            return
        ft = _utc(row["due_date"] - row["before"])
        spec = ScheduleSpec(
            calendars=[_cal_for(ft, tz)],
            start_at=ft,
            end_at=ft + timedelta(seconds=1),
            time_zone_name=tz,
        )
        await _sched_upsert(c, rid, spec, True)
        return

    if k == "interval":
        ev = row["every"]
        if not ev:
            await _sched_delete(c, rid)
            return
        spec = ScheduleSpec(
            intervals=[ScheduleIntervalSpec(every=ev)],
            start_at=_utc(sa) if sa else None,
            end_at=_utc(ea) if ea else None,
            time_zone_name=tz,
        )
        await _sched_upsert(c, rid, spec, False)
        return

    if k == "cron":
        cr = row["cron"]
        if not cr:
            await _sched_delete(c, rid)
            return
        spec = ScheduleSpec(
            cron_expressions=[cr],
            start_at=_utc(sa) if sa else None,
            end_at=_utc(ea) if ea else None,
            time_zone_name=tz,
        )
        await _sched_upsert(c, rid, spec, False)
        return

    await _sched_delete(c, rid)


async def _process_row(pg: asyncpg.Connection, c: Client, row) -> None:
    oid, op, rid, att = row["id"], row["op"], int(row["reminder_id"]), int(row["attempts"])
    try:
        if op == "delete":
            await _sched_delete(c, rid)
        else:
            await _sync_one(pg, c, rid)
        await pg.execute(MARK_OK, oid)
    except Exception as e:
        await pg.execute(MARK_FAIL, oid, str(e), _backoff(att))


async def run_worker() -> None:
    c = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    from temporalio.worker import Worker
    await Worker(
        c,
        task_queue=TASK_QUEUE,
        workflows=[ReminderFireWorkflow],
        activities=[fire_reminder, delete_schedule],
    ).run()


async def run_drainer() -> None:
    if not POSTGRES_URI:
        raise RuntimeError("POSTGRES_URI is required")
    c = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    pool = await asyncpg.create_pool(POSTGRES_URI, min_size=1, max_size=5)
    sem = asyncio.Semaphore(CONCURRENCY)
    loop = asyncio.get_running_loop()
    next_clean = 0.0

    async def one(row):
        async with sem:
            async with pool.acquire() as pg:
                await _process_row(pg, c, row)

    async def cleanup():
        async with pool.acquire() as pg:
            ids = [int(x["id"]) for x in await pg.fetch(CLEAN_SQL)]
            if not ids:
                return
        for rid in ids:
            await _sched_delete(c, rid)
        async with pool.acquire() as pg:
            await pg.execute(DISABLE_SQL, ids)

    try:
        while True:
            t = loop.time()
            if t >= next_clean:
                next_clean = t + CLEAN_EVERY
                await cleanup()

            async with pool.acquire() as pg:
                rows = await pg.fetch(CLAIM_SQL, BATCH_SIZE)
            if not rows:
                await asyncio.sleep(POLL_SECONDS)
                continue
            await asyncio.gather(*(one(r) for r in rows))
    finally:
        await pool.close()


async def main() -> None:
    mode = (os.getenv("MODE") or (os.sys.argv[1] if len(os.sys.argv) > 1 else "")).lower()
    if mode == "worker":
        await run_worker()
    elif mode == "drainer":
        await run_drainer()
    else:
        raise SystemExit("usage: python reminders.py [worker|drainer]")


if __name__ == "__main__":
    asyncio.run(main())
