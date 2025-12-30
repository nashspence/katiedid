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

const pgIntSec = (s) => {
  s = String(s ?? "").trim();
  if (!s) return 0;
  let sign = 1;
  if (s[0] === "-") sign = -1, s = s.slice(1).trim();
  let days = 0;
  const dm = s.match(/(-?\d+)\s+day/);
  if (dm) days = +dm[1] || 0;
  const tm = s.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  const h = tm ? +tm[1] : 0, m = tm ? +tm[2] : 0, se = tm ? +tm[3] : 0;
  return sign * (days * 86400 + h * 3600 + m * 60 + se);
};

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
  return Object.fromEntries(new URLSearchParams(raw).entries());
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
  q.set("task_id", "is.null");
  if (r.q.trim()) q.set("or", `(tag.ilike.*${r.q}*,title.ilike.*${r.q}*,body.ilike.*${r.q}*,cron.ilike.*${r.q}*)`);
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
    ?{a:"move",task_id:+did,new_parent_id:t.dataset.parent==="null"?null:+t.dataset.parent,
      new_position:${MAXPOS},back}
    :{a:"move",task_id:+did,new_parent_id:+t.dataset.id,new_position:${MAXPOS},back};
  await fetch("/a",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(p)}).catch(()=>{});
  location.href=back;
});
let rt,ch=()=>ch??=(s=>{s=document.createElement("span");s.textContent="0";s.style.cssText="position:absolute;visibility:hidden;font:inherit";document.body.append(s);const w=s.getBoundingClientRect().width;s.remove();return w})();
const upd=()=>{const cw=12*ch();document.querySelectorAll("table").forEach(t=>{const hs=[...t.querySelectorAll("th")].map(x=>x.textContent.trim());const n=hs.length||t.rows[0]?.cells.length||0;[...t.tBodies].forEach(b=>[...b.rows].forEach(r=>[...r.cells].forEach((c,i)=>c.dataset.l||(c.dataset.l=hs[i]||""))));t.classList.toggle("c",innerWidth<n*cw)})};
addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(upd,50)});addEventListener("DOMContentLoaded",upd);
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
    ${on.has("due") ? html`<td>${esc(dt(t.due_date))}</td>` : ""}
    ${on.has("tags") ? html`<td>${esc((t.tags || []).join(" "))}</td>` : ""}
    ${on.has("created") ? html`<td>${esc(dt(t.created_at))}</td>` : ""}
  </tr>`;
};

async function render(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const r = parseRoute(u);

  let task = null, list = [], more = false, rem = [];
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
    if (needTask) jobs.push(api(
      `/reminders?task_id=eq.${r.id}&kind=eq.task_due_before&order=created_at.asc`
    ).then((x) => (rem = Array.isArray(x) ? x : [])));

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
      `/apprise_targets?tag=eq.${encodeURIComponent(r.atag)}&order=created_at.desc`
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
               <a href="${href(u, { page: "move", id: r.id })}">Move</a> |
               <a href="${href(u, { page: "trem", id: r.id })}">Reminder</a>
             </div>
             <div>${esc(task?.description || "")}</div>`
          : html`<h1>Tasks</h1>`;

        const newHref = href(u, r.page === "task"
          ? { page: "new", parent: r.id }
          : { page: "new", parent: "null" });

        const remHtml = r.page === "task"
          ? html`<h2>Reminders</h2><ul>${rem.map((x) => {
            const due = task?.due_date ? new Date(task.due_date) : null;
            const sec = pgIntSec(x.before);
            const fire = due ? new Date(due.getTime() - sec * 1000).toISOString() : "";
            return html`<li>${esc(dt(fire))} — ${esc(String(x.before || ""))}${x.enabled === false ? " (off)" : ""}</li>`;
          }).join("") || html`<li>None</li>`}</ul>`
          : "";

        return html`${nav(u)}${hdr}${remHtml}
          <div><a href="${newHref}">+ New</a></div>
          ${filters(u, r)}
          <table>${head}<tbody>${list.map((t) => row(u, r, t)).join("")}</tbody></table>
          ${pager(u, r, more)}`;
      }

      if (r.page === "new") {
        const back = r.parent == null
          ? href(u, { page: "home", id: null })
          : href(u, { page: "task", id: r.parent });
        return html`${nav(u)}<a href="${back}">← Back</a><h1>New</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=save>
            <input type=hidden name=mode value=new>
            <input type=hidden name=parent value="${esc(r.parent ?? "")}">
            <input type=hidden name=back value="${esc(u.search)}">
            <label>Title <input name=title required></label><br>
            <label>Description <textarea name=description rows=6></textarea></label><br>
            <label>Tags <input name=tags></label><br>
            <label>Due <input type=datetime-local name=due></label><br>
            <button>Create</button>
          </form>`;
      }

      if (r.page === "edit") {
        return html`${nav(u)}<a href="${href(u, { page: "task", id: r.id })}">← Back</a><h1>Edit</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=save>
            <input type=hidden name=mode value=edit>
            <input type=hidden name=id value="${esc(r.id)}">
            <input type=hidden name=back value="${esc(u.search)}">
            <label>Title <input name=title required value="${esc(task?.title || "")}"></label><br>
            <label>Description <textarea name=description rows=6>${esc(task?.description || "")}</textarea></label><br>
            <label>Tags <input name=tags value="${esc((task?.tags || []).join(" "))}"></label><br>
            <label>Due <input type=datetime-local name=due value="${esc(task?.due_date ? toLocal(task.due_date) : "")}"></label><br>
            <button>Save</button>
            <button name=a value=delete>Delete</button>
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

      if (r.page === "trem") {
        return html`${nav(u)}<a href="${href(u, { page: "task", id: r.id })}">← Back</a><h1>Reminder</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=trel>
            <input type=hidden name=task_id value="${esc(r.id)}">
            <input type=hidden name=back value="${esc(href(u, { page: "task", id: r.id }))}">
            <label>Before <input name=before required placeholder="e.g. 30 minutes"></label>
            <button ${task?.due_date ? "" : "disabled"}>Save</button>
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
            <thead><tr><th>On</th><th>ID</th><th>Kind</th><th>When</th><th>TZ</th><th>Tag</th><th>Title</th><th></th></tr></thead>
            <tbody>${rlist.map((x) => {
              const when = x.kind === "one_off" ? dt(x.at) : x.kind === "interval" ? String(x.every || "") : String(x.cron || "");
              return html`<tr>
                <td><form class=i method=post action=/a>
                  <input type=hidden name=a value=rtoggle>
                  <input type=hidden name=id value="${esc(x.id)}">
                  <input type=hidden name=back value="${esc(u.search)}">
                  <input type=checkbox name=enabled value=1 ${x.enabled ? "checked" : ""} data-as>
                </form></td>
                <td><a href="${href(u, { page: "rem", id: x.id })}">${esc(x.id)}</a></td>
                <td>${esc(x.kind)}</td>
                <td>${esc(when)}</td>
                <td>${esc(x.tz || "UTC")}</td>
                <td>${esc(x.tag || "")}</td>
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
        const k = one?.kind || "one_off";
        const back = href(u, { page: "reminders", id: null });
        return html`${nav(u)}<a href="${back}">← Back</a><h1>${one ? `Reminder #${one.id}` : "New Reminder"}</h1>
          <form method=post action=/a>
            <input type=hidden name=a value=rsave>
            <input type=hidden name=id value="${esc(one?.id ?? "")}">
            <input type=hidden name=back value="${esc(back)}">
            <label>Enabled <input type=checkbox name=enabled value=1 ${one?.enabled === false ? "" : "checked"}></label><br>
            <label>Kind <select name=kind>
              ${["one_off", "interval", "cron"].map((x) =>
                `<option value="${x}" ${k === x ? "selected" : ""}>${x}</option>`).join("")}
            </select></label><br>
            <label>At <input type=datetime-local name=at value="${esc(one?.at ? toLocal(one.at) : "")}"></label><br>
            <label>Every <input name=every value="${esc(one?.every ?? "")}" placeholder="e.g. 15 minutes"></label><br>
            <label>Cron <input name=cron value="${esc(one?.cron ?? "")}" placeholder="e.g. 0 9 * * 1-5"></label><br>
            <label>Start <input type=datetime-local name=start_at value="${esc(one?.start_at ? toLocal(one.start_at) : "")}"></label><br>
            <label>End <input type=datetime-local name=end_at value="${esc(one?.end_at ? toLocal(one.end_at) : "")}"></label><br>
            <label>TZ <input name=tz value="${esc(one?.tz || "UTC")}"></label><br>
            <label>Tag <input name=tag value="${esc(one?.tag ?? "")}"></label><br>
            <label>Title <input name=title value="${esc(one?.title ?? "")}"></label><br>
            <label>Body <textarea name=body rows=6>${esc(one?.body ?? "")}</textarea></label><br>
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
      const send = {
        title,
        description: String(b.description || ""),
        tags: tagsFrom(b.tags),
        due_date: toUtcISO(b.due),
      };
      if (b.mode === "new") await api("/rpc/append_task", {
        method: "POST", headers: H,
        body: JSON.stringify({
          ...send, done: false,
          parent_id:
            b.parent === "" || b.parent == null || b.parent === "null" ? null : +b.parent,
        }),
      });
      else await api(`/tasks?id=eq.${+b.id}`, {
        method: "PATCH", headers: H, body: JSON.stringify(send),
      });
    }

    if (a === "delete") await api(`/tasks?id=eq.${+b.id}`, { method: "DELETE" });

    if (a === "trel") await api("/reminders", {
      method: "POST", headers: H,
      body: JSON.stringify({
        kind: "task_due_before",
        enabled: true,
        task_id: +b.task_id,
        before: String(b.before || "").trim(),
      }),
    });

    if (a === "rtoggle") await api(`/reminders?id=eq.${+b.id}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ enabled: b.enabled === "1" || b.enabled === "on" }),
    });

    if (a === "rdel") await api(`/reminders?id=eq.${+b.id}`, { method: "DELETE" });

    if (a === "rsave") {
      const kind = String(b.kind || "one_off");
      const send = {
        enabled: b.enabled === "1" || b.enabled === "on",
        kind,
        task_id: null,
        at: toUtcISO(b.at),
        every: String(b.every || "").trim() || null,
        cron: String(b.cron || "").trim() || null,
        start_at: toUtcISO(b.start_at),
        end_at: toUtcISO(b.end_at),
        tz: String(b.tz || "UTC").trim() || "UTC",
        tag: String(b.tag || "").trim() || null,
        title: String(b.title || "").trim(),
        body: String(b.body || ""),
      };
      if (kind !== "one_off") send.at = null;
      if (kind !== "interval") send.every = null;
      if (kind !== "cron") send.cron = null;

      if (b.id) await api(`/reminders?id=eq.${+b.id}`, {
        method: "PATCH", headers: H, body: JSON.stringify(send),
      });
      else await api("/reminders", {
        method: "POST", headers: H, body: JSON.stringify(send),
      });
    }

    if (a === "acreate" || a === "aadd") await api("/apprise_targets", {
      method: "POST", headers: H,
      body: JSON.stringify({
        tag: String(b.tag || "").trim(),
        url: String(b.url || "").trim(),
        enabled: true,
      }),
    });

    if (a === "atoggle") await api(
      `/apprise_targets?tag=eq.${encodeURIComponent(b.tag)}&url=eq.${encodeURIComponent(b.url)}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ enabled: b.enabled === "1" || b.enabled === "on" }),
    });

    if (a === "adel") await api(
      `/apprise_targets?tag=eq.${encodeURIComponent(b.tag)}&url=eq.${encodeURIComponent(b.url)}`,
      { method: "DELETE" }
    );

    if (a === "adelTag") await api(
      `/apprise_targets?tag=eq.${encodeURIComponent(b.tag)}`,
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
