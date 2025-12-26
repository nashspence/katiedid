create extension if not exists pg_net;

create schema if not exists api;

create table if not exists api.app_config (
  key text primary key,
  value text not null
);

insert into api.app_config(key, value)
values ('notifications_endpoint', '${notifications_endpoint}')
on conflict (key) do update set value = excluded.value;

create table if not exists api.tasks (
  id          bigint generated always as identity primary key,
  title       text not null,
  description text not null default '',
  tags        text[] null,
  due_date    timestamptz null,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  parent_id   bigint null references api.tasks(id) on delete cascade,
  position    int not null default 0,
  constraint title_nonempty check (length(btrim(title)) > 0),
  constraint tags_not_empty_strings check (tags is null or not ('' = any(tags))),
  check (position >= 0),
  check (parent_id is null or parent_id <> id)
);

create index if not exists tasks_parent_position_idx on api.tasks (parent_id, position);
create unique index if not exists tasks_parent_pos_uq on api.tasks ((coalesce(parent_id, 0)), position);
create index if not exists tasks_tags_gin on api.tasks using gin (tags);
create index if not exists tasks_due_date_idx on api.tasks (due_date) where due_date is not null;
create index if not exists tasks_done_idx on api.tasks (done);
create index if not exists tasks_created_at_idx on api.tasks (created_at);

alter table api.tasks
  add column if not exists search tsvector
  generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))
  ) stored;
create index if not exists tasks_search_gin on api.tasks using gin (search);

create or replace function api.append_task(
  title text, description text default '', tags text[] default null,
  due_date timestamptz default null, done boolean default false, parent_id bigint default null
) returns api.tasks language plpgsql as $$
declare p bigint := coalesce(parent_id, 0); pos int; r api.tasks;
begin
  perform pg_advisory_xact_lock(p);
  select coalesce(max(t.position), -1) + 1 into pos
    from api.tasks t
   where t.parent_id is not distinct from append_task.parent_id
     and t.position < 1000000;
  insert into api.tasks(title, description, tags, due_date, done, parent_id, position)
  values (append_task.title, append_task.description, append_task.tags,
          append_task.due_date, append_task.done, append_task.parent_id, pos)
  returning * into r;
  return r;
end $$;

create or replace function api.move_task(
  task_id bigint, new_parent_id bigint default null, new_position int default 2147483647
) returns api.tasks language plpgsql as $$
declare
  bump constant int := 1000000;
  old_parent bigint; old_pos int;
  target_parent bigint := new_parent_id;
  maxpos int; pos int := new_position;
  lock_a bigint; lock_b bigint;
  r api.tasks;
begin
  select t.parent_id, t.position into old_parent, old_pos
    from api.tasks t where t.id = task_id for update;

  lock_a := coalesce(old_parent, 0); lock_b := coalesce(target_parent, 0);
  if lock_a <= lock_b then
    perform pg_advisory_xact_lock(lock_a);
    if lock_b <> lock_a then perform pg_advisory_xact_lock(lock_b); end if;
  else
    perform pg_advisory_xact_lock(lock_b);
    perform pg_advisory_xact_lock(lock_a);
  end if;

  select coalesce(max(t.position), -1) into maxpos
    from api.tasks t
   where t.parent_id is not distinct from target_parent
     and t.id <> task_id and t.position < bump;

  if pos < 0 then pos := 0; end if;
  if pos > maxpos + 1 then pos := maxpos + 1; end if;
  if old_parent is not distinct from target_parent and pos > old_pos then pos := pos - 1; end if;

  update api.tasks set position = bump * 10 + task_id where id = task_id;

  update api.tasks set position = position + bump
   where parent_id is not distinct from old_parent and position > old_pos and position < bump;
  update api.tasks set position = position - (bump + 1)
   where parent_id is not distinct from old_parent and position >= bump and position < bump * 5;

  update api.tasks set position = position + bump
   where parent_id is not distinct from target_parent and position >= pos and position < bump;
  update api.tasks set position = position - (bump - 1)
   where parent_id is not distinct from target_parent and position >= bump and position < bump * 5;

  update api.tasks set parent_id = target_parent, position = pos
   where id = task_id returning * into r;
  return r;
end $$;

create or replace function api.move_before(task_id bigint, before_id bigint)
returns api.tasks language sql as $$
  select api.move_task(task_id, t.parent_id, t.position) from api.tasks t where t.id = before_id;
$$;

create or replace function api.move_after(task_id bigint, after_id bigint)
returns api.tasks language sql as $$
  select api.move_task(task_id, t.parent_id, t.position + 1) from api.tasks t where t.id = after_id;
$$;

create or replace function api.move_into(task_id bigint, new_parent_id bigint)
returns api.tasks language sql as $$
  select api.move_task(task_id, new_parent_id, 2147483647);
$$;

create or replace function api.set_order(parent_id bigint, ids bigint[])
returns void language plpgsql as $$
declare bump constant int := 1000000; p bigint := coalesce(parent_id, 0);
begin
  perform pg_advisory_xact_lock(p);
  update api.tasks set position = bump * 10 + id
   where api.tasks.id = any(ids) and api.tasks.parent_id is not distinct from parent_id;
  update api.tasks t set position = u.ord - 1
    from unnest(ids) with ordinality as u(id, ord)
   where t.id = u.id and t.parent_id is not distinct from parent_id;
end $$;

-- CRUD via PostgREST for any tag (even unused)
create table if not exists api.apprise_targets (
  tag text not null,
  url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tag, url),
  check (length(btrim(tag)) > 0),
  check (length(btrim(url)) > 0)
);
create index if not exists apprise_targets_tag_enabled_idx on api.apprise_targets (tag) where enabled;

create or replace function api._apprise_notify(tag text, title text, body text, type text default 'info')
returns bigint language plpgsql as $$
declare urls text;
declare endpoint text := coalesce((select value from api.app_config where key='notifications_endpoint'), 'http://notifications:8000/notify/');
begin
  select string_agg(t.url, ' ') into urls
    from api.apprise_targets t
   where t.tag = _apprise_notify.tag and t.enabled;
  if urls is null then return null; end if;

  return net.http_post(
    url  := endpoint,
    body := jsonb_build_object('urls', urls, 'title', title, 'body', body, 'type', type)
  );
end $$;

create or replace function api.tg_tasks_apprise()
returns trigger language plpgsql as $$
declare
  new_tags text[] := coalesce(new.tags, '{}'::text[]);
  old_tags text[] := coalesce(old.tags, '{}'::text[]);
  t text;
  due_changed boolean;
  done_changed boolean;
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    foreach t in array new_tags loop
      perform api._apprise_notify(t, format('[%s] task created', t), format('%s', new.title));
    end loop;
    return new;
  end if;

  if tg_op = 'DELETE' then
    foreach t in array old_tags loop
      perform api._apprise_notify(t, format('[%s] task deleted', t), format('%s', old.title), 'warning');
    end loop;
    return old;
  end if;

  due_changed := new.due_date is distinct from old.due_date;
  done_changed := new.done is distinct from old.done;
  content_changed := (new.title is distinct from old.title) or (new.description is distinct from old.description);

  for t in select distinct x from unnest(old_tags || new_tags) as u(x) loop
    if (t = any(new_tags)) and not (t = any(old_tags)) then
      perform api._apprise_notify(t, format('[%s] task added to tag', t), format('%s', new.title));
    elsif (t = any(old_tags)) and not (t = any(new_tags)) then
      perform api._apprise_notify(t, format('[%s] task removed from tag', t), format('%s', old.title), 'warning');
    elsif (t = any(new_tags)) and (due_changed or done_changed or content_changed) then
      perform api._apprise_notify(
        t,
        format('[%s] task updated', t),
        format(
          '%s%s%s%s',
          new.title,
          case when content_changed then E'\nTitle/description updated' else '' end,
          case when due_changed then format(E'\nDue date: %s → %s', coalesce(old.due_date::text,'(none)'), coalesce(new.due_date::text,'(none)')) else '' end,
          case when done_changed then format(E'\nDone: %s → %s', old.done, new.done) else '' end
        )
      );
    end if;
  end loop;

  return new;
end $$;

drop trigger if exists t_tasks_apprise on api.tasks;
create trigger t_tasks_apprise
after insert or update or delete on api.tasks
for each row execute function api.tg_tasks_apprise();

grant usage on schema api to anon;
grant select, insert, update, delete on all tables in schema api to anon;
grant usage, select on all sequences in schema api to anon;
grant execute on all functions in schema api to anon;
