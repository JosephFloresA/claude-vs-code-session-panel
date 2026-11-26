// Las tres vistas: bandeja + detalle, tabla densa y tablero.
import { settings, save, projectColor } from "./store.js";
import { esc, colorVar, statePill, badges, projects, ctxBar, chips, summary, summaryLine, whenText, renderDetail, mainRepo, plain, gitSig } from "./ui.js";
import { icon, STATE_ICON } from "./icons.js";
import { openViewer, previewInto, TYPE_ICON } from "./viewer.js";

// Orden pedido: (te necesitan) → terminadas sin ver → trabajando → tu turno → en pausa → cerradas.
// Dentro de cada grupo, la que termino mas recientemente primero (hora de su ultima respuesta).
const PRIO = { necesita_input: 0, trabajando: 2, esperando: 3, en_pausa: 4, vacia: 5, cerrada: 6 };
export const priority = (r) => (r.state === "necesita_input" ? 0 : r.unseen && r.state !== "trabajando" ? 1 : PRIO[r.state]);
export const finishedAt = (r) => Date.parse(r.finished_at ?? r.last_activity ?? 0) || 0;
export const byPriority = (a, b) => (Number(b.pinned) - Number(a.pinned)) || (priority(a) - priority(b)) ||
  (finishedAt(b) - finishedAt(a));

const check = (on) => `<span class="check ${on ? "on" : ""}" data-pick role="checkbox" aria-checked="${on}" title="Seleccionar (x)">${on ? icon("check", { size: 12 }) : ""}</span>`;
const empty = (msg = "No hay sesiones en esta vista.") => `<div class="empty">${icon("inbox", { size: 32 })}${msg}</div>`;

const SECTIONS = [
  { key: "necesita_input", title: "Te necesitan", test: (r) => r.state === "necesita_input" },
  { key: "sinver", title: "Terminaron sin que las vieras", test: (r) => r.unseen && r.state !== "necesita_input" && r.state !== "trabajando" },
  { key: "trabajando", title: "Trabajando", test: (r) => r.state === "trabajando" },
  { key: "esperando", title: "Tu turno · vistas, la más reciente primero", test: (r) => r.state === "esperando" && !r.unseen },
  { key: "en_pausa", title: "En pausa", test: (r) => r.state === "en_pausa" && !r.unseen },
  { key: "cerrada", title: "Sin uso y cerradas", test: (r) => r.state === "vacia" || r.state === "cerrada" },
];

// ---------------- Bandeja ----------------
export function bandeja(host, rows, ctx) {
  if (!host.querySelector(".bandeja")) {
    host.innerHTML = `<div class="bandeja"><div class="list" id="list" role="listbox" aria-label="Sesiones"></div><div class="detail" id="detail"></div></div>`;
  }
  const list = host.querySelector("#list");
  list.classList.toggle("multi", ctx.picked.size > 0);
  const scroll = list.scrollTop;
  const sorted = [...rows].sort(byPriority);
  const order = [];
  list.innerHTML = SECTIONS.map((s) => {
    const rs = sorted.filter(s.test);
    if (!rs.length) return "";
    const closed = !!settings.collapsed[s.key];
    if (!closed) order.push(...rs);
    return `<div class="section ${closed ? "closed" : ""}" data-sec="${s.key}">${icon("chevron", { size: 14, cls: "chev" })}<span class="dot ${s.key}"></span>${s.title}<span class="spacer"></span><span class="n">${rs.length}</span></div>
      ${closed ? "" : rs.map((r) => item(r, ctx)).join("")}`;
  }).join("") || empty();
  list.scrollTop = scroll;
  ctx.setOrder(order.map((r) => r.session_id));
  if (!ctx.selectedId && order[0]) ctx.select(order[0].session_id, { silent: true });
  const sel = rows.find((r) => r.session_id === ctx.selectedId);
  const detail = host.querySelector("#detail");
  const sig = sel ? `${sel.session_id}|${sel.last_activity}|${sel.state}|${sel.unseen}|${sel.pinned}|${sel.note}|${sel.note_kind}|${sel.auto_accept}|${sel.title}|${JSON.stringify(settings.fields)}|${gitSig(sel)}|${(settings.quickReplies ?? []).join("¦")}` : "";
  if (detail.dataset.sig !== sig) { detail.dataset.sig = sig; renderDetail(sel, detail); }

  list.onclick = (e) => {
    const sec = e.target.closest(".section");
    if (sec) { save((s) => { s.collapsed[sec.dataset.sec] = !s.collapsed[sec.dataset.sec]; }); return; }
    const it = e.target.closest(".item");
    if (!it || e.target.closest("a")) return;
    if (e.target.closest("[data-pick]") || e.ctrlKey || e.metaKey) { ctx.togglePick(it.dataset.id); return; }
    ctx.select(it.dataset.id);
  };
}

function item(r, ctx) {
  const f = settings.fields;
  const s = summary(r);
  const picked = ctx.picked.has(r.session_id);
  return `<div class="item ${r.session_id === ctx.selectedId ? "sel" : ""} ${r.unseen ? "unseen" : ""} ${picked ? "picked" : ""}" data-id="${esc(r.session_id)}" style="${colorVar(r)}" role="option" aria-selected="${r.session_id === ctx.selectedId}">
    <div class="strip"></div>
    ${check(picked)}
    <div class="body">
      <div class="l1"><span class="dot ${r.state}" title="${esc(r.state)}"></span><span class="ttl">${esc(r.title)}</span>${r.pinned ? icon("pin", { size: 13 }) : ""}${r.auto_accept ? `<span class="autoacc-dot" title="Aceptación automática activa">${icon("zap", { size: 13 })}</span>` : ""}<span class="when">${whenText(r)}</span></div>
      ${s ? `<div class="l2 ${s.kind}">${r.asks_question ? `<span class="flag" title="Te preguntó">${icon("question", { size: 13 })}</span>` : icon(s.icon, { size: 13 })}${r.conflicts?.length ? `<span class="flag" title="Conflicto">${icon("alert", { size: 13 })}</span>` : ""}<span class="txt">${esc(s.text)}</span></div>` : ""}
      <div class="l3">${f.proyecto ? projects(r) : ""}${ctxBar(r.context_pct)}${chips(r)}</div>
      ${r.note ? `<div class="l4 note ${r.note_kind ? "k-" + r.note_kind : ""}" title="${esc(r.note)}">${icon("note", { size: 12 })}<span>${esc(plain(r.note))}</span></div>` : ""}
    </div>
  </div>`;
}

// ---------------- Tabla ----------------
const COLUMNS = [
  { key: "pick", label: "", always: true, nosort: true, cell: (r, ctx) => check(ctx.picked.has(r.session_id)) },
  { key: "prioridad", label: "Estado", always: true, sort: (r) => priority(r), cell: (r) => statePill(r) },
  { key: "tema", label: "Tema", always: true, sort: (r) => r.title.toLowerCase(), cls: "ttl",
    cell: (r) => `<div class="in"><span class="strip" style="${colorVar(r)}"></span><span class="t" title="${esc(r.title)}">${esc(r.title)}</span>${r.pinned ? icon("pin", { size: 13, title: "Fijada" }) : ""}${r.unseen ? `<span class="dot unseen" title="Sin ver"></span>` : ""}${r.asks_question ? icon("question", { size: 14, title: "Te preguntó" }) : ""}${r.conflicts?.length ? icon("alert", { size: 14, title: "Conflicto" }) : ""}</div>` },
  { key: "proyecto", label: "Proyecto", field: "proyecto", sort: (r) => mainRepo(r) ?? "",
    cell: (r) => { const m = mainRepo(r); const extra = r.repos.length - 1;
      return m ? `<span class="proj" style="--c:${projectColor(m)}" title="${esc(r.repos.join(", "))}"><i></i>${esc(m)}${extra > 0 ? ` <span class="muted">+${extra}</span>` : ""}</span>` : ""; } },
  { key: "accion", label: "En qué está", field: "accion", cls: (r) => `clip ${summary(r)?.kind ?? ""}`, sort: (r) => summaryLine(r), cell: (r) => esc(summaryLine(r)) },
  { key: "pedido", label: "Tu último pedido", field: "pedido", cls: "clip", sort: (r) => r.last_prompt ?? "", cell: (r) => esc(plain(r.last_prompt)) },
  { key: "ab", label: "AB#", field: "ab", sort: (r) => r.work_items[0]?.id ?? 0,
    cell: (r) => r.work_items.slice(0, 2).map((w) => `<a class="chip ab" href="${esc(w.url)}" target="_blank">${w.id}</a>`).join(" ") + (r.work_items.length > 2 ? ` <span class="muted">+${r.work_items.length - 2}</span>` : "") },
  { key: "prs", label: "PRs", field: "prs", sort: (r) => r.prs.length,
    cell: (r) => r.prs.slice(0, 2).map((p) => `<a class="chip pr" href="${esc(p.url)}" target="_blank" title="${esc(p.repo)}">${p.id}</a>`).join(" ") + (r.prs.length > 2 ? ` <span class="muted" title="${esc(r.prs.slice(2).map((p) => p.repo + " " + p.id).join(", "))}">+${r.prs.length - 2}</span>` : "") },
  { key: "contexto", label: "Contexto", field: "contexto", sort: (r) => r.context_pct ?? -1, cell: (r) => ctxBar(r.context_pct) },
  { key: "archivos", label: "Arch.", field: "archivos", cls: "num", sort: (r) => r.edited_files.length, cell: (r) => r.edited_files.length || "" },
  { key: "rama", label: "Rama", field: "rama", cls: "num", sort: (r) => r.git_branch ?? "", cell: (r) => esc(r.git_branch ?? "") },
  { key: "actividad", label: "Actividad", always: true, cls: "num", sort: (r) => -Date.parse(r.last_activity ?? 0), cell: (r) => whenText(r) },
];

export function tabla(host, rows, ctx) {
  const cols = COLUMNS.filter((c) => c.always || settings.fields[c.field]);
  const { sort, dir } = settings.table;
  const col = COLUMNS.find((c) => c.key === sort && c.sort) ?? COLUMNS[1];
  const sorted = [...rows].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || byPriority(a, b);
  });
  ctx.setOrder(sorted.map((r) => r.session_id));
  let wrap = host.querySelector(".tablewrap");
  if (!wrap) { host.innerHTML = `<div class="tablewrap"></div>`; wrap = host.querySelector(".tablewrap"); }
  const scroll = wrap.scrollTop;
  const allPicked = rows.length > 0 && rows.every((r) => ctx.picked.has(r.session_id));
  wrap.innerHTML = rows.length ? `<table class="grid"><thead><tr>${cols.map((c) => c.key === "pick"
      ? `<th style="width:34px" data-pickall>${check(allPicked)}</th>`
      : `<th data-sort="${c.key}" class="${c.key === sort ? "sorted" : ""}" aria-sort="${c.key === sort ? (dir > 0 ? "ascending" : "descending") : "none"}">${c.label}${c.key === sort ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((r) => `<tr data-id="${esc(r.session_id)}" class="${r.session_id === ctx.selectedId ? "sel" : ""} ${ctx.picked.has(r.session_id) ? "picked" : ""}">${cols.map((c) =>
      `<td class="${typeof c.cls === "function" ? c.cls(r) : c.cls ?? ""}">${c.cell(r, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : empty();
  wrap.scrollTop = scroll;
  wrap.onclick = (e) => {
    if (e.target.closest("[data-pickall]")) { ctx.pickMany(rows.map((r) => r.session_id), !allPicked); return; }
    const th = e.target.closest("th[data-sort]");
    if (th) { save((s) => { s.table.dir = s.table.sort === th.dataset.sort ? -s.table.dir : 1; s.table.sort = th.dataset.sort; }); return; }
    const tr = e.target.closest("tr[data-id]");
    if (!tr || e.target.closest("a")) return;
    if (e.target.closest("[data-pick]") || e.ctrlKey || e.metaKey) { ctx.togglePick(tr.dataset.id); return; }
    ctx.openDrawer(tr.dataset.id);
  };
}

// ---------------- Tablero ----------------
const KANBAN_STATE_COLS = [
  { key: "necesita_input", title: "Te necesitan", test: (r) => r.state === "necesita_input" },
  { key: "sinver", title: "Sin ver", test: (r) => r.unseen && r.state !== "necesita_input" && r.state !== "trabajando" },
  { key: "trabajando", title: "Trabajando", test: (r) => r.state === "trabajando" },
  { key: "esperando", title: "Tu turno", test: (r) => r.state === "esperando" && !r.unseen },
  { key: "en_pausa", title: "En pausa / cerradas", test: (r) => ["en_pausa", "vacia", "cerrada"].includes(r.state) && !r.unseen, quiet: true },
];

export function tablero(host, rows, ctx) {
  if (host.querySelector(".card.dragging")) return; // no redibujar a mitad de un arrastre
  const k = settings.kanban;
  let cols;
  if (k.groupBy === "proyecto") {
    const groups = new Map();
    for (const r of rows) {
      const key = mainRepo(r) ?? "otros";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    cols = [...groups.entries()]
      .map(([key, rs]) => ({ key: "p:" + key, title: key, rows: rs, project: true }))
      .filter((c) => !k.focus || c.rows.some((r) => priority(r) <= 3))
      .sort((a, b) => Math.min(...a.rows.map(priority)) - Math.min(...b.rows.map(priority)) || b.rows.length - a.rows.length);
  } else {
    cols = KANBAN_STATE_COLS.filter((c) => !(k.focus && c.quiet)).map((c) => ({ ...c, rows: rows.filter(c.test) }))
      .filter((c) => !["necesita_input", "sinver"].includes(c.key) || c.rows.length);
  }
  const ordered = (c) => {
    const ord = k.order[c.key] ?? [];
    return [...c.rows].sort((a, b) => {
      const ia = ord.indexOf(a.session_id), ib = ord.indexOf(b.session_id);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
      return byPriority(a, b);
    });
  };
  const all = [];
  const scrolls = [...host.querySelectorAll(".col")].map((c) => c.scrollTop);
  host.innerHTML = `<div class="tablero">${cols.map((c) => {
    const rs = ordered(c);
    all.push(...rs);
    const head = c.project ? `<span class="proj" style="--c:${projectColor(c.title)}"><i></i></span>` : icon(STATE_ICON[c.key] ?? "dot", { size: 14 });
    return `<section class="col" data-col="${esc(c.key)}"><h2>${head}${esc(c.title)}<span class="n">${rs.length}</span></h2>
      ${rs.map((r) => card(r, ctx.selectedId, !!c.project)).join("") || `<div class="empty" style="padding:20px">—</div>`}</section>`;
  }).join("")}</div>`;
  host.querySelectorAll(".col").forEach((c, i) => { c.scrollTop = scrolls[i] ?? 0; });
  ctx.setOrder(all.map((r) => r.session_id));
  wireDrag(host);
  host.querySelector(".tablero").onclick = (e) => {
    const c = e.target.closest(".card");
    if (c && !e.target.closest("a")) ctx.openDrawer(c.dataset.id);
  };
}

function card(r, selectedId, showState) {
  const s = summary(r);
  return `<div class="card ${r.session_id === selectedId ? "sel" : ""} ${r.unseen ? "unseen" : ""}" draggable="true" data-id="${esc(r.session_id)}" style="${colorVar(r)}" tabindex="0">
    <div class="ttl"><span style="flex:1">${esc(r.title)}</span>${r.pinned ? icon("pin", { size: 13 }) : ""}</div>
    <div class="meta">${showState ? statePill(r) : ""}${badges(r, { pin: false })}<span class="when">${whenText(r)}</span>${ctxBar(r.context_pct)}</div>
    ${s ? `<div class="txt ${s.kind}">${esc(s.text)}</div>` : ""}
    ${r.note ? `<div class="cardnote ${r.note_kind ? "k-" + r.note_kind : ""}" title="${esc(r.note)}">${icon("note", { size: 12 })}<span>${esc(plain(r.note))}</span></div>` : ""}
    <div class="chips">${settings.fields.proyecto && !showState ? projects(r) : ""}${chips(r)}</div>
  </div>`;
}

// Arrastrar para reordenar dentro de una columna (el estado lo decide la sesion, no el tablero).
function wireDrag(host) {
  let dragId = null;
  host.querySelectorAll(".card").forEach((c) => {
    c.addEventListener("dragstart", (e) => { dragId = c.dataset.id; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    c.addEventListener("dragend", () => { c.classList.remove("dragging"); host.querySelectorAll(".col").forEach((x) => x.classList.remove("drop")); });
  });
  host.querySelectorAll(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      const dragged = host.querySelector(`.card[data-id="${CSS.escape(dragId ?? "")}"]`);
      if (!dragged || dragged.closest(".col") !== col) return;
      e.preventDefault();
      col.classList.add("drop");
      const after = [...col.querySelectorAll(".card:not(.dragging)")].find((x) => e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
      if (after) col.insertBefore(dragged, after); else col.append(dragged);
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      const ids = [...col.querySelectorAll(".card")].map((x) => x.dataset.id);
      save((s) => { s.kanban.order[col.dataset.col] = ids; });
    });
  });
}

// ---------------- Archivos generados ----------------
const ASSET_FILTERS = [
  ["todos", "Todos", "layers", () => true],
  ["markdown", "Markdown", "note", (a) => a.type === "markdown"],
  ["html", "HTML", "grid", (a) => a.type === "html"],
  ["otros", "Otros", "file", (a) => a.type !== "markdown" && a.type !== "html"],
];
let selectedAsset = null;

export function archivos(host, rows, ctx) {
  const all = rows.flatMap((r) => (r.assets ?? []).map((a) => ({ ...a, session: r })))
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
  const kind = settings.assetType ?? "todos";
  const test = (ASSET_FILTERS.find((f) => f[0] === kind) ?? ASSET_FILTERS[0])[3];
  const list = all.filter(test);
  if (!host.querySelector(".bandeja.files-view")) {
    host.innerHTML = `<div class="bandeja files-view"><div class="list" id="alist"></div><div class="detail" id="apreview"></div></div>`;
  }
  const el = host.querySelector("#alist");
  const scroll = el.scrollTop;
  const day = (iso) => {
    const d = new Date(iso ?? 0); const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.floor((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    return diff <= 0 ? "Hoy" : diff === 1 ? "Ayer" : d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "short" });
  };
  let lastDay = "";
  el.innerHTML = `<div class="afilters">${ASSET_FILTERS.map(([k, label, ico, fn]) =>
      `<button class="chipfilter ${k === kind ? "on" : ""}" data-akind="${k}">${icon(ico, { size: 13 })}${label}<span class="mono muted">${all.filter(fn).length}</span></button>`).join("")}</div>` +
    (list.length ? list.map((a) => {
      const d = day(a.at);
      const head = d !== lastDay ? `<div class="section">${icon("clock", { size: 13 })}${esc(d)}</div>` : "";
      lastDay = d;
      return head + `<div class="item aitem ${selectedAsset === a.path ? "sel" : ""} ${a.exists ? "" : "gone"}" data-apath="${esc(a.path)}" style="${colorVar(a.session)}">
        <div class="strip"></div><span class="vtype ${a.type}" style="margin-top:2px">${icon(TYPE_ICON[a.type] ?? "file", { size: 14 })}</span>
        <div class="body">
          <div class="l1"><span class="ttl">${esc(a.name)}</span><span class="when">${whenOf(a.at)}</span></div>
          <div class="l2"><span class="txt mono" style="font-size:11px">${esc((a.rel ?? "").split("/").slice(0, -1).join("/") || a.path)}</span></div>
          <div class="l3"><span class="aop ${a.op}">${a.op}</span><span class="proj" style="--c:${projectColor(mainRepo(a.session))}"><i></i>${esc(a.session.title)}</span>${a.exists ? "" : `<span class="pill conflict">${icon("alert", { size: 12 })}ya no existe</span>`}</div>
        </div>
      </div>`;
    }).join("") : `<div class="empty">${icon("note", { size: 32 })}Ninguna sesión de esta vista generó archivos de este tipo.</div>`);
  el.scrollTop = scroll;
  ctx.setOrder([]);
  if ((!selectedAsset || !list.some((a) => a.path === selectedAsset)) && list[0]) selectedAsset = list[0].path;
  const sel = list.find((a) => a.path === selectedAsset);
  const pv = host.querySelector("#apreview");
  const sig = sel ? `${sel.path}|${sel.mtime}` : "";
  if (pv.dataset.sig !== sig) {
    pv.dataset.sig = sig;
    pv.innerHTML = sel ? `<div class="apv-head">
        <span class="vtype ${sel.type}">${icon(TYPE_ICON[sel.type] ?? "file", { size: 15 })}</span>
        <div class="vname"><b>${esc(sel.name)}</b><span class="mono muted">${esc(sel.rel ?? sel.path)}</span></div><span class="spacer"></span>
        <button class="btn" data-afull>${icon("external")}Pantalla completa <kbd>↵</kbd></button>
        <a class="btn" href="${esc(sel.vscode_url)}">${icon("external")}VS Code</a>
        <a class="btn ghost" href="${esc(sel.session.open_url)}" title="Abrir la sesión que lo generó">${icon("message")}Sesión</a>
      </div><div class="apv-body" id="apvbody"></div>` : `<div class="empty">${icon("note", { size: 32 })}Sin archivos.</div>`;
    if (sel) previewInto(sel, pv.querySelector("#apvbody"));
  }
  const openFull = () => sel && openViewer(sel, list);
  host.onclick = (e) => {
    const k = e.target.closest("[data-akind]");
    if (k) { save((s) => { s.assetType = k.dataset.akind; }); return; }
    if (e.target.closest("[data-afull]")) { openFull(); return; }
    const it = e.target.closest("[data-apath]");
    if (it && !e.target.closest("a")) { selectedAsset = it.dataset.apath; archivos(host, rows, ctx); }
  };
  host.ondblclick = (e) => { if (e.target.closest("[data-apath]")) openFull(); };
  ctx.assetNav = (d) => {
    const i = list.findIndex((a) => a.path === selectedAsset);
    const n = list[Math.max(0, Math.min(list.length - 1, i + d))];
    if (n) { selectedAsset = n.path; archivos(host, rows, ctx); host.querySelector(".aitem.sel")?.scrollIntoView({ block: "nearest" }); }
  };
  ctx.assetOpen = openFull;
}
const whenOf = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—");

import { proyectos } from "./proyectos.js";
export const VIEWS = { bandeja, tabla, tablero, archivos, proyectos };
