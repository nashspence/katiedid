import os, json, asyncio, multiprocessing as mp, threading, itertools
from datetime import datetime, timedelta, timezone
from temporalio import activity, workflow
from temporalio.client import (
  Client, Schedule, ScheduleActionStartWorkflow, ScheduleAlreadyRunningError,
  ScheduleCalendarSpec, ScheduleIntervalSpec, ScheduleOverlapPolicy,
  SchedulePolicy, ScheduleRange, ScheduleSpec, ScheduleUpdate,
)

TASK_QUEUE=os.getenv("TASK_QUEUE","reminders")
TEMPORAL_ADDRESS=os.getenv("TEMPORAL_ADDRESS","localhost:7233")
TEMPORAL_NAMESPACE=os.getenv("TEMPORAL_NAMESPACE","reminders")
POSTGRES_URI=os.getenv("POSTGRES_URI")
POLL_SECONDS=float(os.getenv("OUTBOX_POLL_SECONDS","1.0"))
BATCH_SIZE=int(os.getenv("OUTBOX_BATCH_SIZE","200"))
CONCURRENCY=int(os.getenv("OUTBOX_CONCURRENCY","50"))

WF_INBOX="temporal_inbox"
WF_NOOP="noop"
_TCLIENT=None

def _utc(v):
  if v is None: return None
  if isinstance(v,datetime):
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
  if isinstance(v,str):
    s=v.replace("Z","+00:00")
    return datetime.fromisoformat(s).astimezone(timezone.utc)
  return None

def _rng(xs):
  return [ScheduleRange(int(x["start"]),None if x.get("end") is None else int(x["end"]),None if x.get("step") is None else int(x["step"])) for x in (xs or [])]

def _cal(d):
  return ScheduleCalendarSpec(
    second=_rng(d.get("second")),minute=_rng(d.get("minute")),hour=_rng(d.get("hour")),
    day_of_week=_rng(d.get("day_of_week")),day_of_month=_rng(d.get("day_of_month")),
    month=_rng(d.get("month")),year=_rng(d.get("year")),
  )

def _spec(j):
  j=j or {}
  ints=[ScheduleIntervalSpec(every=timedelta(seconds=int(i["every_seconds"])),offset=timedelta(seconds=int(i.get("offset_seconds",0)))) for i in (j.get("intervals") or [])]
  cals=[_cal(x) for x in (j.get("calendars") or [])]
  return ScheduleSpec(
    cron_expressions=j.get("cron_expressions") or [],
    intervals=ints,calendars=cals,
    start_at=_utc(j.get("start_at")),end_at=_utc(j.get("end_at")),
    time_zone_name=j.get("time_zone_name") or "UTC",
  )

async def _del(c,sid):
  try: await c.get_schedule_handle(sid).delete()
  except Exception: pass

async def _upsert(c,sid,sch):
  h=c.get_schedule_handle(sid)
  try: await c.create_schedule(sid,sch)
  except ScheduleAlreadyRunningError:
    await h.update(lambda _:ScheduleUpdate(schedule=sch))

async def _next_time(c,sid):
  try:
    d=await c.get_schedule_handle(sid).describe()
    xs=(d.info.next_action_times if d and d.info else None) or []
    return xs[0].astimezone(timezone.utc) if xs else None
  except Exception:
    return None

_ctx=mp.get_context("spawn")
_req=_ctx.Queue()
_res=_ctx.Queue()
_dbp=None
_wait={}
_ctr=itertools.count(1)

def _db_proc(dsn,req,res):
  import asyncpg
  async def run():
    pool=await asyncpg.create_pool(dsn,min_size=1,max_size=5)
    try:
      while True:
        m=await asyncio.to_thread(req.get)
        if m is None: break
        i=m["id"]
        try:
          async with pool.acquire() as pg:
            await pg.execute(
              "insert into api.temporal_inbox(kind,payload) values($1,$2::jsonb)",
              m["kind"], json.dumps(m.get("payload") or {}),
            )
          res.put({"id":i,"ok":True})
        except Exception as e:
          res.put({"id":i,"ok":False,"err":str(e)})
    finally:
      await pool.close()
  asyncio.run(run())

def _res_thread():
  while True:
    m=_res.get()
    if m is None: return
    w=_wait.pop(m.get("id"),None)
    if not w: continue
    loop,fut=w
    loop.call_soon_threadsafe(fut.set_result,m)

def _db_start():
  global _dbp
  if _dbp: return
  if not POSTGRES_URI: raise RuntimeError("POSTGRES_URI is required")
  _dbp=_ctx.Process(target=_db_proc,args=(POSTGRES_URI,_req,_res),daemon=True)
  _dbp.start()
  threading.Thread(target=_res_thread,daemon=True).start()

async def _db_put(kind,payload):
  if not _dbp or not _dbp.is_alive(): raise RuntimeError("db process died")
  loop=asyncio.get_running_loop()
  fut=loop.create_future()
  i=next(_ctr)
  _wait[i]=(loop,fut)
  _req.put({"id":i,"kind":kind,"payload":payload})
  m=await fut
  if not m.get("ok"): raise RuntimeError(m.get("err") or "db error")

@activity.defn
async def inbox(msg:dict)->None:
  msg=msg or {}
  kind=str(msg.get("kind") or "")
  payload=msg.get("payload") or {}
  await _db_put(kind,payload)
  if kind=="fire_reminder" and _TCLIENT:
    sid=payload.get("sid")
    rid=payload.get("reminder_id")
    if sid and rid and (await _next_time(_TCLIENT,sid)) is None:
      await _db_put("gc_exhausted",{"reminder_id":rid,"sid":sid})

@workflow.defn(name=WF_INBOX)
class InboxWorkflow:
  @workflow.run
  async def run(self,msg:dict)->None:
    await workflow.execute_activity(inbox,msg,start_to_close_timeout=timedelta(seconds=20))

@workflow.defn(name=WF_NOOP)
class NoopWorkflow:
  @workflow.run
  async def run(self)->None: return

CLAIM_SQL="""with cte as (
  select id from api.temporal_outbox where processed_at is null and available_at<=now()
  order by id limit $1 for update skip locked
) update api.temporal_outbox o
set attempts=attempts+1,available_at=now()+interval '30 seconds'
from cte where o.id=cte.id
returning o.id,o.op,o.sid,o.schedule,o.attempts;"""
MARK_OK="update api.temporal_outbox set processed_at=now(),last_error=null where id=$1;"
MARK_FAIL="update api.temporal_outbox set last_error=$2,available_at=now()+($3::int*interval '1 second') where id=$1;"
BACKOFF=lambda a:min(300,2**max(0,int(a)-1))

async def _proc(pg, c, row):
  oid,op,sid,sch,att=int(row["id"]),row["op"],row["sid"],row["schedule"],int(row["attempts"])
  try:
    if op=="delete":
      await _del(c,sid)
      return await pg.execute(MARK_OK,oid)

    sp=_spec(sch if isinstance(sch,dict) else json.loads(sch))
    if sid.startswith("reminder-"):
      rid=int(sid.split("-",1)[1])
      act=ScheduleActionStartWorkflow(
        WF_INBOX,
        args=[{"kind":"fire_reminder","payload":{"reminder_id":rid,"sid":sid}}],
        id=sid,task_queue=TASK_QUEUE
      )
    else:
      act=ScheduleActionStartWorkflow(WF_NOOP,args=[],id=sid,task_queue=TASK_QUEUE)

    sch_obj=Schedule(action=act,spec=sp,policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP))

    # taskroll is ephemeral: delete+create to reset Temporal schedule state each sync
    if sid.startswith("taskroll-"):
      await _del(c,sid)
      await c.create_schedule(sid,sch_obj)
    else:
      await _upsert(c,sid,sch_obj)

    nxt=await _next_time(c,sid)

    if sid.startswith("taskroll-") and nxt:
      tid=int(sid.split("-",1)[1])
      await pg.execute(
        """
        insert into api.temporal_inbox(kind,payload)
        select 'set_task_due',$1::jsonb
        where exists (
          select 1 from api.tasks
          where id=$2 and (due_pending or due_date is null)
        );
        """,
        json.dumps({"task_id":tid,"due_date":nxt.isoformat()}),
        tid,
      )
      await _del(c,sid)

    if nxt is None:
      await _del(c,sid)
      if sid.startswith("reminder-"):
        await pg.execute(
          "insert into api.temporal_inbox(kind,payload) values('gc_exhausted',$1::jsonb)",
          json.dumps({"reminder_id":int(sid.split("-",1)[1])}),
        )
      elif sid.startswith("taskroll-"):
        await pg.execute(
          "insert into api.temporal_inbox(kind,payload) values('clear_task_schedule',$1::jsonb)",
          json.dumps({"task_id":int(sid.split("-",1)[1])}),
        )

    await pg.execute(MARK_OK,oid)
  except Exception as e:
    await pg.execute(MARK_FAIL,oid,str(e),BACKOFF(att))


async def run_worker():
  global _TCLIENT
  _db_start()
  c=await Client.connect(TEMPORAL_ADDRESS,namespace=TEMPORAL_NAMESPACE)
  _TCLIENT=c
  from temporalio.worker import Worker
  try:
    await Worker(c,task_queue=TASK_QUEUE,workflows=[InboxWorkflow,NoopWorkflow],activities=[inbox]).run()
  finally:
    try: _req.put(None)
    except Exception: pass

async def run_drainer():
  import asyncpg
  c=await Client.connect(TEMPORAL_ADDRESS,namespace=TEMPORAL_NAMESPACE)
  if not POSTGRES_URI: raise RuntimeError("POSTGRES_URI is required")
  p=await asyncpg.create_pool(POSTGRES_URI,min_size=1,max_size=5)
  sem=asyncio.Semaphore(CONCURRENCY)

  async def one(row):
    async with sem:
      async with p.acquire() as pg:
        await _proc(pg,c,row)

  while True:
    async with p.acquire() as pg:
      rows=await pg.fetch(CLAIM_SQL,BATCH_SIZE)
    if not rows:
      await asyncio.sleep(POLL_SECONDS)
      continue
    await asyncio.gather(*(one(r) for r in rows))

async def main():
  mode=(os.getenv("MODE") or (os.sys.argv[1] if len(os.sys.argv)>1 else "")).lower()
  if mode=="worker": await run_worker()
  elif mode=="drainer": await run_drainer()
  else: raise SystemExit("usage: python reminders.py [worker|drainer]")

if __name__=="__main__":
  asyncio.run(main())
