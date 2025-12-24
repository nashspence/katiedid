import xs from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import {run} from '@cycle/run';
import {withState} from '@cycle/state';
import {
  makeDOMDriver, h, div, h1, a, form, label, input, textarea,
  button, select, option, span
} from '@cycle/dom';
import {makeHTTPDriver} from '@cycle/http';
import {makeHistoryDriver} from '@cycle/history';
import humanInterval from '@lesjoursfr/human-interval';
import {DateTime} from 'luxon';

const API = `${location.origin}/api`;
const REMINDERS_API = `${location.origin}/reminders`;
const J = {'Content-Type': 'application/json', 'Prefer': 'return=representation'};
const MAXPOS = 2147483647;

const DEFAULT_COLS = ['done','title','due','tags'];

const num = v => (v == null || v === '' || v === 'null') ? null : Number(v);
const int = (v, d) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const qnorm = s => (s || '').toLowerCase().trim();
const tagsFrom = s => qnorm(s).split(/[,\s]+/).filter(Boolean);

const parseCols = s => {
  const raw = (s == null || s === '') ? null : String(s);
  const cols = raw ? raw.split(',').map(qnorm).filter(Boolean) : DEFAULT_COLS.slice();
  return {cols, raw: raw || ''};
};

const parseRoute = search => {
  const qs = new URLSearchParams(search || '');
  const page = qs.get('page') || 'home';               // home | task | new | edit | move | alerts | alert | reminder
  const id = num(qs.get('id'));
  const parent = num(qs.get('parent'));
  const atag = (qs.get('atag') || '').trim();          // alert tag detail
  const q = qs.get('q') || '';
  const tags = qs.get('tags') || '';
  const showDone = (qs.get('done') || '0') === '1';
  const sort = qs.get('sort') || 'position';
  const dir = (qs.get('dir') || 'asc') === 'desc' ? 'desc' : 'asc';
  const reorder = (qs.get('reorder') || '0') === '1';
  const limit = Math.max(1, Math.min(200, int(qs.get('limit'), 25)));
  const p = Math.max(1, int(qs.get('p'), 1));
  const {cols, raw: colsRaw} = parseCols(qs.get('cols'));
  return {page, id, parent, atag, q, tags, showDone, sort, dir, reorder, limit, p, cols, colsRaw, _qs: qs};
};

const href = (r, patch = {}) => {
  const qs = new URLSearchParams(r._qs.toString());
  Object.keys(patch).forEach(k => {
    const v = patch[k];
    if (v == null || v === '' || v === 'null') qs.delete(k);
    else qs.set(k, String(v));
  });
  return `?${qs.toString()}`;
};

const loc = (search, type = 'push') => ({type, pathname: location.pathname, search});

const initialState = {
  route: parseRoute(location.search),
  task: null,
  list: [],
  reminders: [],
  hasMore: false,
  form: {title:'', description:'', tags:'', due_date:''},
  reminderForm: {text:''},
  moveParent: '',
  alerts: [],          // raw rows {tag,url,enabled,created_at}
  alertUrls: [],       // rows for one tag
  anew: {tag:'', url:''},
  aaddUrl: '',
};

const base = s => (s === undefined ? initialState : s);

const toDateTime = v => {
  if (v == null || v === '') return null;
  if (DateTime.isDateTime(v)) return v.isValid ? v : null;
  if (v instanceof Date) return DateTime.fromJSDate(v);
  const raw = String(v);
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw);
  const iso = DateTime.fromISO(raw, {setZone: hasZone});
  if (iso.isValid) return hasZone ? iso : iso.setZone('local', {keepLocalTime: true});
  const local = DateTime.fromISO(raw, {zone: 'local'});
  return local.isValid ? local : null;
};
const dueFmt = s => {
  const dt = toDateTime(s);
  return dt ? dt.toLocal().toLocaleString(DateTime.DATETIME_MED) : (s || '');
};
const createdFmt = s => {
  const dt = toDateTime(s);
  return dt ? dt.toLocal().toLocaleString(DateTime.DATETIME_MED) : (s || '');
};
const toLocalInput = s => {
  const dt = toDateTime(s);
  return dt ? dt.toLocal().toFormat("yyyy-LL-dd'T'HH:mm") : '';
};
const toZonedISOString = v => {
  const dt = toDateTime(v);
  return dt ? dt.toISO({suppressMilliseconds: true}) : null;
};
const reminderAttrs = r => (r && r.search_attributes) ? r.search_attributes : {};
const reminderPick = (r, k) => {
  const v = reminderAttrs(r)[k];
  return Array.isArray(v) ? v[0] : v;
};
const reminderArr = (r, k) => {
  const v = reminderAttrs(r)[k];
  if (Array.isArray(v)) return v.filter(x => x != null).map(x => String(x));
  return v != null ? [String(v)] : null;
};
const reminderCalendar = dt => ({
  year:[{start: dt.year}],
  month:[{start: dt.month}],
  day_of_month:[{start: dt.day}],
  hour:[{start: dt.hour}],
  minute:[{start: dt.minute}],
  second:[{start: Math.floor(dt.second)}],
});
const reminderFireTime = (due, text) => {
  const ms = text ? humanInterval(text) : null;
  const dt = toDateTime(due);
  if (!dt || !dt.isValid || !ms || !Number.isFinite(ms)) return null;
  return dt.minus({milliseconds: ms});
};
const reminderSpec = fire => {
  const start_at = toZonedISOString(fire);
  return start_at ? {
    calendars:[reminderCalendar(fire)],
    time_zone_name: fire.zoneName || DateTime.local().zoneName,
    start_at,
  } : null;
};

function intent(sources) {
  const DOM = sources.DOM;
  const ev = (sel, type, opts) => DOM.select(sel).events(type, opts || {});
  const attr = (e, k) => e.currentTarget && e.currentTarget.getAttribute(k);

  const nav$ = ev('a.nav', 'click', {preventDefault: true}).map(e => attr(e, 'href')).filter(Boolean);

  const routePatch$ = xs.merge(
    ev('input.q', 'input').map(e => ({q: e.target.value, p: '1'})),
    ev('input.tags', 'input').map(e => ({tags: e.target.value, p: '1'})),
    ev('input.done', 'change').map(e => ({done: e.target.checked ? '1' : '0', p: '1'})),
    ev('select.sort', 'change').map(e => ({sort: e.target.value, p: '1'})),
    ev('select.dir', 'change').map(e => ({dir: e.target.value, p: '1'})),
    ev('input.reorder', 'change').map(e => ({reorder: e.target.checked ? '1' : '0'})),
    ev('select.limit', 'change').map(e => ({limit: e.target.value, p: '1'})),
    ev('input.col', 'change').map(e => ({cols: e.target.dataset.cols, p: '1'})),
  );

  const toggleDone$ = ev('.toggle', 'change')
    .map(e => ({id: Number(e.target.dataset.id), done: e.target.checked}));

  const moveUp$ = ev('button.up', 'click', {preventDefault: true})
    .map(e => ({
      task_id: Number(e.currentTarget.dataset.id),
      new_parent_id: num(e.currentTarget.dataset.parent),
      new_position: (Number(e.currentTarget.dataset.pos) | 0) - 1
    }))
    .filter(x => x.task_id != null);

  const moveDown$ = ev('button.down', 'click', {preventDefault: true})
    .map(e => ({
      task_id: Number(e.currentTarget.dataset.id),
      new_parent_id: num(e.currentTarget.dataset.parent),
      new_position: (Number(e.currentTarget.dataset.pos) | 0) + 2
    }))
    .filter(x => x.task_id != null);

  const dragstart$ = ev('.row', 'dragstart');
  const dragend$ = ev('.row', 'dragend').mapTo(null);

  const draggedId$ = xs.merge(
    dragstart$.map(e => Number(e.currentTarget.dataset.id)),
    dragend$
  ).startWith(null).remember();

  const dragover$ = xs.merge(
    ev('.row', 'dragover', {preventDefault: true}),
    ev('.up-drop', 'dragover', {preventDefault: true}),
  ).mapTo(null);

  const drop = sel => ev(sel, 'drop', {preventDefault: true});

  const dropInto$ = drop('.row').compose(sampleCombine(draggedId$))
    .map(([e, id]) => ({task_id: id, new_parent_id: Number(e.currentTarget.dataset.id)}))
    .filter(x => x.task_id != null && x.task_id !== x.new_parent_id);

  const dropUp$ = drop('.up-drop')
    .map(e => { if (e.stopPropagation) e.stopPropagation(); return e; })
    .compose(sampleCombine(draggedId$))
    .map(([e, id]) => ({
      task_id: id,
      new_parent_id: num(e.currentTarget.dataset.parent),
      new_position: MAXPOS
    }))
    .filter(x => x.task_id != null);

  const formInput = (sel, key) => ev(sel, 'input').map(e => s => ({...s, [key]: e.target.value}));
  const formReducer$ = xs.merge(
    formInput('input.ftitle', 'title'),
    formInput('textarea.fdesc', 'description'),
    formInput('input.ftags', 'tags'),
    formInput('input.fdue', 'due_date'),
  );

  const reminderFormReducer$ = ev('input.rtext', 'input')
    .map(e => prev => ({...prev, text: e.target.value}));

  const reminderSubmit$ = ev('form.reminder-form', 'submit', {preventDefault: true}).mapTo(true);

  const submitKind$ = xs.merge(
    ev('form.task-form', 'submit', {preventDefault: true}).mapTo('task'),
    ev('form.move-form', 'submit', {preventDefault: true}).mapTo('move'),
  );

  const del$ = ev('button.delete', 'click', {preventDefault: true}).mapTo(true);
  const moveParent$ = ev('input.mparent', 'input').map(e => e.target.value);

  // alerts
  const anewReducer$ = xs.merge(
    formInput('input.anew-tag', 'tag'),
    formInput('input.anew-url', 'url'),
  );
  const aaddUrl$ = ev('input.aadd-url', 'input').map(e => e.target.value);
  const acreate$ = xs.merge(
    ev('form.anew', 'submit', {preventDefault: true}).mapTo('new'),
    ev('form.aadd', 'submit', {preventDefault: true}).mapTo('add'),
  );
  const atoggle$ = ev('.atoggle', 'change')
    .map(e => ({tag: e.target.dataset.tag, url: e.target.dataset.url, enabled: e.target.checked}));
  const adel$ = ev('button.adel', 'click', {preventDefault: true})
    .map(e => ({tag: e.currentTarget.dataset.tag, url: e.currentTarget.dataset.url}));
  const adelTag$ = ev('button.adelTag', 'click', {preventDefault: true})
    .map(e => ({tag: e.currentTarget.dataset.tag}));

  return {
    nav$, routePatch$, toggleDone$, moveUp$, moveDown$,
    dragstart$, dragover$, dropInto$, dropUp$,
    formReducer$, submitKind$, del$, moveParent$,
    anewReducer$, aaddUrl$, acreate$, atoggle$, adel$, adelTag$,
    reminderFormReducer$, reminderSubmit$,
  };
}

function model(sources, actions) {
  const sel = 'id,title,description,tags,due_date,done,created_at,parent_id,position';
  const asArray = body => Array.isArray(body) ? body : [];
  const asOne = body => Array.isArray(body) ? (body[0] || null) : null;

  const selectBody = (cat, mapBody) =>
    sources.HTTP.select(cat).flatten().map(res => mapBody(res.body));

  const setKey = (k, v) => prev => ({...base(prev), [k]: v});
  const patchState = patch => prev => ({...base(prev), ...patch});

  const route$ = sources.History
    .startWith({search: location.search})
    .map(l => parseRoute(l.search))
    .remember();

  const state$ = sources.state.stream.remember();

  const orderFor = r => {
    const col = {position:'position', due:'due_date', created:'created_at', title:'title'}[r.sort] || 'position';
    const nul = col === 'due_date' ? '.nullslast' : '';
    return `${col}.${r.dir}${nul}`;
  };

  const remindersUrl = id => `${REMINDERS_API}/reminders?entity_type=task&entity_id=${id}&sort=next`;

  const listUrl = (r, parentId) => {
    const qs = new URLSearchParams();
    qs.set('select', sel);
    qs.set('order', orderFor(r));
    qs.set('limit', String(r.limit + 1));
    qs.set('offset', String((r.p - 1) * r.limit));
    if (parentId == null) qs.set('parent_id', 'is.null');
    else qs.set('parent_id', `eq.${parentId}`);
    if (!r.showDone) qs.set('done', 'eq.false');
    const ts = tagsFrom(r.tags);
    if (ts.length) qs.set('tags', `ov.{${ts.join(',')}}`);
    const q = qnorm(r.q);
    if (q) qs.set('or', `(title.ilike.*${q}*,description.ilike.*${q}*)`);
    return `${API}/tasks?${qs.toString()}`;
  };

  const alertsSel = 'tag,url,enabled,created_at';
  const alertsAllUrl = () =>
    `${API}/apprise_targets?select=${alertsSel}&order=tag.asc,url.asc&limit=1000`;
  const alertsTagUrl = tag =>
    `${API}/apprise_targets?select=${alertsSel}&tag=eq.${encodeURIComponent(tag)}&order=url.asc`;
  const targetsForTags = (tags, rows) => {
    const set = new Set();
    if (Array.isArray(tags) && Array.isArray(rows)) {
      rows.forEach(x => {
        if (x && x.enabled && tags.includes(x.tag)) set.add(x.url);
      });
    }
    return Array.from(set);
  };
  const targetsMap = rows => {
    const map = new Map();
    (rows || []).forEach(x => {
      if (!x || !x.tag) return;
      if (!map.has(x.tag)) map.set(x.tag, []);
      if (x.enabled) map.get(x.tag).push(x.url);
    });
    map.forEach((urls, tag) => map.set(tag, Array.from(new Set(urls)).sort()));
    return map;
  };
  const changedTargetTags = (prev, next) => {
    const before = targetsMap(prev);
    const after = targetsMap(next);
    const tags = new Set([...before.keys(), ...after.keys()]);
    const changed = new Set();
    tags.forEach(t => {
      const a = before.get(t) || [];
      const b = after.get(t) || [];
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) changed.add(t);
    });
    return changed;
  };

  const reqsForRoute = r => {
    if (r.page === 'home') return [{url: listUrl(r, null), method:'GET', category:'list'}];
    if (r.page === 'task' && r.id != null) {
      return [
        {url: `${API}/tasks?select=${sel}&id=eq.${r.id}`, method:'GET', category:'task'},
        {url: listUrl(r, r.id), method:'GET', category:'list'},
        {url: remindersUrl(r.id), method:'GET', category:'reminders'},
      ];
    }
    if ((r.page === 'edit' || r.page === 'move') && r.id != null) {
      return [
        {url: `${API}/tasks?select=${sel}&id=eq.${r.id}`, method:'GET', category:'task'},
        {url: remindersUrl(r.id), method:'GET', category:'reminders'},
      ];
    }
    if (r.page === 'reminder' && r.id != null) {
      return [
        {url: `${API}/tasks?select=${sel}&id=eq.${r.id}`, method:'GET', category:'task'},
        {url: alertsAllUrl(), method:'GET', category:'alerts'},
      ];
    }
    if (r.page === 'alerts') return [{url: alertsAllUrl(), method:'GET', category:'alerts'}];
    if (r.page === 'alert' && r.atag) return [{url: alertsTagUrl(r.atag), method:'GET', category:'aurls'}];
    return [];
  };

  // ---- reducers ----
  const initReducer$ = xs.of(prev => (prev === undefined ? initialState : prev));
  const routeReducer$ = route$.map(r => setKey('route', r));

  const listReducer$ = selectBody('list', asArray)
    .compose(sampleCombine(route$))
    .map(([list, r]) => prev => {
      const hasMore = list.length > r.limit;
      const pageList = hasMore ? list.slice(0, r.limit) : list;
      const s = base(prev);
      return {...s, list: pageList, hasMore};
  });

  const taskReducer$ = selectBody('task', asOne).map(task => setKey('task', task));
  const taskFromHTTP$ = selectBody('task', asOne).remember();
  const remindersReducer$ = selectBody('reminders', asArray).map(rows => setKey('reminders', rows));

  const alertsBody$ = selectBody('alerts', asArray);
  const alertsReducer$ = alertsBody$.map(rows => setKey('alerts', rows));
  const aurlsReducer$ = selectBody('aurls', asArray).map(rows => setKey('alertUrls', rows));

  const formInitReducer$ = route$.map(r => prev => {
    const s = base(prev);
    if (r.page === 'new') return {...s, form:{title:'', description:'', tags:'', due_date:''}, moveParent:'', task:null};
    if (r.page === 'edit') return {...s, moveParent:''};
    if (r.page === 'move') return s;
    if (r.page === 'reminder') return {...s, reminderForm:{text:''}};
    if (r.page === 'alerts') return {...s, anew:{tag:'', url:''}, aaddUrl:'', alertUrls:[]};
    if (r.page === 'alert') return {...s, aaddUrl:''};
    return {...s, moveParent:''};
  });

  const formFromTaskReducer$ = xs.combine(route$, taskFromHTTP$)
    .filter(([r, t]) => r.page === 'edit' && t && t.id === r.id)
    .map(([_, t]) => patchState({
      form: {
        title: t.title || '',
        description: t.description || '',
        tags: (t.tags || []).join(' '),
        due_date: toLocalInput(t.due_date || ''),
      }
    }));

  const moveFromTaskReducer$ = xs.combine(route$, taskFromHTTP$)
    .filter(([r, t]) => r.page === 'move' && t && t.id === r.id)
    .map(([_, t]) => setKey('moveParent', t.parent_id == null ? '' : String(t.parent_id)));

  const formInputReducer$ = actions.formReducer$.map(reducer => prev => {
    const s = base(prev);
    return {...s, form: reducer(s.form)};
  });

  const anewInputReducer$ = actions.anewReducer$.map(reducer => prev => {
    const s = base(prev);
    return {...s, anew: reducer(s.anew)};
  });

  const reminderInputReducer$ = actions.reminderFormReducer$.map(reducer => prev => {
    const s = base(prev);
    return {...s, reminderForm: reducer(s.reminderForm)};
  });

  const aaddUrlReducer$ = actions.aaddUrl$.map(v => setKey('aaddUrl', v));
  const moveParentReducer$ = actions.moveParent$.map(v => setKey('moveParent', v));

  const reducer$ = xs.merge(
    initReducer$, routeReducer$, listReducer$, taskReducer$,
    remindersReducer$,
    alertsReducer$, aurlsReducer$,
    formInitReducer$, formFromTaskReducer$, moveFromTaskReducer$,
    formInputReducer$, moveParentReducer$,
    anewInputReducer$, aaddUrlReducer$, reminderInputReducer$,
  );

  // ---- History ----
  const history$ = xs.merge(
    actions.nav$.map(url => loc(url, 'push')),
    actions.routePatch$.compose(sampleCombine(route$)).map(([patch, r]) => loc(href(r, patch), 'replace')),
  );

  // ---- HTTP ----
  const loadReq$ = route$.map(reqsForRoute).map(xs.fromArray).flatten();

  const toggleDoneReq$ = actions.toggleDone$
    .map(({id, done}) => ({url: `${API}/tasks?id=eq.${id}`, method:'PATCH', headers:J, send:{done}, category:'mut'}));

  const reorderReq$ = xs.merge(actions.moveUp$, actions.moveDown$)
    .map(send => ({url: `${API}/rpc/move_task`, method:'POST', headers:J, send, category:'mut'}));

  const dndParentReq$ = xs.merge(
    actions.dropInto$.map(send => ({url: `${API}/rpc/move_into`, method:'POST', headers:J, send, category:'mut'})),
    actions.dropUp$.map(send => ({url: `${API}/rpc/move_task`, method:'POST', headers:J, send, category:'mut'})),
  );

  const buildSubmitReq = (kind, r, s) => {
    if (kind === 'task' && r.page === 'new') {
      const due_date = toZonedISOString(s.form.due_date);
      const send = {
        title: String(s.form.title || '').trim(),
        description: String(s.form.description || ''),
        tags: tagsFrom(s.form.tags),
        due_date,
        done: false,
        parent_id: r.parent,
      };
      return send.title ? {url: `${API}/rpc/append_task`, method:'POST', headers:J, send, category:'create'} : null;
    }
    if (kind === 'task' && r.page === 'edit' && r.id != null) {
      const due_date = toZonedISOString(s.form.due_date);
      const send = {
        title: String(s.form.title || '').trim(),
        description: String(s.form.description || ''),
        tags: tagsFrom(s.form.tags),
        due_date,
      };
      return send.title ? {url: `${API}/tasks?id=eq.${r.id}`, method:'PATCH', headers:J, send, category:'update'} : null;
    }
    if (kind === 'move' && r.page === 'move' && r.id != null) {
      const send = {task_id: r.id, new_parent_id: num(s.moveParent), new_position: MAXPOS};
      return {url: `${API}/rpc/move_task`, method:'POST', headers:J, send, category:'mut'};
    }
    return null;
  };

  const submitReq$ = actions.submitKind$
    .compose(sampleCombine(route$, sources.state.stream))
    .map(([kind, r, s]) => buildSubmitReq(kind, r, s))
    .filter(Boolean);

  const deleteReq$ = actions.del$
    .compose(sampleCombine(route$))
    .filter(([_, r]) => r.page === 'edit' && r.id != null)
    .map(([_, r]) => ({
      url: `${API}/tasks?id=eq.${r.id}`,
      method:'DELETE',
      headers:{'Prefer':'return=representation'},
      category:'delete'
    }));

  // alerts CRUD
  const acreateReq$ = actions.acreate$
    .compose(sampleCombine(route$, state$))
    .map(([kind, r, s]) => {
      const tag = kind === 'new' ? String(s.anew.tag || '').trim() : String(r.atag || '').trim();
      const url = kind === 'new' ? String(s.anew.url || '').trim() : String(s.aaddUrl || '').trim();
      return (tag && url)
        ? ({url: `${API}/apprise_targets`, method:'POST', headers:J, send:{tag, url, enabled:true}, category:'acreate'})
        : null;
    })
    .filter(Boolean);

  const atoggleReq$ = actions.atoggle$
    .map(({tag, url, enabled}) => ({
      url: `${API}/apprise_targets?tag=eq.${encodeURIComponent(tag)}&url=eq.${encodeURIComponent(url)}`,
      method:'PATCH', headers:J, send:{enabled}, category:'amut'
    }));

  const adelReq$ = actions.adel$
    .map(({tag, url}) => ({
      url: `${API}/apprise_targets?tag=eq.${encodeURIComponent(tag)}&url=eq.${encodeURIComponent(url)}`,
      method:'DELETE', headers:{'Prefer':'return=representation'}, category:'amut'
    }));

  const adelTagReq$ = actions.adelTag$
    .map(({tag}) => ({
      url: `${API}/apprise_targets?tag=eq.${encodeURIComponent(tag)}`,
      method:'DELETE', headers:{'Prefer':'return=representation'}, category:'adelTag'
    }));

  const reminderPayload = ({task, fire, text, tags, apprise_targets}) => {
    const spec = reminderSpec(fire);
    if (!spec) return null;
    return {
      entity_type:'task',
      entity_id:String(task.id),
      title: (`Reminder: ${task.title || ''}`).trim() || 'Reminder',
      message: (`Reminder for "${task.title || ''}" due ${dueFmt(task.due_date)}`).trim(),
      tags,
      apprise_targets,
      reminder_text: text,
      spec,
    };
  };

  const reminderUpdateReqs = (nextDue, s) => {
    const reminders = Array.isArray(s.reminders) ? s.reminders : [];
    const next = toDateTime(nextDue);
    if (!reminders.length) return [];
    if (!next || !next.isValid) {
      return reminders.map(r => {
        const id = reminderPick(r, 'ReminderId') || r.workflow_id || r.id;
        return id ? ({url: `${REMINDERS_API}/reminders/${id}`, method:'DELETE', category:'reminderUpdate'}) : null;
      }).filter(Boolean);
    }

    return reminders.map(r => {
      const id = reminderPick(r, 'ReminderId') || r.workflow_id || r.id;
      const text = reminderPick(r, 'ReminderText') || '';
      const fire = reminderFireTime(next, text);
      if (!id || !fire) return null;
      const tags = reminderArr(r, 'ReminderTags') || (Array.isArray(s.task && s.task.tags) ? s.task.tags : []);
      const apprise_targets = reminderArr(r, 'ReminderTargets') || targetsForTags(tags, s.alerts);
      const send = reminderPayload({task: s.task || {}, fire, text, tags, apprise_targets});
      return send ? ({url: `${REMINDERS_API}/reminders/${id}`, method:'PUT', headers:J, send, category:'reminderUpdate'}) : null;
    }).filter(Boolean);
  };

  const reminderRetargetReqs = (changedTags, s, alerts) => {
    const reminders = Array.isArray(s.reminders) ? s.reminders : [];
    const due = s.task && s.task.due_date ? s.task.due_date : null;
    const tagsChanged = Array.isArray(changedTags) ? new Set(changedTags) : changedTags;
    if (!reminders.length || !tagsChanged || !tagsChanged.size) return [];

    return reminders.map(r => {
      const tags = reminderArr(r, 'ReminderTags') || [];
      if (!tags.some(t => tagsChanged.has(t))) return null;
      const id = reminderPick(r, 'ReminderId') || r.workflow_id || r.id;
      const text = reminderPick(r, 'ReminderText') || '';
      const fire = reminderFireTime(due, text);
      if (!id || !fire) return null;
      const apprise_targets = targetsForTags(tags, alerts || s.alerts);
      const send = reminderPayload({task: s.task || {}, fire, text, tags, apprise_targets});
      return send ? ({url: `${REMINDERS_API}/reminders/${id}`, method:'PUT', headers:J, send, category:'reminderUpdate'}) : null;
    }).filter(Boolean);
  };

  const reminderCreateReq$ = actions.reminderSubmit$
    .compose(sampleCombine(route$, state$))
    .map(([_, r, s]) => {
      if (r.page !== 'reminder' || !s.task || s.task.id == null) return null;
      const text = String(s.reminderForm && s.reminderForm.text || '').trim();
      const fire = reminderFireTime(s.task.due_date, text);
      if (!fire) return null;
      const tags = Array.isArray(s.task.tags) ? s.task.tags : [];
      const apprise_targets = targetsForTags(tags, s.alerts);
      const send = reminderPayload({task: s.task, fire, text, tags, apprise_targets});
      return send ? {url: `${REMINDERS_API}/reminders`, method:'POST', headers:J, send, category:'reminderCreate'} : null;
    })
    .filter(Boolean);

  const reminderUpdateReq$ = actions.submitKind$
    .compose(sampleCombine(route$, state$))
    .map(([kind, r, s]) => {
      if (!(kind === 'task' && r.page === 'edit' && r.id != null && s.task)) return [];
      const prevDue = toZonedISOString(s.task.due_date);
      const nextDue = toZonedISOString(s.form.due_date);
      if (prevDue === nextDue) return [];
      return reminderUpdateReqs(nextDue, s);
    })
    .map(xs.fromArray)
    .flatten();

  const alertsDiff$ = alertsBody$
    .fold((acc, curr) => ({prev: acc.curr, curr}), {prev: null, curr: null})
    .filter(acc => acc.prev !== null)
    .map(({prev, curr}) => ({changed: changedTargetTags(prev, curr), alerts: curr}))
    .filter(({changed}) => changed.size > 0);

  const reminderRetargetReq$ = alertsDiff$
    .compose(sampleCombine(state$))
    .map(([{changed, alerts}, s]) => reminderRetargetReqs(changed, {...s, alerts}, alerts))
    .map(xs.fromArray)
    .flatten();

  const reloadTrigger$ = xs.merge(
    sources.HTTP.select('mut').flatten().mapTo(true),
    sources.HTTP.select('create').flatten().mapTo(true),
    sources.HTTP.select('update').flatten().mapTo(true),
    sources.HTTP.select('delete').flatten().mapTo(true),
    sources.HTTP.select('acreate').flatten().mapTo(true),
    sources.HTTP.select('amut').flatten().mapTo(true),
    sources.HTTP.select('adelTag').flatten().mapTo(true),
    sources.HTTP.select('reminderCreate').flatten().mapTo(true),
    sources.HTTP.select('reminderUpdate').flatten().mapTo(true),
  );

  const reloadReq$ = reloadTrigger$
    .compose(sampleCombine(route$))
    .map(([_, r]) => reqsForRoute(r))
    .map(xs.fromArray)
    .flatten();

  const http$ = xs.merge(
    loadReq$, reloadReq$,
    toggleDoneReq$, reorderReq$, dndParentReq$,
    submitReq$, deleteReq$,
    acreateReq$, atoggleReq$, adelReq$, adelTagReq$,
    reminderCreateReq$, reminderUpdateReq$, reminderRetargetReq$
  );

  // ---- post-mutation navigation (tasks + delete-tag) ----
  const backLocFor = (r, parent_id) =>
    parent_id == null
      ? loc(href(r, {page:'home', id:null, parent:null}), 'push')
      : loc(href(r, {page:'task', id: parent_id, parent:null}), 'push');

  const post$ = xs.merge(
    sources.HTTP.select('create').flatten().map(res => ({kind:'create', res})),
    sources.HTTP.select('update').flatten().map(res => ({kind:'update', res})),
    sources.HTTP.select('delete').flatten().map(res => ({kind:'delete', res})),
  );

  const postNav$ = post$
    .compose(sampleCombine(route$, state$))
    .map(([{kind, res}, r, s]) => {
      if (kind === 'create') {
        const created = res && res.body ? res.body : null;
        const pid = created && created.parent_id !== undefined ? created.parent_id : null;
        return backLocFor(r, pid);
      }
      if (kind === 'update') {
        const body = Array.isArray(res.body) ? res.body[0] : null;
        const pid = body ? body.parent_id : (s.task ? s.task.parent_id : null);
        return backLocFor(r, pid);
      }
      return backLocFor(r, s.task ? s.task.parent_id : null);
    });

  const reminderNav$ = sources.HTTP.select('reminderCreate').flatten()
    .compose(sampleCombine(route$, state$))
    .map(([_, r, s]) => loc(href(r, {page:'task', id: s.task ? s.task.id : r.id, parent:null}), 'push'));

  const delTagNav$ = sources.HTTP.select('adelTag').flatten()
    .compose(sampleCombine(route$))
    .map(([_, r]) => loc(href(r, {page:'alerts', atag:null, id:null, parent:null}), 'push'));

  return {state: reducer$, HTTP: http$, History: xs.merge(history$, postNav$, delTagNav$, reminderNav$)};
}

// ---- View helpers ----

const selVal = v => ({
  props:{value: String(v)},
  hook:{
    insert: vnode => { vnode.elm.value = String(v); },
    update: (_, vnode) => { vnode.elm.value = String(v); },
  }
});

const colSet = r => new Set((r && r.cols && r.cols.length) ? r.cols : DEFAULT_COLS);
const toggleCols = (r, c) => {
  const cols = (r.cols && r.cols.length ? r.cols : DEFAULT_COLS).slice();
  const i = cols.indexOf(c);
  const next = i >= 0 ? cols.filter(x => x !== c) : cols.concat([c]);
  return next.join(',');
};
const remindersForView = rows => (rows || []).map(r => {
  const sa = r && r.search_attributes ? r.search_attributes : {};
  const pick = k => {
    const v = sa[k];
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const next = pick('ReminderNextFireTime') || r.start_time || '';
  return {
    id: pick('ReminderId') || r.workflow_id || next || '',
    text: pick('ReminderText') || '',
    next,
  };
}).sort((a, b) => {
  const da = toDateTime(a.next);
  const db = toDateTime(b.next);
  if (da && db) return da.toMillis() - db.toMillis();
  if (da) return -1;
  if (db) return 1;
  return 0;
});

const TopNav = r => div([
  a('.nav', {attrs:{href: href(r, {page:'home', id:null, parent:null, atag:null})}}, 'Tasks'),
  span(' | '),
  a('.nav', {attrs:{href: href(r, {page:'alerts', id:null, parent:null, atag:null})}}, 'Alerts'),
]);

function TaskRow(r, t) {
  const toTask = href(r, {page:'task', id: t.id});
  const pid = t.parent_id == null ? 'null' : String(t.parent_id);
  const showArrows = !!r.reorder && r.sort === 'position';
  const on = colSet(r);

  const cellTitle = h('td', [
    showArrows ? button('.up', {attrs:{type:'button', 'data-id': t.id, 'data-pos': String(t.position|0), 'data-parent': pid}}, '↑') : null,
    showArrows ? button('.down', {attrs:{type:'button', 'data-id': t.id, 'data-pos': String(t.position|0), 'data-parent': pid}}, '↓') : null,
    showArrows ? span(' ') : null,
    a('.nav', {attrs:{href: toTask}}, [t.title || '(untitled)']),
  ]);

  return h('tr.row', {key: t.id, attrs:{draggable:true, 'data-id': t.id, 'data-parent': pid}}, [
    on.has('done') ? h('td', [input('.toggle', {attrs:{type:'checkbox', 'data-id': t.id}, props:{checked: !!t.done}})]) : null,
    on.has('position') ? h('td', [String(t.position == null ? '' : t.position)]) : null, // Pos BEFORE Title
    on.has('title') ? cellTitle : null,
    on.has('due') ? h('td', [dueFmt(t.due_date)]) : null,
    on.has('tags') ? h('td', [(t.tags || []).join(' ')]) : null,
    on.has('created') ? h('td', [createdFmt(t.created_at)]) : null,
  ].filter(Boolean));
}

function Filters(r) {
  const on = colSet(r);
  const colBox = (c, labelText) =>
    label([
      input('.col', {attrs:{type:'checkbox', 'data-cols': toggleCols(r, c)}, props:{checked: on.has(c)}}),
      ` ${labelText}`
    ]);

  return div('.filters', [
    div([label(['Search ', input('.q', {attrs:{placeholder:'title/description', value: r.q}})])]),
    div([label(['Tags ', input('.tags', {attrs:{placeholder:'tag1 tag2', value: r.tags}})])]),
    div([label([input('.done', {attrs:{type:'checkbox'}, props:{checked: !!r.showDone}}), ' show done'])]),
    div([label([input('.reorder', {attrs:{type:'checkbox'}, props:{checked: !!r.reorder}}), ' reorder (position only)'])]),
    div([label(['Per page ', select('.limit', selVal(r.limit), [
      option({attrs:{value:'10'}}, '10'),
      option({attrs:{value:'25'}}, '25'),
      option({attrs:{value:'50'}}, '50'),
      option({attrs:{value:'100'}}, '100'),
    ])])]),
    div([label(['Sort ', select('.sort', {attrs:{value: r.sort}}, [
      option({attrs:{value:'position'}}, 'position'),
      option({attrs:{value:'due'}}, 'due'),
      option({attrs:{value:'created'}}, 'created'),
      option({attrs:{value:'title'}}, 'title'),
    ])])]),
    div([label(['Dir ', select('.dir', {attrs:{value: r.dir}}, [
      option({attrs:{value:'asc'}}, 'asc'),
      option({attrs:{value:'desc'}}, 'desc'),
    ])])]),
    div([span('Columns: '), colBox('done','done'), span(' '), colBox('position','pos'), span(' '),
      colBox('title','title'), span(' '), colBox('due','due'), span(' '),
      colBox('tags','tags'), span(' '), colBox('created','created')
    ]),
  ]);
}

function Pager(r, hasMore) {
  const prev = r.p > 1 ? href(r, {p: r.p - 1}) : null;
  const next = hasMore ? href(r, {p: r.p + 1}) : null;
  return div('.pager', [
    prev ? a('.nav', {attrs:{href: prev, draggable:'false'}}, '← Prev') : span(''),
    span(` page ${r.p} `),
    next ? a('.nav', {attrs:{href: next, draggable:'false'}}, 'Next →') : span(''),
  ]);
}

function ListControls(r, newHref) {
  return div('.list-controls', [
    newHref ? div([a('.nav', {attrs:{href: newHref, draggable:'false'}}, '+ New')]) : null,
    h('details.list-interactions', [h('summary', 'List options'), Filters(r)]),
  ]);
}

function view(state$) {
  return state$.map(s => {
    const r = s.route;
    const newRoot = href(r, {page:'new', parent:'null', id:null});
    const newChild = r.id != null ? href(r, {page:'new', parent:r.id}) : newRoot;
    const editLink = t => href(r, {page:'edit', id: t.id});
    const items = s.list || [];
    const on = colSet(r);

    const header = () => {
      if (r.page === 'home') return null;

      if (r.page === 'task') {
        const t = s.task;
        const title = t ? t.title : `Task #${r.id ?? ''}`;
        const upId = t ? t.parent_id : null;

        const upHref = upId == null
          ? href(r, {page:'home', id:null, parent:null})
          : href(r, {page:'task', id: upId});

        const upLabel = upId == null ? '← Back to Tasks' : '← Up one level';
        const due = t && t.due_date ? `due ${dueFmt(t.due_date)}` : 'no due';
        const created = t && t.created_at ? `created ${createdFmt(t.created_at)}` : null;
        const tagStr = t && t.tags && t.tags.length ? `tags: ${t.tags.join(', ')}` : 'no tags';

        return div('.header', [
          div('.up-drop', {attrs:{'data-parent': upId == null ? 'null' : String(upId)}}, [
            a('.nav', {attrs:{href:upHref, draggable:'false'}}, upLabel)
          ]),
          h1(title),
          t ? div('.meta', [
            div([t.description ? t.description : '']),
            div([due]),
            created ? div([created]) : null,
            div([tagStr]),
          ]) : null,
          div('.actions', [t ? a('.nav', {attrs:{href:editLink(t), draggable:'false'}}, 'Edit') : null]),
        ]);
      }

      if (r.page === 'new') {
        const back = (r.parent == null)
          ? href(r, {page:'home', id:null, parent:null})
          : href(r, {page:'task', id:r.parent});
        return div('.header', [
          div([a('.nav', {attrs:{href:back, draggable:'false'}}, '← Cancel')]),
          h1(r.parent == null ? 'New root task' : `New subtask of #${r.parent}`),
        ]);
      }

      if (r.page === 'edit') {
        const back = (r.id != null)
          ? href(r, {page:'task', id: r.id, parent:null})
          : href(r, {page:'home', id:null, parent:null});
        return div('.header', [
          div([a('.nav', {attrs:{href:back, draggable:'false'}}, '← Back')]),
          h1(s.task ? `Edit: ${s.task.title}` : 'Edit task'),
        ]);
      }

      if (r.page === 'move') {
        const pid = s.task ? s.task.parent_id : null;
        const back = pid == null ? href(r, {page:'home', id:null, parent:null}) : href(r, {page:'task', id: pid});
        return div('.header', [
          div([a('.nav', {attrs:{href:back, draggable:'false'}}, '← Back')]),
          h1(s.task ? `Move: ${s.task.title}` : 'Move task'),
        ]);
      }

      if (r.page === 'reminder') {
        const back = href(r, {page:'task', id: r.id, parent:null});
        return div('.header', [
          div([a('.nav', {attrs:{href:back, draggable:'false'}}, '← Back')]),
          h1(s.task ? `Reminders for ${s.task.title}` : 'Add reminder'),
        ]);
      }

      if (r.page === 'alerts') return div('.header', [h1('Alerts')]);
      if (r.page === 'alert') return div('.header', [
        div([a('.nav', {attrs:{href: href(r, {page:'alerts', atag:null})}}, '← Back')]),
        h1(`Alert: ${r.atag}`),
        button('.adelTag', {attrs:{type:'button', 'data-tag': r.atag}}, 'Delete tag'),
      ]);

      return null;
    };

    const tableHead = () => h('thead', [
      h('tr', [
        on.has('done') ? h('th', ['Done']) : null,
        on.has('position') ? h('th', ['Pos']) : null,
        on.has('title') ? h('th', ['Title']) : null,
        on.has('due') ? h('th', ['Due']) : null,
        on.has('tags') ? h('th', ['Tags']) : null,
        on.has('created') ? h('th', ['Created']) : null,
      ].filter(Boolean))
    ]);

    const listPage = () => div('.page', [
      r.page === 'home' ? TopNav(r) : null,
      header(),
      r.page === 'task' ? (() => {
        const rs = remindersForView(s.reminders);
        const add = href(r, {page:'reminder', parent:null});
        return div('.reminders', [
          h1('Reminders'),
          div([a('.nav', {attrs:{href: add}}, 'Add reminder')]),
          rs.length ? h('ul', rs.map(it => h('li', {key: it.id}, [
            span([dueFmt(it.next) || '(unscheduled)']),
            span(' — '),
            span([it.text || '(no text)']),
          ]))) : div(['No reminders yet.'])
        ]);
      })() : null,
      ListControls(r, r.page === 'home' ? newRoot : newChild),
      h('table', [tableHead(), h('tbody', items.map(t => TaskRow(r, t)))]),
      items.length === 0 ? div('.empty', ['No tasks match filters.']) : null,
      Pager(r, !!s.hasMore),
    ]);

    const taskForm = mode => form('.task-form', [
      div([label(['Title ', input('.ftitle', {attrs:{value: s.form.title || '', required:true}})])]),
      div([label(['Description ', textarea('.fdesc', {attrs:{rows:6}}, s.form.description || '')])]),
      div([label(['Tags ', input('.ftags', {attrs:{placeholder:'tag1 tag2', value: s.form.tags || ''}})])]),
      div([label(['Due date/time ', input('.fdue', {attrs:{type:'datetime-local', value: toLocalInput(s.form.due_date)}, props:{value: toLocalInput(s.form.due_date)}})])]),
      div('.actions', [
        button('.save', {attrs:{type:'submit'}}, mode === 'new' ? 'Create' : 'Save'),
        mode === 'edit' ? button('.delete', {attrs:{type:'button'}}, 'Delete') : null,
      ]),
    ]);

    const newPage = () => div('.page', [header(), taskForm('new')]);
    const editPage = () => div('.page', [header(), taskForm('edit')]);

    const movePage = () => div('.page', [
      header(),
      form('.move-form', [
        div([label(['New parent id (blank = root) ', input('.mparent', {attrs:{value: s.moveParent}})])]),
        div('.actions', [button({attrs:{type:'submit'}}, 'Move (append)')]),
        div('.hint', ['Tip: Enable "reorder" (position) to show ↑/↓. Drag & drop onto a row to make it a child.']),
      ])
    ]);

    const reminderPage = () => {
      const due = s.task && s.task.due_date ? dueFmt(s.task.due_date) : '';
      const disabled = !due;
      return div('.page', [
        TopNav(r),
        header(),
        due ? div([`Due: ${due}`]) : div(['Set a due date before adding reminders.']),
        form('.reminder-form', [
          div([label(['Interval before due date ', input('.rtext', {attrs:{placeholder:'e.g. 30 minutes', required:true}, props:{value: s.reminderForm.text || ''}})])]),
          div([button({attrs:{type:'submit', disabled}}, 'Save reminder')]),
        ])
      ]);
    };

    const alertsPage = () => {
      const q = qnorm(r.q);
      const map = new Map();
      (s.alerts || []).forEach(x => {
        const tag = x && x.tag ? String(x.tag) : '';
        if (!tag) return;
        if (!map.has(tag)) map.set(tag, {tag, n:0, en:0, latest:null});
        const it = map.get(tag);
        it.n += 1;
        if (x.enabled) it.en += 1;
        const c = x.created_at ? new Date(x.created_at) : null;
        if (c && !isNaN(c) && (!it.latest || c > it.latest)) it.latest = c;
      });
      const tags = Array.from(map.values())
        .filter(it => !q || it.tag.toLowerCase().includes(q))
        .sort((a,b) => a.tag.localeCompare(b.tag));

      return div('.page', [
        TopNav(r),
        header(),
        div([label(['Filter tags ', input('.q', {attrs:{placeholder:'tag', value: r.q}})])]),
        h('table', [
          h('thead', [h('tr', [h('th','Tag'), h('th','URLs'), h('th','Enabled'), h('th','Latest')])]),
          h('tbody', tags.map(it =>
            h('tr', {key: it.tag}, [
              h('td', [a('.nav', {attrs:{href: href(r, {page:'alert', atag: it.tag})}}, it.tag)]),
              h('td', [String(it.n)]),
              h('td', [String(it.en)]),
              h('td', [it.latest ? createdFmt(it.latest.toISOString()) : '']),
            ])
          ))
        ]),
        h1('Add'),
        form('.anew', [
          div([label(['Tag ', input('.anew-tag', {attrs:{value: s.anew.tag || '', required:true}})])]),
          div([label(['URL ', input('.anew-url', {attrs:{value: s.anew.url || '', required:true}})])]),
          div([button({attrs:{type:'submit'}}, 'Add')]),
        ]),
      ]);
    };

    const alertDetailPage = () => div('.page', [
      TopNav(r),
      header(),
      h('table', [
        h('thead', [h('tr', [h('th','On'), h('th','URL'), h('th','Created'), h('th','')])]),
        h('tbody', (s.alertUrls || []).map(x =>
          h('tr', {key: `${x.tag}|${x.url}`}, [
            h('td', [input('.atoggle', {attrs:{type:'checkbox', 'data-tag': x.tag, 'data-url': x.url}, props:{checked: !!x.enabled}})]),
            h('td', [x.url || '']),
            h('td', [createdFmt(x.created_at)]),
            h('td', [button('.adel', {attrs:{type:'button', 'data-tag': x.tag, 'data-url': x.url}}, 'Delete')]),
          ])
        ))
      ]),
      h1('Add URL'),
      form('.aadd', [
        div([label(['URL ', input('.aadd-url', {attrs:{value: s.aaddUrl || '', required:true}})])]),
        div([button({attrs:{type:'submit'}}, 'Add')]),
      ]),
    ]);

    if (r.page === 'home' || r.page === 'task') return listPage();
    if (r.page === 'new') return newPage();
    if (r.page === 'edit') return editPage();
    if (r.page === 'move') return movePage();
    if (r.page === 'reminder') return reminderPage();
    if (r.page === 'alerts') return alertsPage();
    if (r.page === 'alert') return alertDetailPage();
    return div('.page', [header()]);
  });
}

function makeEffectDriver() {
  return effect$ => effect$.addListener({next: fn => fn && fn(), error() {}, complete() {}});
}

function main(sources) {
  const actions = intent(sources);
  const sinks = model(sources, actions);

  const fxDrag$ = actions.dragstart$.map(e => () =>
    e.dataTransfer && e.dataTransfer.setData('text/plain', 'x')
  );

  return {
    ...sinks,
    DOM: view(sources.state.stream),
    Effect: xs.merge(actions.dragover$, fxDrag$),
  };
}

run(withState(main), {
  DOM: makeDOMDriver('#app'),
  HTTP: makeHTTPDriver(),
  History: makeHistoryDriver(),
  Effect: makeEffectDriver(),
});
