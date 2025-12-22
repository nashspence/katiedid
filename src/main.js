import xs from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import {run} from '@cycle/run';
import {withState} from '@cycle/state';
import {
  makeDOMDriver, h, div, h1, a, form, label, input, textarea,
  button, select, option, ul, li, span
} from '@cycle/dom';
import {makeHTTPDriver} from '@cycle/http';
import {makeHistoryDriver} from '@cycle/history';

/**
 * Strict conventional Cycle.js:
 * Intent: DOM+History -> actions
 * Model: sources+actions -> reducers + HTTP + History
 * View: state$ -> VDOM
 */

const API = `${location.origin}/api`;
const J = {'Content-Type': 'application/json', 'Prefer': 'return=representation'};
const MAXPOS = 2147483647;

const num = v => (v == null || v === '' || v === 'null') ? null : Number(v);
const int = (v, d) => {
  if (v == null || v === '') return d; // IMPORTANT: missing query param defaults
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const qnorm = s => (s || '').toLowerCase().trim();
const tagsFrom = s => qnorm(s).split(/[,\s]+/).filter(Boolean);

const parseRoute = search => {
  const qs = new URLSearchParams(search || '');
  const page = qs.get('page') || 'home';               // home | task | new | edit | move
  const id = num(qs.get('id'));
  const parent = num(qs.get('parent'));                // for page=new
  const q = qs.get('q') || '';
  const tags = qs.get('tags') || '';
  const showDone = (qs.get('done') || '0') === '1';
  const sort = qs.get('sort') || 'position';           // position | due | created | title
  const dir = (qs.get('dir') || 'asc') === 'desc' ? 'desc' : 'asc';
  const reorder = (qs.get('reorder') || '0') === '1';
  const limit = Math.max(1, Math.min(200, int(qs.get('limit'), 25))); // default 25
  const p = Math.max(1, int(qs.get('p'), 1));           // 1-based page index
  return {page, id, parent, q, tags, showDone, sort, dir, reorder, limit, p, _qs: qs};
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
  hasMore: false,
  form: {title:'', description:'', tags:'', due_date:''},
  moveParent: '',
};

const base = s => (s === undefined ? initialState : s);

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
  );

  const toggleDone$ = ev('.toggle', 'change')
    .map(e => ({id: Number(e.target.dataset.id), done: e.target.checked}));

  // Cross-page reorder by absolute position (uses rpc/move_task)
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
      new_position: (Number(e.currentTarget.dataset.pos) | 0) + 2   // <-- FIX (was +1)
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

  const submitKind$ = xs.merge(
    ev('form.task-form', 'submit', {preventDefault: true}).mapTo('task'),
    ev('form.move-form', 'submit', {preventDefault: true}).mapTo('move'),
  );

  const del$ = ev('button.delete', 'click', {preventDefault: true}).mapTo(true);
  const moveParent$ = ev('input.mparent', 'input').map(e => e.target.value);

  return {
    nav$, routePatch$, toggleDone$, moveUp$, moveDown$,
    dragstart$, dragover$, dropInto$, dropUp$,
    formReducer$, submitKind$, del$, moveParent$,
  };
}

function model(sources, actions) {
  const sel = 'id,title,description,tags,due_date,done,created_at,parent_id,position';

  const route$ = sources.History
    .startWith({search: location.search})
    .map(l => parseRoute(l.search))
    .remember();

  const state$ = sources.state.stream.remember();

  const asArray = body => Array.isArray(body) ? body : [];
  const asOne = body => Array.isArray(body) ? (body[0] || null) : null;

  const selectBody = (cat, mapBody) =>
    sources.HTTP.select(cat).flatten().map(res => mapBody(res.body));

  const setKey = (k, v) => prev => ({...base(prev), [k]: v});
  const patchState = patch => prev => ({...base(prev), ...patch});

  const orderFor = r => {
    const col = {position:'position', due:'due_date', created:'created_at', title:'title'}[r.sort] || 'position';
    const nul = col === 'due_date' ? '.nullslast' : '';
    return `${col}.${r.dir}${nul}`;
  };

  const listUrl = (r, parentId) => {
    const qs = new URLSearchParams();
    qs.set('select', sel);
    qs.set('order', orderFor(r));
    qs.set('limit', String(r.limit + 1)); // +1 sentinel to detect "has more"
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

  const reqsForRoute = r => {
    if (r.page === 'home') return [{url: listUrl(r, null), method:'GET', category:'list'}];
    if (r.page === 'task' && r.id != null) {
      return [
        {url: `${API}/tasks?select=${sel}&id=eq.${r.id}`, method:'GET', category:'task'},
        {url: listUrl(r, r.id), method:'GET', category:'list'},
      ];
    }
    if ((r.page === 'edit' || r.page === 'move') && r.id != null) {
      return [{url: `${API}/tasks?select=${sel}&id=eq.${r.id}`, method:'GET', category:'task'}];
    }
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

  const formInitReducer$ = route$.map(r => prev => {
    const s = base(prev);
    if (r.page === 'new') return {...s, form:{title:'', description:'', tags:'', due_date:''}, moveParent:'', task:null};
    if (r.page === 'edit') return {...s, moveParent:''};
    if (r.page === 'move') return s;
    return {...s, moveParent:''};
  });

  const formFromTaskReducer$ = xs.combine(route$, taskFromHTTP$)
    .filter(([r, t]) => r.page === 'edit' && t && t.id === r.id)
    .map(([_, t]) => patchState({
      form: {
        title: t.title || '',
        description: t.description || '',
        tags: (t.tags || []).join(' '),
        due_date: t.due_date || '',
      }
    }));

  const moveFromTaskReducer$ = xs.combine(route$, taskFromHTTP$)
    .filter(([r, t]) => r.page === 'move' && t && t.id === r.id)
    .map(([_, t]) => setKey('moveParent', t.parent_id == null ? '' : String(t.parent_id)));

  const formInputReducer$ = actions.formReducer$.map(reducer => prev => {
    const s = base(prev);
    return {...s, form: reducer(s.form)};
  });

  const moveParentReducer$ = actions.moveParent$.map(v => setKey('moveParent', v));

  const reducer$ = xs.merge(
    initReducer$, routeReducer$, listReducer$, taskReducer$,
    formInitReducer$, formFromTaskReducer$, moveFromTaskReducer$,
    formInputReducer$, moveParentReducer$
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
      const send = {
        title: String(s.form.title || '').trim(),
        description: String(s.form.description || ''),
        tags: tagsFrom(s.form.tags),
        due_date: s.form.due_date || null,
        done: false,
        parent_id: r.parent,
      };
      return send.title ? {url: `${API}/rpc/append_task`, method:'POST', headers:J, send, category:'create'} : null;
    }
    if (kind === 'task' && r.page === 'edit' && r.id != null) {
      const send = {
        title: String(s.form.title || '').trim(),
        description: String(s.form.description || ''),
        tags: tagsFrom(s.form.tags),
        due_date: s.form.due_date || null,
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

  const reloadTrigger$ = xs.merge(
    sources.HTTP.select('mut').flatten().mapTo(true),
    sources.HTTP.select('create').flatten().mapTo(true),
    sources.HTTP.select('update').flatten().mapTo(true),
    sources.HTTP.select('delete').flatten().mapTo(true),
  );

  const reloadReq$ = reloadTrigger$
    .compose(sampleCombine(route$))
    .map(([_, r]) => reqsForRoute(r))
    .map(xs.fromArray)
    .flatten();

  const http$ = xs.merge(
    loadReq$, reloadReq$,
    toggleDoneReq$, reorderReq$, dndParentReq$,
    submitReq$, deleteReq$
  );

  // ---- post-mutation navigation ----
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

  return {state: reducer$, HTTP: http$, History: xs.merge(history$, postNav$)};
}

// ---- View helpers ----

const selVal = v => ({
  props:{value: String(v)},
  hook:{
    insert: vnode => { vnode.elm.value = String(v); },
    update: (_, vnode) => { vnode.elm.value = String(v); },
  }
});

function TaskRow(r, t) {
  const toTask = href(r, {page:'task', id: t.id});
  const pid = t.parent_id == null ? 'null' : String(t.parent_id);
  const showArrows = !!r.reorder && r.sort === 'position';

  return li('.task', {key: t.id, attrs:{'data-id': t.id, 'data-parent': pid}}, [
    div('.row', {attrs:{draggable:true, 'data-id': t.id, 'data-parent': pid}}, [
      showArrows ? button('.up', {attrs:{type:'button', 'data-id': t.id, 'data-pos': String(t.position|0), 'data-parent': pid}}, '↑') : null,
      showArrows ? button('.down', {attrs:{type:'button', 'data-id': t.id, 'data-pos': String(t.position|0), 'data-parent': pid}}, '↓') : null,
      showArrows ? span(' ') : null,
      input('.toggle', {attrs:{type:'checkbox', 'data-id': t.id}, props:{checked: !!t.done}}),
      span(' '),
      a('.nav', {attrs:{href: toTask}}, [t.title || '(untitled)']),
    ]),
  ]);
}

function Filters(r) {
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
        const due = t && t.due_date ? `due ${t.due_date}` : 'no due';
        const created = t && t.created_at ? `created ${t.created_at}` : null;
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
          div('.actions', [
            t ? a('.nav', {attrs:{href:editLink(t), draggable:'false'}}, 'Edit') : null,
          ]),
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
        const back = pid == null
          ? href(r, {page:'home', id:null, parent:null})
          : href(r, {page:'task', id: pid});
        return div('.header', [
          div([a('.nav', {attrs:{href:back, draggable:'false'}}, '← Back')]),
          h1(s.task ? `Move: ${s.task.title}` : 'Move task'),
        ]);
      }

      return null;
    };

    const listPage = () => div('.page', [
      header(),
      ListControls(r, r.page === 'home' ? newRoot : newChild),
      ul('.list', items.map(t => TaskRow(r, t))),
      items.length === 0 ? div('.empty', ['No tasks match filters.']) : null,
      Pager(r, !!s.hasMore),
    ]);

    const taskForm = mode => form('.task-form', [
      div([label(['Title ', input('.ftitle', {attrs:{value: s.form.title || '', required:true}})])]),
      div([label(['Description ', textarea('.fdesc', {attrs:{rows:6}}, s.form.description || '')])]),
      div([label(['Tags ', input('.ftags', {attrs:{placeholder:'tag1 tag2', value: s.form.tags || ''}})])]),
      div([label(['Due date ', input('.fdue', {attrs:{type:'date', value: s.form.due_date || ''}})])]),
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

    if (r.page === 'home' || r.page === 'task') return listPage();
    if (r.page === 'new') return newPage();
    if (r.page === 'edit') return editPage();
    if (r.page === 'move') return movePage();
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
