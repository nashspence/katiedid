create extension if not exists pg_net;
drop schema if exists api cascade;
create schema api;

create table api.tasks(
  id bigint generated always as identity primary key,
  title text not null,
  description text not null default '',
  tags text[] null,
  alert_url text null,
  due_date timestamptz null,
  due_pending boolean not null default false,
  done boolean not null default false,
  trashed boolean not null default false,
  created_at timestamptz not null default now(),
  parent_id bigint null references api.tasks(id) on delete cascade,
  position int not null default 0,
  schedule jsonb null,
  last_completed_at timestamptz null,
  constraint title_nonempty check (length(btrim(title))>0),
  constraint tags_not_empty_strings check (tags is null or not (''=any(tags))),
  constraint schedule_object check (schedule is null or jsonb_typeof(schedule)='object'),
  check (position>=0),
  check (parent_id is null or parent_id<>id)
);

create index tasks_parent_position_idx on api.tasks(parent_id,position);
create unique index tasks_parent_pos_uq on api.tasks((coalesce(parent_id,0)),position);
create index tasks_tags_gin on api.tasks using gin(tags);
create index tasks_due_date_idx on api.tasks(due_date) where due_date is not null;
create index tasks_done_idx on api.tasks(done);
create index tasks_created_at_idx on api.tasks(created_at);
create index tasks_has_schedule_idx on api.tasks(id) where schedule is not null;

alter table api.tasks add column search tsvector
generated always as (to_tsvector('simple',coalesce(title,'')||' '||coalesce(description,''))) stored;
create index tasks_search_gin on api.tasks using gin(search);

create table api.task_history(
  id bigint generated always as identity primary key,
  task_id bigint not null references api.tasks(id) on delete cascade,
  change text not null check (change in ('create','update','delete')),
  old_values jsonb null,
  new_values jsonb null,
  created_at timestamptz not null default now()
);
create index task_history_task_idx on api.task_history(task_id);

create or replace function api.append_task(
  title text,description text default '',tags text[] default null,alert_url text default null,
  due_date timestamptz default null,done boolean default false,parent_id bigint default null
) returns api.tasks language plpgsql as $$
declare p bigint:=coalesce(parent_id,0); pos int; r api.tasks;
begin
  perform pg_advisory_xact_lock(p);
  select coalesce(max(t.position),-1)+1 into pos
  from api.tasks t
  where t.parent_id is not distinct from append_task.parent_id and t.position<1000000;
  insert into api.tasks(title,description,tags,alert_url,due_date,done,parent_id,position)
  values(append_task.title,append_task.description,append_task.tags,append_task.alert_url,append_task.due_date,append_task.done,append_task.parent_id,pos)
  returning * into r;
  return r;
end $$;

create or replace function api.move_task(task_id bigint,new_parent_id bigint default null,new_position int default 2147483647)
returns api.tasks language plpgsql as $$
declare
  bump constant int:=1000000;
  old_parent bigint; old_pos int;
  target_parent bigint:=new_parent_id;
  maxpos int; pos int:=new_position;
  lock_a bigint; lock_b bigint;
  r api.tasks;
begin
  select t.parent_id,t.position into old_parent,old_pos from api.tasks t where t.id=task_id for update;
  lock_a:=coalesce(old_parent,0); lock_b:=coalesce(target_parent,0);
  if lock_a<=lock_b then
    perform pg_advisory_xact_lock(lock_a);
    if lock_b<>lock_a then perform pg_advisory_xact_lock(lock_b); end if;
  else
    perform pg_advisory_xact_lock(lock_b); perform pg_advisory_xact_lock(lock_a);
  end if;

  select coalesce(max(t.position),-1) into maxpos from api.tasks t
  where t.parent_id is not distinct from target_parent and t.id<>task_id and t.position<bump;

  if pos<0 then pos:=0; end if;
  if pos>maxpos+1 then pos:=maxpos+1; end if;
  if old_parent is not distinct from target_parent and pos>old_pos then pos:=pos-1; end if;

  update api.tasks set position=bump*10+task_id where id=task_id;

  update api.tasks set position=position+bump where parent_id is not distinct from old_parent and position>old_pos and position<bump;
  update api.tasks set position=position-(bump+1) where parent_id is not distinct from old_parent and position>=bump and position<bump*5;

  update api.tasks set position=position+bump where parent_id is not distinct from target_parent and position>=pos and position<bump;
  update api.tasks set position=position-(bump-1) where parent_id is not distinct from target_parent and position>=bump and position<bump*5;

  update api.tasks set parent_id=target_parent,position=pos where id=task_id returning * into r;
  return r;
end $$;

create or replace function api.move_before(task_id bigint,before_id bigint) returns api.tasks language sql as $$
  select api.move_task(task_id,t.parent_id,t.position) from api.tasks t where t.id=before_id;
$$;
create or replace function api.move_after(task_id bigint,after_id bigint) returns api.tasks language sql as $$
  select api.move_task(task_id,t.parent_id,t.position+1) from api.tasks t where t.id=after_id;
$$;
create or replace function api.move_into(task_id bigint,new_parent_id bigint) returns api.tasks language sql as $$
  select api.move_task(task_id,new_parent_id,2147483647);
$$;

create or replace function api.set_order(parent_id bigint,ids bigint[]) returns void language plpgsql as $$
declare bump constant int:=1000000; p bigint:=coalesce(parent_id,0);
begin
  perform pg_advisory_xact_lock(p);
  update api.tasks set position=bump*10+id where api.tasks.id=any(ids) and api.tasks.parent_id is not distinct from parent_id;
  update api.tasks t set position=u.ord-1
  from unnest(ids) with ordinality as u(id,ord)
  where t.id=u.id and t.parent_id is not distinct from parent_id;
end $$;

create table api.webhook_targets(
  tag text not null,
  url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(tag,url),
  check(length(btrim(tag))>0),
  check(length(btrim(url))>0)
);
create index webhook_targets_tag_enabled_idx on api.webhook_targets(tag) where enabled;

create or replace function api.list_alert_tags(
  _search text default '',
  _page int default 1,
  _page_size int default 25
) returns table(tag text,url_count bigint,enabled_count bigint,latest timestamptz)
language sql stable as $$
  select t.tag,count(*) url_count,count(*) filter(where t.enabled) enabled_count,max(t.created_at) latest
  from api.webhook_targets t
  where coalesce(_search,'')='' or t.tag ilike ('%'||_search||'%')
  group by t.tag
  order by t.tag asc
  offset (greatest(_page,1)-1)*greatest(_page_size,1)
  limit greatest(_page_size,1)+1;
$$;

create or replace function api._webhook_notify(
  tag text,
  title text,
  body text,
  type text default 'info',
  _url text default null
) returns void language plpgsql as $$
begin
  perform net.http_post(
    url:=u,
    body:=jsonb_build_object('version','1.0','title',title,'message',body,'attachments','[]'::jsonb,'type',type)
      || case when _url is null or length(btrim(_url))=0 then '{}'::jsonb else jsonb_build_object('url',_url) end
  )
  from api.webhook_targets t
  cross join lateral unnest(array[t.url]) u
  where t.tag=_webhook_notify.tag and t.enabled;
end $$;

create or replace function api.tg_tasks_webhook() returns trigger language plpgsql as $$
declare o jsonb:='{}'; n jsonb:='{}'; ch text:='update';
begin
  if tg_op='INSERT' then
    insert into api.task_history(task_id,change,new_values)
    values(new.id,'create',jsonb_build_object('title',new.title,'description',new.description,'tags',new.tags,'alert_url',new.alert_url,'due_date',new.due_date,'done',new.done,'trashed',new.trashed));
    return new;
  end if;
  if tg_op='DELETE' then
    insert into api.task_history(task_id,change,old_values)
    values(old.id,'delete',jsonb_build_object('title',old.title,'description',old.description,'tags',old.tags,'alert_url',old.alert_url,'due_date',old.due_date,'done',old.done,'trashed',old.trashed));
    return old;
  end if;
  if (new.title is distinct from old.title) or (new.description is distinct from old.description) then
    o:=o||jsonb_build_object('title',old.title,'description',old.description);
    n:=n||jsonb_build_object('title',new.title,'description',new.description);
  end if;
  if (new.tags is distinct from old.tags) or (new.alert_url is distinct from old.alert_url) then
    o:=o||jsonb_build_object('tags',old.tags,'alert_url',old.alert_url);
    n:=n||jsonb_build_object('tags',new.tags,'alert_url',new.alert_url);
  end if;
  if new.due_date is distinct from old.due_date then
    o:=o||jsonb_build_object('due_date',old.due_date);
    n:=n||jsonb_build_object('due_date',new.due_date);
  end if;
  if new.done is distinct from old.done then
    o:=o||jsonb_build_object('done',old.done);
    n:=n||jsonb_build_object('done',new.done);
  end if;
  if new.trashed is distinct from old.trashed then
    o:=o||jsonb_build_object('trashed',old.trashed);
    n:=n||jsonb_build_object('trashed',new.trashed);
    if new.trashed and not old.trashed then ch:='delete'; end if;
  end if;
  if n='{}'::jsonb then return new; end if;
  insert into api.task_history(task_id,change,old_values,new_values)
  values(new.id,ch,o,n);
  return new;
end $$;

drop trigger if exists t_tasks_webhook on api.tasks;
create trigger t_tasks_webhook after insert or update or delete on api.tasks
for each row execute function api.tg_tasks_webhook();

create or replace function api.tg_task_history_alerts() returns trigger language plpgsql as $$
declare
  o jsonb:=coalesce(new.old_values,'{}');
  n jsonb:=coalesce(new.new_values,'{}');
  base api.tasks;
  t text;
  tags_old text[]:=array(select jsonb_array_elements_text(coalesce(o->'tags','[]'::jsonb)));
  tags_new text[]:=array(select jsonb_array_elements_text(coalesce(n->'tags','[]'::jsonb)));
  due_changed boolean:=(n ? 'due_date') or (o ? 'due_date');
  done_changed boolean:=(n ? 'done') or (o ? 'done');
  trashed_changed boolean:=(n ? 'trashed') or (o ? 'trashed');
  content_changed boolean:=(n ? 'title') or (n ? 'description');
  title text;
  url text;
begin
  select * into base from api.tasks where id=new.task_id;
  if array_length(tags_new,1) is null then tags_new:=coalesce(base.tags,'{}'::text[]); end if;
  if array_length(tags_old,1) is null then tags_old:=coalesce(tags_new,coalesce(base.tags,'{}'::text[])); end if;
  title:=coalesce(n->>'title',o->>'title',base.title,format('Task #%s',new.task_id));
  url:=coalesce(n->>'alert_url',o->>'alert_url',base.alert_url,format('/?page=task&id=%s',new.task_id));
  if new.change='create' then
    foreach t in array tags_new loop perform api._webhook_notify(t,format('[%s] task created',t),title,'info',url); end loop; return new;
  end if;
  if new.change='delete' then
    foreach t in array tags_old loop perform api._webhook_notify(t,format('[%s] task deleted',t),title,'warning',url); end loop; return new;
  end if;
  for t in select distinct x from unnest(coalesce(tags_old,'{}'::text[])||coalesce(tags_new,'{}'::text[])) as u(x) loop
    if (t=any(tags_new)) and not (t=any(tags_old)) then
      perform api._webhook_notify(t,format('[%s] task added to tag',t),title,'info',url);
    elsif (t=any(tags_old)) and not (t=any(tags_new)) then
      perform api._webhook_notify(t,format('[%s] task removed from tag',t),title,'warning',url);
    elsif (t=any(tags_new)) and (due_changed or done_changed or content_changed or trashed_changed) then
      perform api._webhook_notify(
        t,format('[%s] task updated',t),
        format('%s%s%s%s',
          title,
          case when content_changed then E'\nTitle/description updated' else '' end,
          case when due_changed then format(E'\nDue date: %s → %s',coalesce(o->>'due_date','(none)'),coalesce(n->>'due_date','(none)')) else '' end,
          case when done_changed then format(E'\nDone: %s → %s',coalesce(o->>'done',''),coalesce(n->>'done','')) else '' end
          || case when trashed_changed then format(E'\nTrashed: %s → %s',coalesce(o->>'trashed',''),coalesce(n->>'trashed','')) else '' end
        ),'info',url
      );
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists t_task_history_alerts on api.task_history;
create trigger t_task_history_alerts after insert on api.task_history
for each row execute function api.tg_task_history_alerts();

create table api.reminders(
  id bigint generated always as identity primary key,
  enabled boolean not null default true,
  schedule jsonb null,
  tag text not null,
  title text not null default '',
  body text not null default '',
  url text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(length(btrim(tag))>0),
  check(schedule is null or jsonb_typeof(schedule)='object')
);
create index reminders_enabled_idx on api.reminders(enabled) where enabled;

create or replace function api.tg_reminders_touch() returns trigger language plpgsql as $$
begin new.updated_at:=now(); return new; end $$;
drop trigger if exists t_reminders_touch on api.reminders;
create trigger t_reminders_touch before update on api.reminders for each row execute function api.tg_reminders_touch();

create table api.temporal_outbox(
  id bigint generated always as identity primary key,
  op text not null check (op in ('sync','delete')),
  sid text not null,
  schedule jsonb null,
  available_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text null,
  processed_at timestamptz null
);
create index temporal_outbox_ready_idx on api.temporal_outbox(available_at,id) where processed_at is null;
revoke all on api.temporal_outbox from public;

create table api.temporal_inbox(
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('fire_reminder','set_task_due','gc_exhausted','clear_task_schedule')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz null
);
create index temporal_inbox_unprocessed_idx on api.temporal_inbox(id) where processed_at is null;
revoke all on api.temporal_inbox from public;

create or replace function api._temporal_outbox(_op text,_sid text,_schedule jsonb default null) returns void
language sql security definer set search_path=api,public as $$
  insert into api.temporal_outbox(op,sid,schedule) values($1,$2,$3);
$$;
alter function api._temporal_outbox(text,text,jsonb) owner to postgres;

create or replace function api._is_interval_only(s jsonb) returns boolean
language sql immutable as $$
  select s is not null
     and coalesce(jsonb_array_length(s->'intervals'),0)>0
     and coalesce(jsonb_array_length(s->'cron_expressions'),0)=0
     and coalesce(jsonb_array_length(s->'calendars'),0)=0;
$$;

create or replace function api.tg_tasks_temporal_complete() returns trigger language plpgsql as $$
declare ev int;
begin
  if (not old.done) and new.done and new.schedule is not null then
    new.done:=false;
    new.last_completed_at:=now();

    if api._is_interval_only(new.schedule) then
      ev:=coalesce((new.schedule#>>'{intervals,0,every_seconds}')::int,0);
      new.due_date:=coalesce(old.due_date,now()) + (greatest(ev,1)*interval '1 second');
      new.due_pending:=false;
    else
      new.due_pending:=true;
      new.due_date:=null;
      new.schedule := jsonb_set(
        new.schedule,
        '{start_at}',
        to_jsonb(date_trunc('second', coalesce(old.due_date, now())) + interval '1 second'),
        true
      );
    end if;
  end if;
  return new;
end $$;

drop trigger if exists t_tasks_temporal_complete on api.tasks;
create trigger t_tasks_temporal_complete before update on api.tasks
for each row execute function api.tg_tasks_temporal_complete();

create or replace function api.tg_tasks_temporal() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    perform api._temporal_outbox('delete','taskroll-'||old.id,null);
    return old;
  end if;

  if tg_op='INSERT' then
    if new.schedule is not null and not api._is_interval_only(new.schedule) then
      perform api._temporal_outbox('sync','taskroll-'||new.id,new.schedule);
    else
      perform api._temporal_outbox('delete','taskroll-'||new.id,null);
    end if;
    return new;
  end if;

  -- UPDATE
  if new.schedule is null or api._is_interval_only(new.schedule) then
    perform api._temporal_outbox('delete','taskroll-'||new.id,null);

  elsif (new.schedule is distinct from old.schedule)
        or ((not old.due_pending) and new.due_pending) then
    perform api._temporal_outbox('sync','taskroll-'||new.id,new.schedule);
  end if;

  return new;
end $$;


drop trigger if exists t_tasks_temporal on api.tasks;
create trigger t_tasks_temporal after insert or update or delete on api.tasks
for each row execute function api.tg_tasks_temporal();

create or replace function api.tg_reminders_temporal() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    perform api._temporal_outbox('delete','reminder-'||old.id,null);
    return old;
  end if;
  if new.enabled and new.schedule is not null then
    perform api._temporal_outbox('sync','reminder-'||new.id,new.schedule);
  else
    perform api._temporal_outbox('delete','reminder-'||new.id,null);
  end if;
  return new;
end $$;
drop trigger if exists t_reminders_temporal on api.reminders;
create trigger t_reminders_temporal after insert or update or delete on api.reminders
for each row execute function api.tg_reminders_temporal();

create or replace function api.fire_reminder(_reminder_id bigint) returns void language plpgsql as $$
declare r api.reminders;
begin
  select * into r from api.reminders where id=_reminder_id;
  if not found or not r.enabled then return; end if;
  perform api._webhook_notify(r.tag,coalesce(nullif(r.title,''),'Reminder'),r.body,'info',r.url);
end $$;

create or replace function api.tg_temporal_inbox_process() returns trigger language plpgsql as $$
declare rid bigint; tid bigint; dd timestamptz;
begin
  if new.kind='fire_reminder' then
    rid:=(new.payload->>'reminder_id')::bigint;
    if rid is not null then perform api.fire_reminder(rid); end if;
  elsif new.kind='set_task_due' then
    tid:=(new.payload->>'task_id')::bigint;
    dd:=(new.payload->>'due_date')::timestamptz;
    if tid is not null then update api.tasks set due_date=dd,due_pending=false where id=tid; end if;
  elsif new.kind='gc_exhausted' then
    rid:=(new.payload->>'reminder_id')::bigint;
    if rid is not null then delete from api.reminders where id=rid; end if;
  elsif new.kind='clear_task_schedule' then
    tid:=(new.payload->>'task_id')::bigint;
    if tid is not null then update api.tasks set schedule=null where id=tid; end if;
  end if;
  update api.temporal_inbox set processed_at=now() where id=new.id;
  return new;
end $$;
drop trigger if exists t_temporal_inbox_process on api.temporal_inbox;
create trigger t_temporal_inbox_process after insert on api.temporal_inbox
for each row execute function api.tg_temporal_inbox_process();

grant usage on schema api to anon;
grant select,insert,update,delete on all tables in schema api to anon;
grant usage,select on all sequences in schema api to anon;
grant execute on all functions in schema api to anon;
