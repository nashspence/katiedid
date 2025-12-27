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

const API_BASE = '/api';
const MAXPOS = 2147483647;

const DEFAULT_COLS = ['done','title','due','tags'];
const qnorm = s => (s || '').toLowerCase().trim();
const num = v => (v == null || v === '' || v === 'null') ? null : Number(v);
const int = (v, d) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const tagsFrom = s => qnorm(s).split(/[,\s]+/).filter(Boolean);

const fmt = new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'short'});
const dtFmt = iso => { try { return iso ? fmt.format(new Date(iso)) : ''; } catch { return iso || ''; } };

const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const toUtcISO = local => {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d) ? null : d.toISOString();
};

// ---------------- UI routing/nav (UI responsibility) ----------------

const parseCols = s => {
  const raw = (s == null || s === '') ? null : String(s);
  const cols = raw ? raw.split(',').map(qnorm).filter(Boolean) : DEFAULT_COLS.slice();
  return {cols, raw: raw || ''};
};

const parseRoute = search => {
  const qs = new URLSearchParams(search || '');
  const page = qs.get('page') || 'home'; // home | task | new | edit | move | alerts | alert | reminder
  const id = num(qs.get('id'));
  const parent = num(qs.get('parent'));
  const atag = (qs.get('atag') || '').trim();
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

// ---------------- state ----------------

const initialState = {
  route: parseRoute(location.search),
  task: null,
  list: [],
  hasMore: false,
  alertHasMore: false,
  reminders: [],
  form: {title:'', description:'', tags:'', dueDate:''},
  reminderForm: {before:''},
  moveParent: '',
  alerts: [],
  alertUrls: [],
  anew: {tag:'', url:''},
  aaddUrl: '',
};

const base = s => (s === undefined ? initialState : s);

// ---------------- intent ----------------

function intent(sources) {
  const DOM = sources.DOM;
  const ev = (sel, type, opts) => DOM.select(sel).events(type, opts || {});
  const attr = (e, k) => e.currentTarget && e.currentTarget.getAttribute(k);

  const nav$ = ev('a.nav', 'click', {preventDefault: true}).map(e => attr(e, 'href')).filter(Boolean);

  const routePatch$ = xs.merge(
    ev('input.q', 'input').map(e => ({q: e.target.value, p:'1'})),
    ev('input.tags', 'input').map(e => ({tags: e.target.value, p:'1'})),
    ev('input.done', 'change').map(e => ({done: e.target.checked ? '1' : '0', p:'1'})),
    ev('select.sort', 'change').map(e => ({sort: e.target.value, p:'1'})),
    ev('select.dir', 'change').map(e => ({dir: e.target.value, p:'1'})),
    ev('input.reorder', 'change').map(e => ({reorder: e.target.checked ? '1' : '0'})),
    ev('select.limit', 'change').map(e => ({limit: e.target.value, p:'1'})),
    ev('input.col', 'change').map(e => ({cols: e.target.dataset.cols, p:'1'})),
  );

  const toggleDone$ = ev('.toggle', 'change')
    .map(e => ({id: Number(e.target.dataset.id), done: e.target.checked}));

  const moveUp$ = ev('button.up', 'click', {preventDefault:true})
    .map(e => ({
      task_id: Number(e.currentTarget.dataset.id),
      new_parent_id: num(e.currentTarget.dataset.parent),
      new_position: (Number(e.currentTarget.dataset.pos)|0) - 1
    }))
    .filter(x => x.task_id != null);

  const moveDown$ = ev('button.down', 'click', {preventDefault:true})
    .map(e => ({
      task_id: Number(e.currentTarget.dataset.id),
      new_parent_id: num(e.currentTarget.dataset.parent),
      new_position: (Number(e.currentTarget.dataset.pos)|0) + 2
    }))
    .filter(x => x.task_id != null);

  const dragstart$ = ev('.row', 'dragstart');
  const dragend$ = ev('.row', 'dragend').mapTo(null);
  const draggedId$ = xs.merge(dragstart$.map(e => Number(e.currentTarget.dataset.id)), dragend$).startWith(null).remember();

  const dragover$ = xs.merge(
    ev('.row', 'dragover', {preventDefault:true}),
    ev('.up-drop', 'dragover', {preventDefault:true}),
  ).mapTo(null);

  const drop = sel => ev(sel, 'drop', {preventDefault:true});

  const dropInto$ = drop('.row').compose(sampleCombine(draggedId$))
    .map(([e, id]) => ({task_id:id, new_parent_id:Number(e.currentTarget.dataset.id), new_position:MAXPOS}))
    .filter(x => x.task_id != null && x.task_id !== x.new_parent_id);

  const dropUp$ = drop('.up-drop')
    .map(e => { if (e.stopPropagation) e.stopPropagation(); return e; })
    .compose(sampleCombine(draggedId$))
    .map(([e, id]) => ({task_id:id, new_parent_id:num(e.currentTarget.dataset.parent), new_position:MAXPOS}))
    .filter(x => x.task_id != null);

  const formInput = (sel, key) => ev(sel,'input').map(e => s => ({...s,[key]:e.target.value}));
  const formReducer$ = xs.merge(
    formInput('input.ftitle','title'),
    formInput('textarea.fdesc','description'),
    formInput('input.ftags','tags'),
    formInput('input.fdue','dueDate'),
  );

  const reminderFormReducer$ = ev('input.rtext','input')
    .map(e => prev => ({...prev, before: e.target.value}));

  const reminderSubmit$ = ev('form.reminder-form','submit',{preventDefault:true}).mapTo(true);

  const submitKind$ = xs.merge(
    ev('form.task-form','submit',{preventDefault:true}).mapTo('task'),
    ev('form.move-form','submit',{preventDefault:true}).mapTo('move'),
  );

  const del$ = ev('button.delete','click',{preventDefault:true}).mapTo(true);
  const moveParent$ = ev('input.mparent','input').map(e => e.target.value);

  // alerts
  const anewReducer$ = xs.merge(formInput('input.anew-tag','tag'), formInput('input.anew-url','url'));
  const aaddUrl$ = ev('input.aadd-url','input').map(e => e.target.value);
  const acreate$ = xs.merge(
    ev('form.anew','submit',{preventDefault:true}).mapTo('new'),
    ev('form.aadd','submit',{preventDefault:true}).mapTo('add'),
  );
  const atoggle$ = ev('.atoggle','change')
    .map(e => ({tag:e.target.dataset.tag, url:e.target.dataset.url, enabled:e.target.checked}));
  const adel$ = ev('button.adel','click',{preventDefault:true})
    .map(e => ({tag:e.currentTarget.dataset.tag, url:e.currentTarget.dataset.url}));
  const adelTag$ = ev('button.adelTag','click',{preventDefault:true})
    .map(e => ({tag:e.currentTarget.dataset.tag}));

  return {
    nav$, routePatch$, toggleDone$, moveUp$, moveDown$,
    dragstart$, dragover$, dropInto$, dropUp$,
    formReducer$, submitKind$, del$, moveParent$,
    anewReducer$, aaddUrl$, acreate$, atoggle$, adel$, adelTag$,
    reminderFormReducer$, reminderSubmit$,
  };
}

// ---------------- model (route orchestration + HTTP only) ----------------

function model(sources, actions) {
  const asArr = x => Array.isArray(x) ? x : [];
  const pickBody = cat => sources.HTTP.select(cat).flatten().map(res => res.body);

  const setKey = (k,v) => prev => ({...base(prev), [k]: v});
  const patch = p => prev => ({...base(prev), ...p});

  const route$ = sources.History.startWith({search:location.search}).map(l => parseRoute(l.search)).remember();
  const state$ = sources.state.stream.remember();

  const listUrl = r => {
    const qs = new URLSearchParams();
    qs.set('page', String(r.p));
    qs.set('pageSize', String(r.limit));
    qs.set('includeDone', String(!!r.showDone));
    if (r.q) qs.set('search', r.q);
    if (r.tags) qs.set('tags', r.tags);
    qs.set('sort', r.sort || 'position');
    qs.set('dir', r.dir || 'asc');
    // IMPORTANT: omit parentId for root (don't send empty string)
    if (r.page === 'task' && r.id != null) qs.set('parentId', String(r.id));
    return `${API_BASE}/tasks?${qs.toString()}`;
  };

  const reqsForRoute = r => {
    if (r.page === 'home') return [{url:listUrl(r), method:'GET', category:'list'}];
    if (r.page === 'task' && r.id != null) return [
      {url:`${API_BASE}/tasks/${r.id}`, method:'GET', category:'task'},
      {url:listUrl(r), method:'GET', category:'list'},
      {url:`${API_BASE}/tasks/${r.id}/reminders`, method:'GET', category:'reminders'},
    ];
    if ((r.page === 'edit' || r.page === 'move') && r.id != null) return [
      {url:`${API_BASE}/tasks/${r.id}`, method:'GET', category:'task'},
      {url:`${API_BASE}/tasks/${r.id}/reminders`, method:'GET', category:'reminders'},
    ];
    if (r.page === 'reminder' && r.id != null) return [
      {url:`${API_BASE}/tasks/${r.id}`, method:'GET', category:'task'},
      {url:`${API_BASE}/tasks/${r.id}/reminders`, method:'GET', category:'reminders'},
    ];
    const alertUrl = () => {
      const qs = new URLSearchParams();
      qs.set('page', String(r.p));
      qs.set('pageSize', String(r.limit));
      if (r.q) qs.set('search', r.q);
      return `${API_BASE}/alerts?${qs.toString()}`;
    };
    if (r.page === 'alerts') return [{url: alertUrl(), method:'GET', category:'alerts'}];
    if (r.page === 'alert' && r.atag) return [{url:`${API_BASE}/alerts/${encodeURIComponent(r.atag)}`, method:'GET', category:'aurls'}];
    return [];
  };

  const init$ = xs.of(prev => (prev === undefined ? initialState : prev));
  const routeR$ = route$.map(r => setKey('route', r));

  const listR$ = pickBody('list').map(b => prev => {
    const s = base(prev);
    const items = b && b.items ? asArr(b.items) : asArr(b);
    const hasMore = !!(b && b.hasMore);
    return {...s, list: items, hasMore};
  });

  const taskR$ = pickBody('task').map(t => setKey('task', t || null));
  const remindersR$ = pickBody('reminders').map(rows => setKey('reminders', asArr(rows)));
  const alertsR$ = pickBody('alerts').map(b => prev => {
    const items = b && b.items ? asArr(b.items) : asArr(b);
    const hasMore = !!(b && b.hasMore);
    return {...base(prev), alerts: items, alertHasMore: hasMore};
  });
  const aurlsR$ = pickBody('aurls').map(rows => setKey('alertUrls', asArr(rows)));

  const formInitR$ = route$.map(r => prev => {
    const s = base(prev);
    if (r.page === 'new') return {...s, form:{title:'',description:'',tags:'',dueDate:''}, moveParent:'', task:null};
    if (r.page === 'reminder') return {...s, reminderForm:{before:''}};
    if (r.page === 'alerts') return {...s, anew:{tag:'',url:''}, aaddUrl:'', alertUrls:[]};
    if (r.page === 'alert') return {...s, aaddUrl:''};
    if (r.page === 'edit') return {...s, moveParent:''};
    return {...s, moveParent:''};
  });

  const formFromTaskR$ = xs.combine(route$, pickBody('task').startWith(null))
    .filter(([r,t]) => r.page === 'edit' && t && t.id === r.id)
    .map(([_,t]) => patch({form:{
      title:t.title||'',
      description:t.description||'',
      tags:(t.tags||[]).join(' '),
      dueDate: toLocalInput(t.due_date||''),
    }}));

  const moveFromTaskR$ = xs.combine(route$, pickBody('task').startWith(null))
    .filter(([r,t]) => r.page === 'move' && t && t.id === r.id)
    .map(([_,t]) => setKey('moveParent', t.parent_id == null ? '' : String(t.parent_id)));

  const formInputR$ = actions.formReducer$.map(fn => prev => ({...base(prev), form: fn(base(prev).form)}));
  const anewInputR$ = actions.anewReducer$.map(fn => prev => ({...base(prev), anew: fn(base(prev).anew)}));
  const aaddUrlR$ = actions.aaddUrl$.map(v => setKey('aaddUrl', v));
  const moveParentR$ = actions.moveParent$.map(v => setKey('moveParent', v));
  const reminderInputR$ = actions.reminderFormReducer$.map(fn => prev => ({...base(prev), reminderForm: fn(base(prev).reminderForm)}));

  const reducer$ = xs.merge(
    init$, routeR$,
    listR$, taskR$, remindersR$, alertsR$, aurlsR$,
    formInitR$, formFromTaskR$, moveFromTaskR$,
    formInputR$, anewInputR$, aaddUrlR$, moveParentR$, reminderInputR$,
  );

  const history$ = xs.merge(
    actions.nav$.map(url => loc(url,'push')),
    actions.routePatch$.compose(sampleCombine(route$)).map(([p,r]) => loc(href(r,p),'replace')),
  );

  const loadReq$ = route$.map(reqsForRoute).map(xs.fromArray).flatten();

  const jsonHeaders = {'Content-Type':'application/json'};

  const toggleDoneReq$ = actions.toggleDone$.map(({id,done}) => ({
    url:`${API_BASE}/tasks/${id}`, method:'PATCH', category:'mut', headers: jsonHeaders, send:{done}
  }));

  const moveReq$ = xs.merge(actions.moveUp$, actions.moveDown$, actions.dropInto$, actions.dropUp$)
    .map(({task_id,new_parent_id,new_position}) => ({
      url:`${API_BASE}/tasks/${task_id}/move`, method:'POST', category:'mut',
      headers: jsonHeaders, send:{newParentId:new_parent_id, newPosition:new_position}
    }));

  const submitReq$ = actions.submitKind$
    .compose(sampleCombine(route$, state$))
    .map(([kind, r, s]) => {
      if (kind === 'task' && r.page === 'new') {
        const title = String(s.form.title||'').trim();
        if (!title) return null;
        return {
          url:`${API_BASE}/tasks`, method:'POST', category:'create', headers: jsonHeaders,
          send:{
            title,
            description:String(s.form.description||''),
            tags: tagsFrom(s.form.tags),
            dueDate: toUtcISO(s.form.dueDate),
            parentId: r.parent,
          }
        };
      }
      if (kind === 'task' && r.page === 'edit' && r.id != null) {
        const title = String(s.form.title||'').trim();
        if (!title) return null;
        return {
          url:`${API_BASE}/tasks/${r.id}`, method:'PATCH', category:'update', headers: jsonHeaders,
          send:{
            title,
            description:String(s.form.description||''),
            tags: tagsFrom(s.form.tags),
            dueDate: toUtcISO(s.form.dueDate),
          }
        };
      }
      if (kind === 'move' && r.page === 'move' && r.id != null) {
        return {
          url:`${API_BASE}/tasks/${r.id}/move`, method:'POST', category:'mut', headers: jsonHeaders,
          send:{newParentId: num(s.moveParent), newPosition: MAXPOS}
        };
      }
      return null;
    })
    .filter(Boolean);

  const deleteReq$ = actions.del$
    .compose(sampleCombine(route$))
    .filter(([_,r]) => r.page === 'edit' && r.id != null)
    .map(([_,r]) => ({url:`${API_BASE}/tasks/${r.id}`, method:'DELETE', category:'delete'}));

  const acreateReq$ = actions.acreate$
    .compose(sampleCombine(route$, state$))
    .map(([kind, r, s]) => {
      const tag = kind === 'new' ? String(s.anew.tag||'').trim() : String(r.atag||'').trim();
      const url = kind === 'new' ? String(s.anew.url||'').trim() : String(s.aaddUrl||'').trim();
      return (tag && url) ? ({url:`${API_BASE}/alerts`, method:'POST', category:'acreate', headers: jsonHeaders, send:{tag,url,enabled:true}}) : null;
    })
    .filter(Boolean);

  const atoggleReq$ = actions.atoggle$.map(({tag,url,enabled}) => ({
    url:`${API_BASE}/alerts/${encodeURIComponent(tag)}?url=${encodeURIComponent(url)}`,
    method:'PUT', category:'amut', headers: jsonHeaders, send:{enabled}
  }));

  const adelReq$ = actions.adel$.map(({tag,url}) => ({
    url:`${API_BASE}/alerts/${encodeURIComponent(tag)}?url=${encodeURIComponent(url)}`,
    method:'DELETE', category:'amut'
  }));

  const adelTagReq$ = actions.adelTag$.map(({tag}) => ({
    url:`${API_BASE}/alerts/${encodeURIComponent(tag)}`, method:'DELETE', category:'adelTag'
  }));

  const reminderCreateReq$ = actions.reminderSubmit$
    .compose(sampleCombine(route$, state$))
    .map(([_, r, s]) => {
      if (r.page !== 'reminder' || !s.task || s.task.id == null) return null;
      const before = String((s.reminderForm && s.reminderForm.before) || '').trim();
      return before
        ? ({url:`${API_BASE}/tasks/${s.task.id}/reminders`, method:'POST', category:'reminderCreate', headers: jsonHeaders, send:{before}})
        : null;
    })
    .filter(Boolean);

  const reloadTrigger$ = xs.merge(
    sources.HTTP.select('mut').flatten().mapTo(true),
    sources.HTTP.select('create').flatten().mapTo(true),
    sources.HTTP.select('update').flatten().mapTo(true),
    sources.HTTP.select('delete').flatten().mapTo(true),
    sources.HTTP.select('acreate').flatten().mapTo(true),
    sources.HTTP.select('amut').flatten().mapTo(true),
    sources.HTTP.select('adelTag').flatten().mapTo(true),
    sources.HTTP.select('reminderCreate').flatten().mapTo(true),
  );

  const reloadReq$ = reloadTrigger$
    .compose(sampleCombine(route$))
    .map(([_, r]) => reqsForRoute(r))
    .map(xs.fromArray).flatten();

  const http$ = xs.merge(
    loadReq$, reloadReq$,
    toggleDoneReq$, moveReq$,
    submitReq$, deleteReq$,
    acreateReq$, atoggleReq$, adelReq$, adelTagReq$,
    reminderCreateReq$
  );

  const backLocFor = (r, parentId) =>
    parentId == null ? loc(href(r,{page:'home',id:null,parent:null}),'push')
      : loc(href(r,{page:'task',id:parentId,parent:null}),'push');

  const post$ = xs.merge(
    sources.HTTP.select('create').flatten().map(res => ({kind:'create', res})),
    sources.HTTP.select('update').flatten().map(res => ({kind:'update', res})),
    sources.HTTP.select('delete').flatten().map(res => ({kind:'delete', res})),
  );

  const postNav$ = post$
    .compose(sampleCombine(route$, state$))
    .map(([{kind,res}, r, s]) => {
      const body = res && res.body ? res.body : null;
      const bodyParent = body ? body.parent_id : undefined;
      if ((kind === 'create' || kind === 'update') && bodyParent !== undefined) return backLocFor(r, bodyParent);
      return backLocFor(r, s.task ? s.task.parent_id : null);
    });

  const reminderNav$ = sources.HTTP.select('reminderCreate').flatten()
    .compose(sampleCombine(route$, state$))
    .map(([_, r, s]) => loc(href(r,{page:'task', id:s.task ? s.task.id : r.id, parent:null}),'push'));

  const delTagNav$ = sources.HTTP.select('adelTag').flatten()
    .compose(sampleCombine(route$))
    .map(([_, r]) => loc(href(r,{page:'alerts', atag:null, id:null, parent:null}),'push'));

  return {state: reducer$, HTTP: http$, History: xs.merge(history$, postNav$, reminderNav$, delTagNav$)};
}

// ---------------- view helpers (UI) ----------------

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

const TopNav = r => div([
  a('.nav', {attrs:{href: href(r,{page:'home',id:null,parent:null,atag:null})}}, 'Tasks'),
  span(' | '),
  a('.nav', {attrs:{href: href(r,{page:'alerts',id:null,parent:null,atag:null})}}, 'Alerts'),
]);

function TaskRow(r, t) {
  const toTask = href(r, {page:'task', id:t.id});
  const pid = t.parent_id == null ? 'null' : String(t.parent_id);
  const showArrows = !!r.reorder && r.sort === 'position';
  const on = colSet(r);

  const cellTitle = h('td', [
    showArrows ? button('.up', {attrs:{type:'button','data-id':t.id,'data-pos':String(t.position|0),'data-parent':pid}}, '↑') : null,
    showArrows ? button('.down', {attrs:{type:'button','data-id':t.id,'data-pos':String(t.position|0),'data-parent':pid}}, '↓') : null,
    showArrows ? span(' ') : null,
    a('.nav', {attrs:{href: toTask}}, [t.title || '(untitled)']),
  ]);

  return h('tr.row', {key:t.id, attrs:{draggable:true,'data-id':t.id,'data-parent':pid}}, [
    on.has('done') ? h('td',[input('.toggle',{attrs:{type:'checkbox','data-id':t.id}, props:{checked:!!t.done}})]) : null,
    on.has('position') ? h('td',[String(t.position == null ? '' : t.position)]) : null,
    on.has('title') ? cellTitle : null,
    on.has('due') ? h('td',[dtFmt(t.due_date)]) : null,
    on.has('tags') ? h('td',[(t.tags || []).join(' ')]) : null,
    on.has('created') ? h('td',[dtFmt(t.created_at)]) : null,
  ].filter(Boolean));
}

function Filters(r) {
  const on = colSet(r);
  const colBox = (c, labelText) =>
    label([
      input('.col', {attrs:{type:'checkbox','data-cols':toggleCols(r,c)}, props:{checked:on.has(c)}}),
      ` ${labelText}`
    ]);

  return div('.filters', [
    div([label(['Search ', input('.q',{attrs:{placeholder:'title/description', value:r.q}})])]),
    div([label(['Tags ', input('.tags',{attrs:{placeholder:'tag1 tag2', value:r.tags}})])]),
    div([label([input('.done',{attrs:{type:'checkbox'}, props:{checked:!!r.showDone}}), ' show done'])]),
    div([label([input('.reorder',{attrs:{type:'checkbox'}, props:{checked:!!r.reorder}}), ' reorder (position only)'])]),
    div([label(['Per page ', select('.limit', selVal(r.limit), [
      option({attrs:{value:'10'}}, '10'),
      option({attrs:{value:'25'}}, '25'),
      option({attrs:{value:'50'}}, '50'),
      option({attrs:{value:'100'}}, '100'),
    ])])]),
    div([label(['Sort ', select('.sort',{attrs:{value:r.sort}}, [
      option({attrs:{value:'position'}}, 'position'),
      option({attrs:{value:'due'}}, 'due'),
      option({attrs:{value:'created'}}, 'created'),
      option({attrs:{value:'title'}}, 'title'),
    ])])]),
    div([label(['Dir ', select('.dir',{attrs:{value:r.dir}}, [
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
  const prev = r.p > 1 ? href(r,{p:r.p-1}) : null;
  const next = hasMore ? href(r,{p:r.p+1}) : null;
  return div('.pager', [
    prev ? a('.nav',{attrs:{href:prev,draggable:'false'}}, '← Prev') : span(''),
    span(` page ${r.p} `),
    next ? a('.nav',{attrs:{href:next,draggable:'false'}}, 'Next →') : span(''),
  ]);
}

function ListControls(r, newHref) {
  return div('.list-controls', [
    newHref ? div([a('.nav',{attrs:{href:newHref,draggable:'false'}}, '+ New')]) : null,
    h('details.list-interactions', [h('summary','List options'), Filters(r)]),
  ]);
}

function view(state$) {
  return state$.map(s => {
    const r = s.route;
    const newRoot = href(r,{page:'new', parent:'null', id:null});
    const newChild = r.id != null ? href(r,{page:'new', parent:r.id}) : newRoot;
    const editLink = t => href(r,{page:'edit', id:t.id});
    const items = s.list || [];
    const on = colSet(r);

    const header = () => {
      if (r.page === 'home') return null;

      if (r.page === 'task') {
        const t = s.task;
        const title = t ? t.title : `Task #${r.id ?? ''}`;
        const upId = t ? t.parent_id : null;

        const upHref = upId == null
          ? href(r,{page:'home',id:null,parent:null})
          : href(r,{page:'task',id:upId});

        const upLabel = upId == null ? '← Back to Tasks' : '← Up one level';
        const due = t && t.due_date ? `due ${dtFmt(t.due_date)}` : 'no due';
        const created = t && t.created_at ? `created ${dtFmt(t.created_at)}` : null;
        const tagStr = t && t.tags && t.tags.length ? `tags: ${t.tags.join(', ')}` : 'no tags';

        return div('.header', [
          div('.up-drop',{attrs:{'data-parent': upId == null ? 'null' : String(upId)}}, [
            a('.nav',{attrs:{href:upHref,draggable:'false'}}, upLabel)
          ]),
          h1(title),
          t ? div('.meta', [
            div([t.description || '']),
            div([due]),
            created ? div([created]) : null,
            div([tagStr]),
          ]) : null,
          div('.actions', [t ? a('.nav',{attrs:{href:editLink(t),draggable:'false'}}, 'Edit') : null]),
        ]);
      }

      if (r.page === 'new') {
        const back = (r.parent == null)
          ? href(r,{page:'home',id:null,parent:null})
          : href(r,{page:'task',id:r.parent});
        return div('.header', [
          div([a('.nav',{attrs:{href:back,draggable:'false'}}, '← Cancel')]),
          h1(r.parent == null ? 'New root task' : `New subtask of #${r.parent}`),
        ]);
      }

      if (r.page === 'edit') {
        const back = (r.id != null)
          ? href(r,{page:'task',id:r.id,parent:null})
          : href(r,{page:'home',id:null,parent:null});
        return div('.header', [
          div([a('.nav',{attrs:{href:back,draggable:'false'}}, '← Back')]),
          h1(s.task ? `Edit: ${s.task.title}` : 'Edit task'),
        ]);
      }

      if (r.page === 'move') {
        const pid = s.task ? s.task.parent_id : null;
        const back = pid == null ? href(r,{page:'home',id:null,parent:null}) : href(r,{page:'task',id:pid});
        return div('.header', [
          div([a('.nav',{attrs:{href:back,draggable:'false'}}, '← Back')]),
          h1(s.task ? `Move: ${s.task.title}` : 'Move task'),
        ]);
      }

      if (r.page === 'reminder') {
        const back = href(r,{page:'task', id:r.id, parent:null});
        return div('.header', [
          div([a('.nav',{attrs:{href:back,draggable:'false'}}, '← Back')]),
          h1(s.task ? `Reminders for ${s.task.title}` : 'Add reminder'),
        ]);
      }

      if (r.page === 'alerts') return div('.header',[h1('Alerts')]);
      if (r.page === 'alert') return div('.header', [
        div([a('.nav',{attrs:{href: href(r,{page:'alerts',atag:null})}}, '← Back')]),
        h1(`Alert: ${r.atag}`),
        button('.adelTag',{attrs:{type:'button','data-tag':r.atag}}, 'Delete tag'),
      ]);

      return null;
    };

    const tableHead = () => h('thead', [h('tr', [
      on.has('done') ? h('th',['Done']) : null,
      on.has('position') ? h('th',['Pos']) : null,
      on.has('title') ? h('th',['Title']) : null,
      on.has('due') ? h('th',['Due']) : null,
      on.has('tags') ? h('th',['Tags']) : null,
      on.has('created') ? h('th',['Created']) : null,
    ].filter(Boolean))]);

    const listPage = () => div('.page', [
      r.page === 'home' ? TopNav(r) : null,
      header(),
      r.page === 'task' ? (() => {
        const rs = s.reminders || [];
        const add = href(r,{page:'reminder', parent:null});
        return div('.reminders', [
          h1('Reminders'),
          div([a('.nav',{attrs:{href:add}}, 'Add reminder')]),
          rs.length ? h('ul', rs.map(it => {
            const next = it.nextFireTime || it.next_fire_time || it.next || '';
            return h('li',{key:it.id || next}, [
              span([dtFmt(next) || '(unscheduled)']),
              span(' — '),
              span([it.text || it.before || '(no text)']),
            ]);
          })) : div(['No reminders yet.'])
        ]);
      })() : null,
      ListControls(r, r.page === 'home' ? newRoot : newChild),
      h('table', [tableHead(), h('tbody', items.map(t => TaskRow(r,t)))]),
      items.length === 0 ? div('.empty',['No tasks match filters.']) : null,
      Pager(r, !!s.hasMore),
    ]);

    const taskForm = mode => form('.task-form', [
      div([label(['Title ', input('.ftitle',{attrs:{value:s.form.title||'', required:true}})])]),
      div([label(['Description ', textarea('.fdesc',{attrs:{rows:6}}, s.form.description||'')])]),
      div([label(['Tags ', input('.ftags',{attrs:{placeholder:'tag1 tag2', value:s.form.tags||''}})])]),
      div([label(['Due date/time ', input('.fdue',{attrs:{type:'datetime-local', value: toLocalInput(s.form.dueDate)}, props:{value: toLocalInput(s.form.dueDate)}})])]),
      div('.actions', [
        button('.save',{attrs:{type:'submit'}}, mode === 'new' ? 'Create' : 'Save'),
        mode === 'edit' ? button('.delete',{attrs:{type:'button'}}, 'Delete') : null,
      ]),
    ]);

    const newPage = () => div('.page',[header(), taskForm('new')]);
    const editPage = () => div('.page',[header(), taskForm('edit')]);

    const movePage = () => div('.page', [
      header(),
      form('.move-form', [
        div([label(['New parent id (blank = root) ', input('.mparent',{attrs:{value:s.moveParent}})])]),
        div('.actions',[button({attrs:{type:'submit'}}, 'Move (append)')]),
        div('.hint',['Tip: Enable "reorder" (position) to show ↑/↓. Drag & drop onto a row to make it a child.']),
      ])
    ]);

    const reminderPage = () => {
      const due = s.task && s.task.due_date ? dtFmt(s.task.due_date) : '';
      const disabled = !due;
      return div('.page', [
        TopNav(r),
        header(),
        due ? div([`Due: ${due}`]) : div(['Set a due date before adding reminders.']),
        form('.reminder-form', [
          div([label(['Interval before due date ', input('.rtext',{attrs:{placeholder:'e.g. 30 minutes', required:true}, props:{value:(s.reminderForm.before||'')}})])]),
          div([button({attrs:{type:'submit', disabled}}, 'Save reminder')]),
        ])
      ]);
    };

    const alertsPage = () => {
      const tags = s.alerts || [];

      return div('.page', [
        TopNav(r),
        header(),
        div([label(['Filter tags ', input('.q',{attrs:{placeholder:'tag', value:r.q}})])]),
        h('table', [
          h('thead',[h('tr',[h('th','Tag'),h('th','URLs'),h('th','Enabled'),h('th','Latest')])]),
          h('tbody', tags.map(it => {
            const latest = it.latest || it.latest_at || '';
            return h('tr',{key:it.tag}, [
              h('td',[a('.nav',{attrs:{href: href(r,{page:'alert', atag: it.tag, p:1})}}, it.tag)]),
              h('td',[String(it.url_count ?? it.urlCount ?? 0)]),
              h('td',[String(it.enabled_count ?? it.enabledCount ?? 0)]),
              h('td',[latest ? dtFmt(latest) : '']),
            ]);
          }))
        ]),
        Pager(r, !!s.alertHasMore),
        h1('Add'),
        form('.anew', [
          div([label(['Tag ', input('.anew-tag',{attrs:{value:s.anew.tag||'', required:true}})])]),
          div([label(['URL ', input('.anew-url',{attrs:{value:s.anew.url||'', required:true}})])]),
          div([button({attrs:{type:'submit'}}, 'Add')]),
        ]),
      ]);
    };

    const alertDetailPage = () => div('.page', [
      TopNav(r),
      header(),
      h('table', [
        h('thead',[h('tr',[h('th','On'),h('th','URL'),h('th','Created'),h('th','')])]),
        h('tbody', (s.alertUrls||[]).map(x => {
          const c = x.created_at;
          return h('tr',{key:`${x.tag}|${x.url}`}, [
            h('td',[input('.atoggle',{attrs:{type:'checkbox','data-tag':x.tag,'data-url':x.url}, props:{checked:!!x.enabled}})]),
            h('td',[x.url||'']),
            h('td',[dtFmt(c)]),
            h('td',[button('.adel',{attrs:{type:'button','data-tag':x.tag,'data-url':x.url}}, 'Delete')]),
          ]);
        }))
      ]),
      h1('Add URL'),
      form('.aadd', [
        div([label(['URL ', input('.aadd-url',{attrs:{value:s.aaddUrl||'', required:true}})])]),
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
    return div('.page',[header()]);
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
