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

TASK_QUEUE=os.getenv("TASK_QUEUE","reminders")
TEMPORAL_ADDRESS=os.getenv("TEMPORAL_ADDRESS","localhost:7233")
TEMPORAL_NAMESPACE=os.getenv("TEMPORAL_NAMESPACE","reminders")
API_UPSTREAM=os.getenv("API_UPSTREAM","http://api:80").rstrip("/")
POSTGRES_URI=os.getenv("POSTGRES_URI")
POLL_SECONDS=float(os.getenv("OUTBOX_POLL_SECONDS","1.0"))
BATCH_SIZE=int(os.getenv("OUTBOX_BATCH_SIZE","200"))
CONCURRENCY=int(os.getenv("OUTBOX_CONCURRENCY","50"))
CLEAN_EVERY=float(os.getenv("CLEAN_SECONDS","60"))
WF_TYPE="reminder_fire"
NOOP_WF="noop"

def _utc(dt:datetime)->datetime:
  if dt.tzinfo is None: dt=dt.replace(tzinfo=timezone.utc)
  return dt.astimezone(timezone.utc)

def _sid(rid:int)->str: return f"reminder-{rid}"
def _tsid(tid:int)->str: return f"taskroll-{tid}"

def _cal_for(dt:datetime,tz:str)->ScheduleCalendarSpec:
  tz=tz or "UTC"
  try: dt=_utc(dt).astimezone(ZoneInfo(tz))
  except Exception: tz,dt="UTC",_utc(dt)
  r=lambda v:[ScheduleRange(v)]
  return ScheduleCalendarSpec(year=r(dt.year),month=r(dt.month),day_of_month=r(dt.day),
                             hour=r(dt.hour),minute=r(dt.minute),second=r(dt.second))

def _postgrest_fire(rid:int)->None:
  url=f"{API_UPSTREAM}/rpc/fire_reminder"
  data=json.dumps({"_reminder_id":rid}).encode("utf-8")
  req=request.Request(url,data=data,method="POST",
    headers={"Content-Type":"application/json","Accept":"application/json"})
  with request.urlopen(req,timeout=10) as resp:
    if resp.status not in (200,201,204): raise RuntimeError(f"PostgREST RPC failed: {resp.status}")

@activity.defn
async def fire_reminder(rid:int)->None:
  try: await asyncio.to_thread(_postgrest_fire,rid)
  except error.HTTPError as e:
    try: body=e.read().decode("utf-8","replace")
    except Exception: body=""
    raise RuntimeError(f"PostgREST HTTPError {e.code}: {body}") from e

@activity.defn
async def delete_schedule(rid:int)->None:
  c=await Client.connect(TEMPORAL_ADDRESS,namespace=TEMPORAL_NAMESPACE)
  try: await c.get_schedule_handle(_sid(rid)).delete()
  except Exception: pass

@workflow.defn(name=WF_TYPE)
class ReminderFireWorkflow:
  @workflow.run
  async def run(self,rid:int,delete_after:bool=False)->None:
    await workflow.execute_activity(fire_reminder,rid,start_to_close_timeout=timedelta(seconds=20),
      schedule_to_close_timeout=timedelta(minutes=2))
    if delete_after:
      await workflow.execute_activity(delete_schedule,rid,start_to_close_timeout=timedelta(seconds=20))

@workflow.defn(name=NOOP_WF)
class NoopWorkflow:
  @workflow.run
  async def run(self)->None: return

async def _del(c:Client,sid:str)->None:
  try: await c.get_schedule_handle(sid).delete()
  except Exception: pass

async def _upsert(c:Client,sid:str,sch:Schedule)->None:
  h=c.get_schedule_handle(sid)
  try: await c.create_schedule(sid,sch)
  except ScheduleAlreadyRunningError:
    await h.update(lambda _:ScheduleUpdate(schedule=sch))

async def _next_time(c:Client,sid:str)->datetime|None:
  h=c.get_schedule_handle(sid)
  for i in range(6):
    try:
      d=await h.describe()
      nxt=(d.info.next_action_times[0] if d and d.info and d.info.next_action_times else None)
      return _utc(nxt) if nxt else None
    except Exception as e:
      s=str(e)
      if "workflow not found" in s and "temporal-sys-scheduler:" in s:
        await asyncio.sleep(0.15*(i+1))
        continue
      raise
  return None

def _backoff(a:int)->int: return min(300,2**max(0,a-1))

FETCH_SQL="select r.id,r.kind,r.enabled,r.before,r.at,r.every,r.cron,r.start_at,r.end_at,r.tz,r.task_id,t.due_date,t.done from api.reminders r left join api.tasks t on t.id=r.task_id where r.id=$1;"
CLAIM_SQL="""with cte as (
  select id from api.reminder_outbox where processed_at is null and available_at<=now()
  order by id limit $1 for update skip locked
) update api.reminder_outbox o
set attempts=attempts+1,available_at=now()+interval '30 seconds'
from cte where o.id=cte.id
returning o.id,o.op,o.reminder_id,o.attempts;"""
MARK_OK="update api.reminder_outbox set processed_at=now(),last_error=null where id=$1;"
MARK_FAIL="update api.reminder_outbox set last_error=$2,available_at=now()+($3::int*interval '1 second') where id=$1;"
CLEAN_SQL="select id from api.reminders where enabled and end_at is not null and end_at<=now() and kind in ('interval','cron');"
DISABLE_SQL="update api.reminders set enabled=false where id=any($1::bigint[]);"

TASK_CLAIM_SQL="""with cte as (
  select id from api.task_roll_outbox where processed_at is null and available_at<=now()
  order by id limit $1 for update skip locked
) update api.task_roll_outbox o
set attempts=attempts+1,available_at=now()+interval '30 seconds'
from cte where o.id=cte.id
returning o.id,o.op,o.task_id,o.attempts;"""
TASK_MARK_OK="update api.task_roll_outbox set processed_at=now(),last_error=null where id=$1;"
TASK_MARK_FAIL="update api.task_roll_outbox set last_error=$2,available_at=now()+($3::int*interval '1 second') where id=$1;"
TASK_FETCH_SQL="select id,due_date,roll,roll_spec,roll_tz from api.tasks where id=$1;"
TASK_SET_DUE="update api.tasks set due_date=$2,due_date_pending=false where id=$1;"

async def _sync_rem(pg:asyncpg.Connection,c:Client,rid:int)->None:
  row=await pg.fetchrow(FETCH_SQL,rid)
  if not row or not row["enabled"]: return await _del(c,_sid(rid))
  k=row["kind"]; tz=row["tz"] or "UTC"; sa,ea=row["start_at"],row["end_at"]
  if ea and _utc(ea)<=datetime.now(timezone.utc): return await _del(c,_sid(rid))

  if k=="one_off":
    at=row["at"]
    if not at: return await _del(c,_sid(rid))
    at=_utc(at)
    spec=ScheduleSpec(calendars=[_cal_for(at,tz)],start_at=at,end_at=at+timedelta(seconds=1),time_zone_name=tz)
    sch=Schedule(action=ScheduleActionStartWorkflow(WF_TYPE,args=[rid,True],id=_sid(rid),task_queue=TASK_QUEUE),
      spec=spec,policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP))
    return await _upsert(c,_sid(rid),sch)

  if k=="task_due_before":
    if row["done"] or row["due_date"] is None or row["before"] is None: return await _del(c,_sid(rid))
    ft=_utc(row["due_date"]-row["before"])
    spec=ScheduleSpec(calendars=[_cal_for(ft,tz)],start_at=ft,end_at=ft+timedelta(seconds=1),time_zone_name=tz)
    sch=Schedule(action=ScheduleActionStartWorkflow(WF_TYPE,args=[rid,True],id=_sid(rid),task_queue=TASK_QUEUE),
      spec=spec,policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP))
    return await _upsert(c,_sid(rid),sch)

  if k=="interval":
    ev=row["every"]
    if not ev: return await _del(c,_sid(rid))
    spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=ev)],
      start_at=_utc(sa) if sa else None,end_at=_utc(ea) if ea else None,time_zone_name=tz)
  elif k=="cron":
    cr=row["cron"]
    if not cr: return await _del(c,_sid(rid))
    spec=ScheduleSpec(cron_expressions=[cr],
      start_at=_utc(sa) if sa else None,end_at=_utc(ea) if ea else None,time_zone_name=tz)
  else:
    return await _del(c,_sid(rid))

  sch=Schedule(action=ScheduleActionStartWorkflow(WF_TYPE,args=[rid,False],id=_sid(rid),task_queue=TASK_QUEUE),
    spec=spec,policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP))
  await _upsert(c,_sid(rid),sch)

def _rng(v):
  if v is None: return []
  if isinstance(v,(int,float,str,dict)): v=[v]
  if not v: return []
  out=[]
  for x in v:
    if isinstance(x,dict):
      st=int(x.get("start",0)); en=x.get("end"); sp=x.get("step")
      out.append(ScheduleRange(st,None if en is None else int(en),None if sp is None else int(sp)))
    else:
      n=int(x); out.append(ScheduleRange(n,n,1))
  return out

def _g(d,*ks):
  if not isinstance(d,dict): return None
  for k in ks:
    if k in d: return d.get(k)
  return None

def _need(v,lo,hi):
  r=_rng(v)
  return r if r else [ScheduleRange(lo,hi,1)]

def _calj(d)->ScheduleCalendarSpec:
  d=d if isinstance(d,dict) else {}
  return ScheduleCalendarSpec(
    second=_need(d.get("second"),0,59),
    minute=_need(d.get("minute"),0,59),
    hour=_need(d.get("hour"),0,23),
    day_of_week=_need(d.get("day_of_week") or d.get("dayOfWeek"),0,6),
    day_of_month=_need(d.get("day_of_month") or d.get("dayOfMonth"),1,31),
    month=_need(d.get("month"),1,12),
    year=_rng(d.get("year")),
  )

def _task_spec(tz:str,s:dict,sa:datetime|None,ea:datetime|None)->ScheduleSpec|None:
  k=(s.get("kind") or "").lower(); tz=tz or "UTC"
  if k=="cron":
    cr=s.get("cron")
    if not cr: return None
    crs=cr if isinstance(cr,list) else [cr]
    return ScheduleSpec(cron_expressions=crs,start_at=sa,end_at=ea,time_zone_name=tz)
  if k=="calendar":
    cals=[x for x in (s.get("calendars") or []) if isinstance(x,dict)]
    if not cals: return None
    return ScheduleSpec(calendars=[_calj(x) for x in cals],start_at=sa,end_at=ea,time_zone_name=tz)
  return None

async def _proc_rem(pg:asyncpg.Connection,c:Client,row)->None:
  oid,op,rid,att=row["id"],row["op"],int(row["reminder_id"]),int(row["attempts"])
  try:
    if op=="delete": await _del(c,_sid(rid))
    else: await _sync_rem(pg,c,rid)
    await pg.execute(MARK_OK,oid)
  except Exception as e:
    await pg.execute(MARK_FAIL,oid,str(e),_backoff(att))

async def _proc_task(pg:asyncpg.Connection,c:Client,row)->None:
  oid,op,tid,att=int(row["id"]),row["op"],int(row["task_id"]),int(row["attempts"])
  try:
    if op=="delete":
      await _del(c,_tsid(tid))
      return await pg.execute(TASK_MARK_OK,oid)

    t=await pg.fetchrow(TASK_FETCH_SQL,tid)
    if not t or not t["roll"] or not t["roll_spec"]:
      await _del(c,_tsid(tid))
      return await pg.execute(TASK_MARK_OK,oid)

    s=t["roll_spec"]; s=json.loads(s) if isinstance(s,str) else s
    if not isinstance(s,dict):
      await _del(c,_tsid(tid))
      return await pg.execute(TASK_MARK_OK,oid)

    k=(s.get("kind") or "").lower()
    if k=="interval":
      await _del(c,_tsid(tid))
      return await pg.execute(TASK_MARK_OK,oid)

    tz=t["roll_tz"] or "UTC"
    ea=s.get("end_at"); ea=_utc(datetime.fromisoformat(ea)) if isinstance(ea,str) and ea else None
    base=t["due_date"] or datetime.now(timezone.utc)
    now=datetime.now(timezone.utc)
    sa=max(now+timedelta(seconds=2),_utc(base)+timedelta(seconds=1))
    sa0=s.get("start_at"); sa0=_utc(datetime.fromisoformat(sa0)) if isinstance(sa0,str) and sa0 else None
    if sa0 and sa0>sa: sa=sa0

    spec=_task_spec(tz,s,sa,ea)
    if not spec:
      await _del(c,_tsid(tid))
      return await pg.execute(TASK_MARK_OK,oid)

    sid=_tsid(tid)
    sch=Schedule(
      action=ScheduleActionStartWorkflow(NOOP_WF,args=[],id=sid,task_queue=TASK_QUEUE),
      spec=spec,policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )
    await _upsert(c,sid,sch)

    if op in ("roll","sync"):
      nxt=await _next_time(c,sid)
      if nxt: await pg.execute(TASK_SET_DUE,tid,nxt)

    await pg.execute(TASK_MARK_OK,oid)
  except Exception as e:
    await pg.execute(TASK_MARK_FAIL,oid,str(e),_backoff(att))

async def run_worker()->None:
  c=await Client.connect(TEMPORAL_ADDRESS,namespace=TEMPORAL_NAMESPACE)
  from temporalio.worker import Worker
  await Worker(c,task_queue=TASK_QUEUE,workflows=[ReminderFireWorkflow,NoopWorkflow],
    activities=[fire_reminder,delete_schedule]).run()

async def run_drainer()->None:
  if not POSTGRES_URI: raise RuntimeError("POSTGRES_URI is required")
  c=await Client.connect(TEMPORAL_ADDRESS,namespace=TEMPORAL_NAMESPACE)
  pool=await asyncpg.create_pool(POSTGRES_URI,min_size=1,max_size=5)
  sem=asyncio.Semaphore(CONCURRENCY)
  loop=asyncio.get_running_loop()
  next_clean=0.0

  async def cleanup():
    async with pool.acquire() as pg:
      ids=[int(x["id"]) for x in await pg.fetch(CLEAN_SQL)]
    if not ids: return
    for rid in ids: await _del(c,_sid(rid))
    async with pool.acquire() as pg:
      await pg.execute(DISABLE_SQL,ids)

  async def one(fn,row):
    async with sem:
      async with pool.acquire() as pg:
        await fn(pg,c,row)

  try:
    while True:
      t=loop.time()
      if t>=next_clean: next_clean=t+CLEAN_EVERY; await cleanup()
      async with pool.acquire() as pg: rrows=await pg.fetch(CLAIM_SQL,BATCH_SIZE)
      async with pool.acquire() as pg: trows=await pg.fetch(TASK_CLAIM_SQL,BATCH_SIZE)
      if not rrows and not trows: await asyncio.sleep(POLL_SECONDS); continue
      await asyncio.gather(*(one(_proc_rem,r) for r in rrows),*(one(_proc_task,r) for r in trows))
  finally:
    await pool.close()

async def main()->None:
  mode=(os.getenv("MODE") or (os.sys.argv[1] if len(os.sys.argv)>1 else "")).lower()
  if mode=="worker": await run_worker()
  elif mode=="drainer": await run_drainer()
  else: raise SystemExit("usage: python reminders.py [worker|drainer]")

if __name__=="__main__":
  asyncio.run(main())
