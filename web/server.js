import http from "node:http";
import { URL } from "node:url";

const PORT = +process.env.PORT || 8080;
const API = (process.env.API_UPSTREAM || "http://api:80").replace(/\/$/, "");
const MAXPOS = 2147483647;
const DEF_COLS = ["done", "title", "due", "tags"];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

const num = (v) => (v == null || v === "" || v === "null" ? null : +v);
const int = (v, d) => (v == null || v === "" ? d : (Number.isFinite(+v) ? +v : d));
const tagsFrom = (s) =>
  String(s ?? "").toLowerCase().trim().split(/[,\s]+/).filter(Boolean);

const toUtcISO = (local) => {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d) ? null : d.toISOString();
};
const toLocal = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dt = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const j = (v) => (v == null ? "" : JSON.stringify(v));

const readBody = (req) =>
  new Promise((ok) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => ok(b));
  });

const parsePost = async (req) => {
  const raw = await readBody(req);
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) return raw ? JSON.parse(raw) : {};
  const sp = new URLSearchParams(raw);
  const o = {};
  for (const [k, v] of sp) o[k] = k in o ? [].concat(o[k], v) : v;
  return o;
};

const api = async (path, opt = {}) => {
  const r = await fetch(API + path, opt);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) throw Object.assign(new Error("API " + r.status), { status: r.status, body });
  return body;
};

const parseRoute = (u) => {
  const q = u.searchParams;
  const colsRaw = q.get("cols") || "";
  const cols = colsRaw
    ? colsRaw.split(",").map((s) => s.toLowerCase().trim()).filter(Boolean)
    : DEF_COLS.slice();
  return {
    page: q.get("page") || "home",
    id: num(q.get("id")),
    parent: num(q.get("parent")),
    atag: (q.get("atag") || "").trim(),
    q: q.get("q") || "",
    tags: q.get("tags") || "",
    done: (q.get("done") || "0") === "1",
    trash: (q.get("trash") || "0") === "1",
    sort: q.get("sort") || "position",
    dir: (q.get("dir") || "asc") === "desc" ? "desc" : "asc",
    reorder: (q.get("reorder") || "0") === "1",
    limit: Math.max(1, Math.min(200, int(q.get("limit"), 25))),
    p: Math.max(1, int(q.get("p"), 1)),
    cols,
    colsRaw,
  };
};

const href = (u, patch = {}) => {
  const q = new URLSearchParams(u.searchParams.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "" || v === "null") q.delete(k);
    else q.set(k, String(v));
  }
  return "/?" + q.toString();
};

const taskUrl = (req, id) => new URL(`/?page=task&id=${id}`, `http://${req.headers.host || "localhost"}`).toString();

const colSet = (r) => new Set(r.cols?.length ? r.cols : DEF_COLS);
const toggleCols = (r, c) => {
  const a = (r.cols?.length ? r.cols : DEF_COLS).slice();
  const i = a.indexOf(c);
  return (i >= 0 ? a.filter((x) => x !== c) : a.concat([c])).join(",");
};

const listUrl = (r) => {
  const q = new URLSearchParams({ select: "*" });
  q.set("parent_id", r.page === "task" && r.id != null ? `eq.${r.id}` : "is.null");
  if (!r.done) q.set("done", "eq.false");
  if (!r.trash) q.set("trashed", "eq.false");
  const ts = tagsFrom(r.tags);
  if (ts.length) q.set("tags", `cs.{${ts.map((x) => x.replace(/"/g, "")).join(",")}}`);
  if (r.q.trim()) q.set("or", `(title.ilike.*${r.q}*,description.ilike.*${r.q}*)`);
  const sm = { position: "position", due: "due_date", created: "created_at", title: "title" };
  q.set("order", `${sm[r.sort] || "position"}.${r.dir}`);
  q.set("offset", String((r.p - 1) * r.limit));
  q.set("limit", String(r.limit + 1));
  return "/tasks?" + q.toString();
};

const remListUrl = (r) => {
  const q = new URLSearchParams({ select: "*" });
  if (r.q.trim()) q.set("or", `(tag.ilike.*${r.q}*,title.ilike.*${r.q}*,body.ilike.*${r.q}*)`);
  q.set("order", `created_at.desc`);
  q.set("offset", String((r.p - 1) * r.limit));
  q.set("limit", String(r.limit + 1));
  return "/reminders?" + q.toString();
};

const html = (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ""), "");

const layout = (title, body) => html`<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  .c thead{display:none}.c tr{display:block;margin:.5em 0;border:1px solid #ccc}.c td{display:block;border:0}
  .c td:before{content:attr(data-l) ": ";font-weight:bold}
  [hidden]{display:none!important}
</style>
<script>
addEventListener("change",e=>{
  if(e.target.matches("[data-as]")) e.target.form?.requestSubmit?.()||e.target.form?.submit();
});
let did=null;
addEventListener("dragstart",e=>{
  const tr=e.target.closest("tr[data-id]"); if(!tr) return;
  did=tr.dataset.id; e.dataTransfer?.setData("text/plain","x");
});
addEventListener("dragend",()=>did=null);
addEventListener("dragover",e=>{
  if(e.target.closest("tr[data-id],.up")) e.preventDefault();
});
addEventListener("drop",async e=>{
  const t=e.target.closest("tr[data-id],.up"); if(!t||!did) return;
  e.preventDefault();
  const back=location.search?"/"+location.search:"/?page=home";
  const p=t.classList.contains("up")
    ?{a:"move",task_id:+did,new_parent_id:t.dataset.parent==="null"?null:+t.dataset.parent,new_position:${MAXPOS},back}
    :{a:"move",task_id:+did,new_parent_id:+t.dataset.id,new_position:${MAXPOS},back};
  await fetch("/a",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)}).catch(()=>{});
  location.href=back;
});
let rt,ch=()=>ch??=(s=>{s=document.createElement("span");s.textContent="0";s.style.cssText="position:absolute;visibility:hidden;font:inherit";document.body.append(s);const w=s.getBoundingClientRect().width;s.remove();return w})();
const upd=()=>{const cw=12*ch();document.querySelectorAll("table").forEach(t=>{const hs=[...t.querySelectorAll("th")].map(x=>x.textContent.trim());const n=hs.length||t.rows[0]?.cells.length||0;[...t.tBodies].forEach(b=>[...b.rows].forEach(r=>[...r.cells].forEach((c,i)=>c.dataset.l||(c.dataset.l=hs[i]||""))));t.classList.toggle("c",innerWidth<n*cw)})};
addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(upd,50)});addEventListener("DOMContentLoaded",upd);

const tz=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
addEventListener("DOMContentLoaded",()=>document.querySelectorAll("input[name=stz]").forEach(i=>{if(!i.value)i.value=tz()}));

const skVis=f=>{
  const k=(f.skind?.value||"interval").toLowerCase();
  f.querySelectorAll("[data-skind]").forEach(x=>x.hidden=x.dataset.skind!==k);
  f.querySelectorAll("[data-nonshot]").forEach(x=>x.hidden=k==="one_shot");
};
const sOn=f=>{
  const b=f.querySelector("[data-sbox]");
  if(!b) return skVis(f);
  b.hidden=!f.sched_on?.checked;
  if(!b.hidden) skVis(f);
};
addEventListener("change",e=>{
  const f=e.target.closest("form"); if(!f) return;
  if(e.target.name==="sched_on") sOn(f);
  if(e.target.name==="skind") skVis(f);
});
addEventListener("DOMContentLoaded",()=>document.querySelectorAll("form").forEach(sOn));
</script>${body}`;

const nav = (u) =>
  html`<nav>
    <a href="${href(u, { page: "home", id: null, parent: null, atag: null })}">Tasks</a>
    <a href="${href(u, { page: "reminders", id: null, parent: null, atag: null })}">Reminders</a>
    <a href="${href(u, { page: "alerts", id: null, parent: null, atag: null })}">Alerts</a>
  </nav>`;

const pager = (u, r, more) =>
  html`<div class=pg>${r.p > 1 ? `<a href="${href(u, { p: r.p - 1 })}">← Prev</a>` : "<span></span>"
    }<span>page ${r.p}</span>${more ? `<a href="${href(u, { p: r.p + 1 })}">Next →</a>` : "<span></span>"
    }</div>`;

const filters = (u, r) => {
  const on = colSet(r);
  const pill = (c, t) =>
    html`<a href="${href(u, { cols: toggleCols(r, c), p: 1 })}">${on.has(c) ? "✓ " : ""}${t}</a>`;
  const sel = (n, v, o) =>
    html`<select name="${n}" data-as>${o.map(([x, t]) => `<option value="${x}" ${String(v) === String(x) ? "selected" : ""}>${t}</option>`).join("")
      }</select>`;
  const h = (k) => html`<input type=hidden name="${k}" value="${esc(u.searchParams.get(k) || "")}">`;
  return html`<details><summary>List options</summary><form method=get>
    ${["page", "id", "parent", "atag", "cols"].map(h).join("")}
    <label>Search <input name=q value="${esc(r.q)}" data-as></label><br>
    <label>Tags <input name=tags value="${esc(r.tags)}" data-as></label><br>
    <label><input type=checkbox name=done value=1 ${r.done ? "checked" : ""} data-as> show done</label><br>
    <label><input type=checkbox name=trash value=1 ${r.trash ? "checked" : ""} data-as> show trashed</label><br>
    <label><input type=checkbox name=reorder value=1 ${r.reorder ? "checked" : ""} data-as> reorder</label><br>
    <label>Per page ${sel("limit", r.limit, [["10", "10"], ["25", "25"], ["50", "50"], ["100", "100"]])}</label>
    <label>Sort ${sel("sort", r.sort, [["position", "position"], ["due", "due"], ["created", "created"], ["title", "title"]])}</label>
    <label>Dir ${sel("dir", r.dir, [["asc", "asc"], ["desc", "desc"]])}</label><br>
    Columns: ${[
      pill("done", "done"), pill("position", "pos"), pill("title", "title"),
      pill("due", "due"), pill("tags", "tags"), pill("created", "created"),
    ].join(" | ")}
  </form></details>`;
};

const moveBtn = (u, taskId, pid, pos, lab) =>
  html`<form class=i method=post action=/a>
    <input type=hidden name=a value=move>
    <input type=hidden name=back value="${esc(u.search)}">
    <input type=hidden name=task_id value="${taskId}">
    <input type=hidden name=new_parent_id value="${pid}">
    <input type=hidden name=new_position value="${pos}">
    <button>${lab}</button>
  </form>`;

const row = (u, r, t) => {
  const on = colSet(r), ar = r.reorder && r.sort === "position";
  const pid = t.parent_id == null ? "null" : String(t.parent_id);
  const dueTxt = t.due_pending ? "pending..." : dt(t.due_date); // NEW
  return html`<tr draggable=true data-id="${t.id}" data-parent="${pid}">
    ${on.has("done") ? html`<td><form class=i method=post action=/a>
      <input type=hidden name=a value=toggle>
      <input type=hidden name=back value="${esc(u.search)}">
      <input type=hidden name=id value="${t.id}">
      <input type=checkbox name=done value=1 ${t.done ? "checked" : ""} data-as>
    </form></td>` : ""}
    ${on.has("position") ? html`<td>${esc(t.position ?? "")}</td>` : ""}
    ${on.has("title") ? html`<td>${ar ? moveBtn(u, t.id, pid, (t.position | 0) - 1, "↑") + moveBtn(u, t.id, pid, (t.position | 0) + 2, "↓") : ""
      }<a href="${href(u, { page: "task", id: t.id })}">${esc(t.title || "(untitled)")}</a></td>` : ""}
    ${on.has("due") ? html`<td>${esc(dueTxt)}</td>` : ""} <!-- UPDATED -->
    ${on.has("tags") ? html`<td>${esc((t.tags || []).join(" "))}</td>` : ""}
    ${on.has("created") ? html`<td>${esc(dt(t.created_at))}</td>` : ""}
  </tr>`;
};

const bestInt = (sec) => {
  sec = +sec || 0;
  const t = [[604800, "weeks"], [86400, "days"], [3600, "hours"], [60, "minutes"], [1, "seconds"]];
  for (const [m, u] of t) if (sec % m === 0) return [sec / m, u];
  return [sec, "seconds"];
};

const schedKind = (s) => {
  s = s || {};
  if (Array.isArray(s.cron_expressions) && s.cron_expressions.length) return "cron";
  if (Array.isArray(s.intervals) && s.intervals.length) return "interval";
  if (Array.isArray(s.calendars) && s.calendars.length) {
    const y = s.calendars[0]?.year;
    return Array.isArray(y) && y.length ? "one_shot" : "calendar";
  }
  return "interval";
};

const schedUi = (s, { oneShot } = {}) => {
  s = s || {};
  const k = oneShot ? schedKind(s) : (schedKind(s) === "one_shot" ? "calendar" : schedKind(s));
  const tz = s.time_zone_name || "";
  const cal = s.calendars?.[0] || {};
  const g0 = (kk, d) => +((cal[kk] || [])[0]?.start ?? d);
  const hh = g0("hour", 9), mm = g0("minute", 0), ss = g0("second", 0);
  const p2 = (x) => String(+x || 0).padStart(2, "0");
  const dows = cal.day_of_week || [];
  const allD = dows.length === 1 && +dows[0].start === 0 && +dows[0].end === 6;
  const dow = new Set(allD ? [0, 1, 2, 3, 4, 5, 6] : dows.map((r) => +r.start).filter((x) => x >= 0 && x <= 6));
  const [n0, u0] = Array.isArray(s.intervals) && s.intervals.length ? bestInt(+s.intervals[0]?.every_seconds || 86400) : [1, "days"];
  const at = k === "one_shot"
    ? `${g0("year", new Date().getFullYear())}-${p2(g0("month", 1))}-${p2(g0("day_of_month", 1))}T${p2(hh)}:${p2(mm)}`
    : "";

  return html`
    <label>Time zone <input name=stz value="${esc(tz)}" placeholder="(auto)"></label><br>
    <label>Kind <select name=skind>
      ${[
        oneShot && ["one_shot", "one-shot"],
        ["interval", "interval"],
        ["cron", "cron"],
        ["calendar", "calendar"],
      ].filter(Boolean).map(([v, t]) => `<option value="${v}" ${k === v ? "selected" : ""}>${t}</option>`).join("")}
    </select></label><br>

    <div data-skind=one_shot>
      <label>At <input type=datetime-local name=sat value="${esc(at)}"></label>
    </div>

    <div data-skind=interval>
      <label>Every <input name=sn type=number min=1 value="${esc(n0)}"></label>
      <select name=su>${["seconds", "minutes", "hours", "days", "weeks"].map((x) => `<option value="${x}" ${u0 === x ? "selected" : ""}>${x}</option>`).join("")}</select>
    </div>

    <div data-skind=cron>
      <label>Cron <input name=scron placeholder="0 9 * * 1-5" value="${esc((s.cron_expressions || [])[0] || "")}"></label>
    </div>

    <div data-skind=calendar>
      <label>Time <input name=stime type=time value="${esc(p2(hh) + ":" + p2(mm))}"></label>
      Days:
      ${[
        [0, "Sun"], [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"],
      ].map(([v, l]) => `<label><input type=checkbox name=sdow value="${v}" ${dow.has(v) ? "checked" : ""}>${l}</label>`).join(" ")}
    </div>

    <div data-nonshot>
      <label>Start <input type=datetime-local name=sstart value="${esc(s.start_at ? toLocal(s.start_at) : "")}"></label><br>
      <label>End <input type=datetime-local name=send value="${esc(s.end_at ? toLocal(s.end_at) : "")}"></label>
    </div>`;
};

const r1 = (n) => [{ start: n, end: n, step: 1 }];
const rAll = (a, b) => [{ start: a, end: b, step: 1 }];

const schedFrom = (b, { oneShot } = {}) => {
  const tz = String(b.stz || "").trim();
  const k = String(b.skind || "interval").toLowerCase();
  const out = { time_zone_name: tz || "UTC" };
  const sa = toUtcISO(b.sstart), ea = toUtcISO(b.send);
  if (sa) out.start_at = sa;
  if (ea) out.end_at = ea;

  if (oneShot && k === "one_shot") {
    delete out.start_at; delete out.end_at;
    const d = new Date(String(b.sat || ""));
    if (isNaN(d)) throw new Error("Reminder: invalid time");
    out.calendars = [{
      second: r1(d.getSeconds() || 0),
      minute: r1(d.getMinutes() || 0),
      hour: r1(d.getHours() || 0),
      day_of_month: r1(d.getDate()),
      month: r1(d.getMonth() + 1),
      day_of_week: r1(d.getDay()),
      year: r1(d.getFullYear()),
    }];
    return out;
  }

  if (k === "interval") {
    const n = Math.max(1, +b.sn || 1);
    const u = String(b.su || "days");
    const m = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 }[u] || 86400;
    out.intervals = [{ every_seconds: n * m }];
    return out;
  }

  if (k === "cron") {
    out.cron_expressions = [String(b.scron || "").trim()].filter(Boolean);
    return out;
  }

  const t = String(b.stime || "09:00").split(":"), hh = +t[0] || 9, mm = +t[1] || 0;
  const d0 = [].concat(b.sdow || []).map((x) => +x).filter((x) => x >= 0 && x <= 6);
  const d = d0.length ? d0 : [0, 1, 2, 3, 4, 5, 6];
  out.calendars = [{
    second: r1(0),
    minute: r1(mm),
    hour: r1(hh),
    day_of_month: rAll(1, 31),
    month: rAll(1, 12),
    day_of_week: r1(d[0]).concat(d.slice(1).map((x) => ({ start: x, end: x, step: 1 }))),
  }];
  return out;
};

async function render(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const r = parseRoute(u);

  let task = null, list = [], more = false, rem = [], history = [];
  let alerts = [], alertMore = false, aurls = [];
  let rlist = [], rmore = false, one = null;

  try {
    const jobs = [];
    const needTask = ["task", "edit", "move", "trem"].includes(r.page) && r.id != null;
    const needList = r.page === "home" || r.page === "task";

    if (needTask) jobs.push(api(`/tasks?id=eq.${r.id}`).then((x) => (task = x?.[0] || null)));
    if (needList) jobs.push(api(listUrl(r)).then((x) => {
      list = Array.isArray(x) ? x : [];
      more = list.length > r.limit;
      list = list.slice(0, r.limit);
    }));
    if (needTask) jobs.push(api(`/task_history?task_id=eq.${r.id}&order=created_at.desc`)
      .then((x) => (history = Array.isArray(x) ? x : [])));

    if (r.page === "reminders") jobs.push(api(remListUrl(r)).then((x) => {
      rlist = Array.isArray(x) ? x : [];
      rmore = rlist.length > r.limit;
      rlist = rlist.slice(0, r.limit);
    }));

    if (r.page === "rem" && r.id != null) jobs.push(api(`/reminders?id=eq.${r.id}`)
      .then((x) => (one = x?.[0] || null)));

    if (r.page === "alerts") jobs.push(api("/rpc/list_alert_tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _search: r.q || "", _page: r.p, _page_size: r.limit }),
    }).then((x) => {
      alerts = Array.isArray(x) ? x : [];
      alertMore = alerts.length > r.limit;
      alerts = alerts.slice(0, r.limit);
    }));

    if (r.page === "alert" && r.atag) jobs.push(api(
      `/webhook_targets?tag=eq.${encodeURIComponent(r.atag)}&order=created_at.desc`
    ).then((x) => (aurls = Array.isArray(x) ? x : [])));

    await Promise.all(jobs);

    const on = colSet(r);
    const head = `<thead><tr>${[
      on.has("done") && "<th>Done</th>",
      on.has("position") && "<th>Pos</th>",
      on.has("title") && "<th>Title</th>",
      on.has("due") && "<th>Due</th>",
      on.has("tags") && "<th>Tags</th>",
      on.has("created") && "<th>Created</th>",
    ].filter(Boolean).join("")}</tr></thead>`;

    const page = (() => {
      if (r.page === "home" || r.page === "task") {
        const up = task?.parent_id ?? null;
        const hdr = r.page === "task"
          ? html`<div class=up data-parent="${up == null ? "null" : esc(up)}">
               <a href="${up == null ? href(u, { page: "home", id: null }) : href(u, { page: "task", id: up })}">
                 ← ${up == null ? "Back" : "Up"}
               </a>
             </div>
             <h1>${esc(task?.title || `Task #${r.id}`)}</h1>
             <div>
               <a href="${href(u, { page: "edit", id: r.id })}">Edit</a> |
               <a href="${href(u, { page: "move", id: r.id })}">Move</a>
             </div>
             <div>${esc(task?.description || "")}</div>`
          : html`<h1>Tasks</h1>`;

        const newHref = href(u, r.page === "task"
          ? { page: "new", parent: r.id }
          : { page: "new", parent: "null" });

        const hist = history.length
          ? history.map((h) => html`<tr>
              <td>${esc(dt(h.created_at))}</td>
              <td>${esc(h.change || "")}</td>
              <td>${esc(j(h.old_values))}</td>
              <td>${esc(j(h.new_values))}</td>
            </tr>`).join("")
          : "<tr><td colspan=4>None</td></tr>";

        const historyBlock = r.page === "task" ? html`
          <h2>History</h2>
          <table>
            <thead><tr><th>When</th><th>Change</th><th>Old</th><th>New</th></tr></thead>
            <tbody>${hist}</tbody>
          </table>` : "";

        return html`${nav(u)}${hdr}
          <div><a href="${newHref}">+ New</a></div>
          ${filters(u, r)}
          <table>${head}<tbody>${list.map((t) => row(u, r, t)).join("")}</tbody></table>
          ${pager(u, r, more)}
          ${historyBlock}`;
      }

      if (r.page === "new") {
        const back = r.parent == null ? href(u, { page: "home", id: null }) : href(u, { page: "task", id: r.parent });
        const defAlert = new URL(href(u, { page: "task", id: "" }), u).toString();
        return html`${nav(u)}<a href="${back}">← Back</a><h1>New</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=save>
            <input type=hidden name=mode value=new>
            <input type=hidden name=parent value="${esc(r.parent ?? "")}">
            <input type=hidden name=back value="${esc(u.search)}">
            <label>Title <input name=title required></label><br>
            <label>Description <textarea name=description rows=6></textarea></label><br>
            <label>Tags <input name=tags></label><br>
            <label>Change alert URL <input name=alert_url value="${esc(defAlert)}"></label><br>
            <label>Due <input type=datetime-local name=due></label><br>
            <label><input type=checkbox name=sched_on value=1> auto-advance</label><br>
            <div data-sbox hidden>${schedUi(null, { oneShot: false })}</div><br>
            <button>Create</button>
          </form>`;
      }

      if (r.page === "edit") {
        const defAlert = new URL(href(u, { page: "task", id: r.id }), u).toString();
        return html`${nav(u)}<a href="${href(u, { page: "task", id: r.id })}">← Back</a><h1>Edit</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=save>
            <input type=hidden name=mode value=edit>
            <input type=hidden name=id value="${esc(r.id)}">
            <input type=hidden name=back value="${esc(u.search)}">
            <label>Title <input name=title required value="${esc(task?.title || "")}"></label><br>
            <label>Description <textarea name=description rows=6>${esc(task?.description || "")}</textarea></label><br>
            <label>Tags <input name=tags value="${esc((task?.tags || []).join(" "))}"></label><br>
            <label>Change alert URL <input name=alert_url value="${esc(task?.alert_url || defAlert)}"></label><br>
            <label>Due <input type=datetime-local name=due value="${esc(task?.due_date ? toLocal(task.due_date) : "")}"></label><br>
            <label><input type=checkbox name=sched_on value=1 ${task?.schedule ? "checked" : ""}> auto-advance</label><br>
            <div data-sbox ${task?.schedule ? "" : "hidden"}>${schedUi(task?.schedule, { oneShot: false })}</div><br>
            <button>Save</button>
            <input type=hidden name=trashed value="${task?.trashed ? "0" : "1"}">
            <button name=a value=delete>${task?.trashed ? "Restore" : "Trash"}</button>
          </form>`;
      }

      if (r.page === "move") {
        return html`${nav(u)}<a href="${href(u, { page: "task", id: r.id })}">← Back</a><h1>Move</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=move>
            <input type=hidden name=task_id value="${esc(r.id)}">
            <input type=hidden name=new_position value="${MAXPOS}">
            <input type=hidden name=back value="${esc(href(u, { page: "task", id: r.id }))}">
            <label>New parent id <input name=new_parent_id value="${esc(task?.parent_id ?? "")}"></label>
            <button>Move</button>
          </form>`;
      }

      if (r.page === "reminders") {
        return html`${nav(u)}<h1>Reminders</h1>
          <form method=get>
            <input type=hidden name=page value=reminders>
            <label>Filter <input name=q value="${esc(r.q)}" data-as></label>
          </form>
          <div><a href="${href(u, { page: "rem", id: null, p: 1 })}">+ New</a></div>
          <table>
            <thead><tr><th>On</th><th>ID</th><th>Kind</th><th>TZ</th><th>Title</th><th></th></tr></thead>
            <tbody>${rlist.map((x) => {
              const sk = schedKind(x.schedule);
              const tz = x.schedule?.time_zone_name || "UTC";
              return html`<tr>
                <td><form class=i method=post action=/a>
                  <input type=hidden name=a value=rtoggle>
                  <input type=hidden name=id value="${esc(x.id)}">
                  <input type=hidden name=back value="${esc(u.search)}">
                  <input type=checkbox name=enabled value=1 ${x.enabled ? "checked" : ""} data-as>
                </form></td>
                <td><a href="${href(u, { page: "rem", id: x.id })}">${esc(x.id)}</a></td>
                <td>${esc(sk)}</td>
                <td>${esc(tz)}</td>
                <td>${esc(x.title || "")}</td>
                <td><form class=i method=post action=/a>
                  <input type=hidden name=a value=rdel>
                  <input type=hidden name=id value="${esc(x.id)}">
                  <input type=hidden name=back value="${esc(u.search)}">
                  <button>Delete</button>
                </form></td>
              </tr>`;
            }).join("")}</tbody>
          </table>
          ${pager(u, r, rmore)}`;
      }

      if (r.page === "rem") {
        const back = href(u, { page: "reminders", id: null });
        return html`${nav(u)}<a href="${back}">← Back</a><h1>${one ? `Reminder #${one.id}` : "New Reminder"}</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=rsave>
            <input type=hidden name=id value="${esc(one?.id ?? "")}">
            <input type=hidden name=back value="${esc(back)}">
            <label>Enabled <input type=checkbox name=enabled value=1 ${one?.enabled === false ? "" : "checked"}></label><br>
            ${schedUi(one?.schedule, { oneShot: true })}<br>
            <label>Tag <input name=tag value="${esc(one?.tag ?? "")}"></label><br>
            <label>Title <input name=title value="${esc(one?.title ?? "")}"></label><br>
            <label>Body <textarea name=body rows=6>${esc(one?.body ?? "")}</textarea></label><br>
            <label>URL <input name=url value="${esc(one?.url ?? "")}" placeholder="(optional)"></label><br>
            <button>Save</button>
            ${one ? `<button name=a value=rdel>Delete</button>` : ""}
          </form>`;
      }

      if (r.page === "alerts") {
        return html`${nav(u)}<h1>Alerts</h1>
          <form method=get>
            <input type=hidden name=page value=alerts>
            <label>Filter <input name=q value="${esc(r.q)}" data-as></label>
          </form>
          <table>
            <thead><tr><th>Tag</th><th>URLs</th><th>Enabled</th><th>Latest</th></tr></thead>
            <tbody>${alerts.map((it) =>
              html`<tr>
                <td><a href="${href(u, { page: "alert", atag: it.tag, p: 1 })}">${esc(it.tag)}</a></td>
                <td>${esc(it.url_count ?? 0)}</td>
                <td>${esc(it.enabled_count ?? 0)}</td>
                <td>${esc(dt(it.latest || ""))}</td>
              </tr>`
            ).join("")}</tbody>
          </table>
          ${pager(u, r, alertMore)}
          <h2>Add</h2>
          <form method=post action=/a>
            <input type=hidden name=a value=acreate>
            <input type=hidden name=back value="${esc(href(u, { page: "alerts" }))}">
            <label>Tag <input name=tag required></label>
            <label>URL <input name=url required></label>
            <button>Add</button>
          </form>`;
      }

      if (r.page === "alert") {
        return html`${nav(u)}<a href="${href(u, { page: "alerts", atag: null })}">← Back</a>
          <h1>Alert: ${esc(r.atag)}</h1>
          <form class=i method=post action=/a>
            <input type=hidden name=a value=adelTag>
            <input type=hidden name=tag value="${esc(r.atag)}">
            <input type=hidden name=back value="${esc(href(u, { page: "alerts" }))}">
            <button>Delete tag</button>
          </form>
          <table>
            <thead><tr><th>On</th><th>URL</th><th>Created</th><th></th></tr></thead>
            <tbody>${aurls.map((x) =>
              html`<tr>
                <td><form class=i method=post action=/a>
                  <input type=hidden name=a value=atoggle>
                  <input type=hidden name=tag value="${esc(x.tag)}">
                  <input type=hidden name=url value="${esc(x.url)}">
                  <input type=hidden name=back value="${esc(u.search)}">
                  <input type=checkbox name=enabled value=1 ${x.enabled ? "checked" : ""} data-as>
                </form></td>
                <td>${esc(x.url)}</td>
                <td>${esc(dt(x.created_at))}</td>
                <td><form class=i method=post action=/a>
                  <input type=hidden name=a value=adel>
                  <input type=hidden name=tag value="${esc(x.tag)}">
                  <input type=hidden name=url value="${esc(x.url)}">
                  <input type=hidden name=back value="${esc(u.search)}">
                  <button>Delete</button>
                </form></td>
              </tr>`
            ).join("")}</tbody>
          </table>
          <h2>Add URL</h2>
          <form method=post action=/a>
            <input type=hidden name=a value=aadd>
            <input type=hidden name=tag value="${esc(r.atag)}">
            <input type=hidden name=back value="${esc(u.search)}">
            <label>URL <input name=url required></label>
            <button>Add</button>
          </form>`;
      }

      return html`${nav(u)}<h1>Unknown</h1>`;
    })();

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(layout("Tasks", page));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(layout("Error", `<pre>${esc(e.message)}\n${esc(JSON.stringify(e.body, null, 2))}</pre>
      <a href="/?page=home">Home</a>`));
  }
}

async function act(req, res) {
  const b = await parsePost(req);
  const a = b.a || "";
  const back = b.back || "/?page=home";
  const H = { "Content-Type": "application/json", Prefer: "return=representation" };

  try {
    if (a === "toggle") await api(`/tasks?id=eq.${+b.id}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ done: b.done === "1" || b.done === "on" }),
    });

    if (a === "move") await api("/rpc/move_task", {
      method: "POST", headers: H,
      body: JSON.stringify({
        task_id: +b.task_id,
        new_parent_id:
          b.new_parent_id === "" || b.new_parent_id == null || b.new_parent_id === "null"
            ? null : +b.new_parent_id,
        new_position: +b.new_position || MAXPOS,
      }),
    });

    if (a === "save") {
      const title = String(b.title || "").trim();
      if (!title) throw new Error("Title required");

      const alertUrl = String(b.alert_url || "").trim();
      const dueISO = toUtcISO(b.due);
      const schedOn = (b.sched_on === "1" || b.sched_on === "on");
      const schedule = schedOn ? schedFrom(b, { oneShot: false }) : null;

      const send = {
        title,
        description: String(b.description || ""),
        tags: tagsFrom(b.tags),
        due_date: dueISO,
        alert_url: alertUrl || null,
        schedule,
        due_pending: schedOn && !dueISO ? true : false, // NEW: clear pending when user sets due / disables schedule
      };

      if (b.mode === "new") {
        const created = await api("/rpc/append_task", {
          method: "POST", headers: H,
          body: JSON.stringify({
            title: send.title,
            description: send.description,
            tags: send.tags,
            alert_url: send.alert_url,
            due_date: send.due_date,
            done: false,
            parent_id: b.parent === "" || b.parent == null || b.parent === "null" ? null : +b.parent,
          }),
        });
        const id = created?.id ?? created?.[0]?.id;
        if (id) await api(`/tasks?id=eq.${+id}`, {
          method: "PATCH", headers: H,
          body: JSON.stringify({ schedule: send.schedule, alert_url: alertUrl || taskUrl(req, +id), due_pending: send.due_pending }),
        });
      } else await api(`/tasks?id=eq.${+b.id}`, {
        method: "PATCH", headers: H,
        body: JSON.stringify({ ...send, alert_url: alertUrl || taskUrl(req, +b.id) }),
      });
    }

    if (a === "delete") await api(`/tasks?id=eq.${+b.id}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ trashed: String(b.trashed ?? "1") !== "0" }),
    });

    if (a === "rtoggle") await api(`/reminders?id=eq.${+b.id}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ enabled: b.enabled === "1" || b.enabled === "on" }),
    });

    if (a === "rdel") await api(`/reminders?id=eq.${+b.id}`, { method: "DELETE" });

    if (a === "rsave") {
      const send = {
        enabled: b.enabled === "1" || b.enabled === "on",
        schedule: schedFrom(b, { oneShot: true }),
        tag: String(b.tag || "").trim() || null,
        title: String(b.title || "").trim(),
        body: String(b.body || ""),
        url: String(b.url || "").trim() || null,
      };
      if (b.id) await api(`/reminders?id=eq.${+b.id}`, { method: "PATCH", headers: H, body: JSON.stringify(send) });
      else await api("/reminders", { method: "POST", headers: H, body: JSON.stringify(send) });
    }

    if (a === "acreate" || a === "aadd") await api("/webhook_targets", {
      method: "POST", headers: H,
      body: JSON.stringify({
        tag: String(b.tag || "").trim(),
        url: String(b.url || "").trim(),
        enabled: true,
      }),
    });

    if (a === "atoggle") await api(
      `/webhook_targets?tag=eq.${encodeURIComponent(b.tag)}&url=eq.${encodeURIComponent(b.url)}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ enabled: b.enabled === "1" || b.enabled === "on" }),
    });

    if (a === "adel") await api(
      `/webhook_targets?tag=eq.${encodeURIComponent(b.tag)}&url=eq.${encodeURIComponent(b.url)}`,
      { method: "DELETE" }
    );

    if (a === "adelTag") await api(
      `/webhook_targets?tag=eq.${encodeURIComponent(b.tag)}`,
      { method: "DELETE" }
    );

    res.writeHead(303, { Location: back.startsWith("/") ? back : "/?page=home" });
    res.end();
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(layout("Error",
      `<pre>${esc(e.message)}\n${esc(JSON.stringify(e.body, null, 2))}</pre><a href="${esc(back)}">Back</a>`));
  }
}

http.createServer((req, res) => {
  if (req.method === "GET") return render(req, res);
  if (req.method === "POST" && req.url === "/a") return act(req, res);
  res.writeHead(404); res.end("not found");
}).listen(PORT, "0.0.0.0");
