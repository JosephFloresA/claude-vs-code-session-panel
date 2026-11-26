// Piezas de interfaz compartidas por las tres vistas.
import { settings, projectColor, STATE_LABEL } from "./store.js";
import { icon, STATE_ICON } from "./icons.js";
import { assetList } from "./viewer.js";
import { renderMarkdown } from "./markdown.js";
import { attsHtml, hasAtts } from "./adjuntos.js";
import { getDraft } from "./borradores.js";
import { spBarHtml } from "./sesion-proyecto.js";

export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1).replace(".0", "")}h`;
  return `${Math.round(s / 86400)}d`;
}
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("es-CL", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—");

/** Markdown a texto plano de una linea (para listas y tarjetas). */
export function plain(s) {
  return String(s ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`]+/g, "")
    .replace(/(^|\s)[#>]+\s/g, "$1")
    .replace(/\|[\s|:-]*\|/g, " | ")
    .replace(/\s+/g, " ").trim();
}

/** Markdown de la conversacion en el detalle (mismo renderizador que el visor; enlaces relativos como texto). */
export function md(src, mentionBases) {
  // Todo nombre o ruta de archivo es clicable: si es un documento de la sesión (mentionBases) se previsualiza;
  // si no (p. ej. un .pptx que hizo un script), el servidor lo ubica y abre su carpeta.
  const mention = mentionBases ? (u) => {
    const s = String(u).trim();
    const b = s.split(/[\\/]/).pop();
    return b && /\.[a-z0-9]{1,6}$/i.test(b) && !/^[a-z]+:\/\//i.test(s) ? s : null;
  } : undefined;
  return renderMarkdown(src, { headingOffset: 2, resolve: () => null, mention });
}
export const assetBases = (r) => new Set((r?.assets ?? []).map((a) => a.path.split(/[\\/]/).pop().toLowerCase()));

export const mainRepo = (r) => r.repos[0] ?? r.workspace ?? null;
export const colorVar = (r) => `--c:${projectColor(mainRepo(r))}`;

export function statePill(r) {
  return `<span class="pill ${r.state}">${icon(STATE_ICON[r.state], { size: 13 })}${STATE_LABEL[r.state]}</span>`;
}

export function badges(r, { pin = true } = {}) {
  let h = "";
  if (r.unseen) h += `<span class="pill unseen" title="Terminó mientras no la mirabas">${icon("eye", { size: 13 })}sin ver</span>`;
  if (r.asks_question) h += `<span class="pill q" title="Su última respuesta termina en pregunta">${icon("question", { size: 13 })}te preguntó</span>`;
  if (r.conflicts?.length) h += `<span class="pill conflict" title="Otra sesión editó los mismos archivos">${icon("alert", { size: 13 })}conflicto</span>`;
  else if (r.repo_choques?.length) h += `<span class="pill esperando" title="Otra sesión abierta edita el mismo repo (${esc(r.repo_choques.map((c) => c.repo).join(", "))}): comparten árbol de trabajo y rama">${icon("branch", { size: 13 })}mismo repo</span>`;
  if (pin && r.pinned) h += `<span class="pill pinned" title="Fijada">${icon("pin", { size: 13 })}fijada</span>`;
  if (r.auto_accept) h += `<span class="pill autoacc" title="Aceptación automática activa: aprueba sola los permisos (menos preguntas)">${icon("zap", { size: 13 })}auto</span>`;
  return h;
}

export function projects(r) {
  const repos = r.repos.length ? r.repos : (r.workspace ? [r.workspace] : []);
  return repos.map((x) => `<span class="proj" style="--c:${projectColor(x)}"><i></i>${esc(x)}</span>`).join(" ");
}

export function ctxBar(p) {
  if (p == null || !settings.fields.contexto) return "";
  const lim = settings.thresholds.contextoPct;
  const cls = p >= lim ? "crit" : p >= lim - 20 ? "hi" : "";
  const tip = p >= lim ? "Cerca del límite: pronto se compacta y pierde detalle" : "Uso de la ventana de contexto";
  return `<span class="ctx ${cls}" title="${tip}"><span class="bar"><i style="width:${p}%"></i></span>${p}%</span>`;
}

// ---------- Git y PRs (los trae app.js desde /api/git) ----------
let GIT = { repos: {}, prs: {} };
export const setGit = (g) => { GIT = g ?? GIT; };
export const prOf = (p) => GIT.prs[`${p.repo}#${p.id}`];
export const reposOf = (r) => [...new Set([...(r.repos ?? []), r.workspace].filter(Boolean))].filter((x) => GIT.repos[x]).map((x) => [x, GIT.repos[x]]);
/** Resumen de trabajo sin subir en los repos de la sesion: cambios sin commit o commits sin push. */
export function gitDirty(r) {
  const items = reposOf(r).filter(([, g]) => g.changed || g.untracked || g.ahead);
  if (!items.length) return null;
  const changed = items.reduce((n, [, g]) => n + g.changed + g.untracked, 0);
  const ahead = items.reduce((n, [, g]) => n + g.ahead, 0);
  return {
    label: [changed && `${changed} sin commit`, ahead && `${ahead} sin push`].filter(Boolean).join(" · "),
    title: items.map(([n, g]) => `${n} (${g.branch}): ${g.changed} modificados, ${g.untracked} nuevos, ${g.ahead} commits sin push`).join("\n"),
  };
}

export function chips(r) {
  const f = settings.fields;
  let h = "";
  if (f.rama && r.git_branch && r.git_branch !== "HEAD") h += `<span class="chip">${icon("branch", { size: 12 })}${esc(r.git_branch)}</span>`;
  if (f.ab) h += r.work_items.map((w) => `<a class="chip ab" href="${esc(w.url)}" target="_blank" title="Work item en Azure DevOps">${icon("ticket", { size: 12 })}${w.id}</a>`).join("");
  if (f.git) {
    const dirty = gitDirty(r);
    if (dirty) h += `<span class="chip gitdirty" title="${esc(dirty.title)}">${icon("branch", { size: 12 })}${dirty.label}</span>`;
  }
  if (f.prs) h += r.prs.map((p) => {
    const st = prOf(p)?.state;
    return `<a class="chip pr pr-${st?.key ?? "cargando"}" href="${esc(p.url)}" target="_blank" title="PR ${p.id} en ${esc(p.repo)}${st ? " · " + esc(st.label) : ""}">${icon("pr", { size: 12 })}${p.id}${st && st.key !== "cargando" && st.key !== "error" ? ` <small>${esc(st.label.split(" ·")[0])}</small>` : ""}</a>`;
  }).join("");
  const docs = (r.assets ?? []).filter((a) => a.type === "markdown" || a.type === "html");
  if (f.archivos && docs.length) h += `<span class="chip doc" title="Documentos generados (.md / .html)">${icon("note", { size: 12 })}${docs.length}</span>`;
  if (f.archivos && r.edited_files.length) h += `<span class="chip" title="Archivos editados">${icon("file", { size: 12 })}${r.edited_files.length}</span>`;
  return h;
}

/** Linea "en que esta": { kind, icon, text } segun el estado. */
export function summary(r) {
  if (r.state === "necesita_input") return { kind: "need", icon: "hand", text: r.needs_input_detail ?? "Pide tu input" };
  if (r.state === "trabajando" && settings.fields.accion && r.last_action)
    return { kind: "act", icon: "terminal", text: `${r.last_action.tool}${r.last_action.label ? " · " + r.last_action.label : ""}` };
  if (settings.fields.respuesta && r.last_response) return { kind: "", icon: "message", text: plain(r.last_response) };
  if (settings.fields.pedido && r.last_prompt) return { kind: "", icon: "message", text: `Tú: ${plain(r.last_prompt)}` };
  return null;
}
export const summaryLine = (r) => summary(r)?.text ?? "";

export function whenText(r) {
  return r.state === "trabajando" && r.turn_started_at ? `${ago(r.turn_started_at)} trabajando` : ago(r.last_activity);
}

// ---------- Responder desde el panel ----------
/** Enlace que abre la sesion en VS Code con el texto ya escrito en su caja (la extension decide si lo envia). */
export const replyUrl = (r, text) => `${r.open_url}&prompt=${encodeURIComponent(text)}`;

/** Caja de respuesta fija bajo la conversacion (como un chat). */
function composer(r) {
  if (r.state === "cerrada" || r.state === "vacia") {
    return `<div class="composer closed"><span class="muted">La sesión está cerrada.</span><a class="btn" href="${esc(r.open_url)}" data-act="open">${icon("external")}Reabrir en VS Code</a></div>`;
  }
  const quick = settings.quickReplies ?? [];
  const live = !!r.pid && r.entrypoint === "claude-vscode";
  return `<div class="composer">
    ${r.state === "necesita_input" ? `<div class="permreq loading" data-permreq>${icon("hand", { size: 16 })}<span>${esc(r.needs_input_detail ?? "Esperando tu decisión")}…</span></div>` : ""}
    ${quick.length ? `<div class="quick">${quick.map((q, i) => `<button class="chipfilter" data-reply="${i}" title="Enviar: ${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}
    <div class="atts" data-atts="${esc(r.session_id)}" ${hasAtts(r.session_id) ? "" : "hidden"}>${attsHtml(r.session_id)}</div>
    <form class="replyform" data-replyform data-sid="${esc(r.session_id)}">
      <input type="file" multiple hidden data-attinput>
      <button class="btn ghost attbtn" type="button" data-attach title="Adjuntar archivos o imágenes (también Ctrl+V o arrastrar)" aria-label="Adjuntar">${icon("paperclip", { size: 18 })}</button>
      <textarea class="input" rows="1" placeholder="Responder a «${esc(r.title)}»…" data-replytext aria-label="Tu respuesta">${esc(getDraft(r.session_id))}</textarea>
      <button class="btn primary sendbtn" type="submit" title="Enviar (Enter)">${icon("send")}<span>Enviar</span></button>
    </form>
    <div class="c-hint muted"><kbd>Enter</kbd> envía · <kbd>Shift</kbd>+<kbd>Enter</kbd> nueva línea · <kbd>Ctrl</kbd>+<kbd>V</kbd> o arrastrar adjunta · ${live ? "se pega sola en la pestaña de VS Code" : "se abre en VS Code con el texto escrito"}</div>
  </div>`;
}

// ---------- Pedido de permiso/decisión (lo deduce el servidor del transcript; los hooks están bloqueados) ----------
const KIND_LABEL = { command: "Comando", edit: "Edición", plan: "Plan", choice: "Pregunta", tool: "Herramienta" };
const btnKeys = (keys, label, cls, extra = "") => `<button class="btn ${cls}" data-respond='${esc(JSON.stringify(keys))}' ${extra}>${label}</button>`;

function diffHtml(d) {
  if (!d) return "";
  const path = d.file_path ? `<div class="muted mono difffile">${esc(d.file_path)}</div>` : "";
  if (!d.old && d.new) return `${path}<pre class="cmd add">${esc(d.new)}</pre>`;
  return `${path}<div class="diffcols"><pre class="cmd del">${esc(d.old || "—")}</pre><pre class="cmd add">${esc(d.new || "—")}</pre></div>`;
}

/** Pinta el pedido pendiente en el hueco del composer, según su clasificación. */
export function renderPending(p, el, r) {
  if (!el) return;
  const live = !!r?.pid && r?.entrypoint === "claude-vscode";
  if (!p || p.pending === false) {
    // No se pudo leer un pedido del transcript: deja el aviso simple y dónde resolverlo.
    el.className = "permreq";
    el.innerHTML = `${icon("hand", { size: 16 })}<span>${esc(r?.needs_input_detail ?? "Esperando tu decisión")}. ${live ? "Apruébalo en VS Code o" : ""} ábrela para verlo.</span><span class="spacer"></span><a class="btn" href="${esc(r.open_url)}" data-act="open">${icon("external")}VS Code</a>`;
    return;
  }
  let body = "";
  if (p.kind === "command") body = `<pre class="cmd">${esc(p.detail?.command ?? "")}</pre>`;
  else if (p.kind === "edit") body = diffHtml(p.detail);
  else if (p.kind === "plan") body = `<pre class="cmd">${esc(p.detail?.plan ?? "")}</pre>`;
  else if (p.kind === "tool") body = `<pre class="cmd">${esc(p.detail?.input ?? "")}</pre>`;
  else if (p.kind === "choice") {
    body = (p.questions ?? []).map((q) => `<div class="pq"><b>${esc(q.question)}</b>${q.multiSelect ? ` <span class="muted">(elige varias)</span>` : ""}
      <ul class="popts">${q.options.map((o) => `<li><b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ""}</li>`).join("")}</ul></div>`).join("");
  }

  // Aprobar/Rechazar desde aquí SÍ funciona vía UI Automation (aprobar.ps1): encuentra el botón Yes/No del
  // webview y lo pulsa (InvokePattern o clic físico). Las teclas sintéticas no servían, pero el clic UIA sí.
  // Las preferencias (choice) se siguen eligiendo en VS Code: no son un botón binario.
  let actions;
  if (p.kind === "choice") {
    const q = (p.questions ?? [])[0];
    const auto = (p.questions ?? []).length === 1 && q && !q.multiSelect && (q.options ?? []).length;
    if (auto) {
      // Una sola pregunta de selección única: cada opción se elige y se envía por UIA (aprobar.ps1).
      actions = q.options.map((o) => `<button class="btn choose" data-choose="${esc(o.label)}" title="${esc(o.description ?? o.label)}">${esc(o.label)}</button>`).join("")
        + `<a class="btn ghost" href="${esc(r.open_url)}" data-act="open">${icon("external")}Abrir</a>`
        + `<span class="pr-tip">Se elige la opción y se envía en VS Code por ti.</span>`;
    } else {
      actions = `<a class="btn primary" href="${esc(r.open_url)}" data-act="open">${icon("external")}Elegir en VS Code</a>`
        + `<span class="pr-tip">${q?.multiSelect ? "Selección múltiple" : "Varias preguntas"}: respóndela en VS Code.</span>`;
    }
  } else {
    actions = `${btnKeys(["1"], `${icon("check")}Aprobar`, "primary")}${btnKeys(["2"], `${icon("x")}Rechazar`, "danger")}
      <a class="btn ghost" href="${esc(r.open_url)}" data-act="open">${icon("external")}Abrir</a>
      <span class="pr-tip">Se pulsa el botón del diálogo en VS Code por ti.</span>`;
  }

  // Laboratorio de teclas (?debugteclas=1): prueba combinaciones en vivo sobre el diálogo real.
  const dbg = window.__dbgteclas ? `<div class="pr-dbg">
      <div class="muted">🔬 Laboratorio de teclas (manda estas teclas al diálogo):</div>
      <div class="pr-dbgrow">
        ${["a", "1", "2", "enter", "esc", "down,1", "down,2", "up,1", "down,enter", "tab,1", "tab,enter", "down,down,1"]
          .map((c) => `<button class="btn" data-dbgcombo="${esc(c)}">${esc(c)}</button>`).join("")}
      </div>
      <div class="pr-dbgrow"><input class="input" data-dbgkeys placeholder="p. ej. down,down,enter" style="flex:1">
        <button class="btn primary" data-dbgsend>Probar</button></div>
      <div class="muted" style="font-size:11px">La sonda <b>a</b> escribe una «a»: si aparece en el cuadro «Tell Claude what to do instead», las teclas sí llegan ahí.</div>
    </div>` : "";

  el.className = `permreq ${p.kind}`;
  el.innerHTML = `<div class="pr-top">${icon("hand", { size: 16 })}<b>${esc(p.summary)}</b>
      <span class="pr-kind">${KIND_LABEL[p.kind] ?? p.tool}</span>
      ${p.manual ? `<span class="pr-you" title="Es una preferencia: la decides tú">tú decides</span>` : ""}</div>
    ${body ? `<div class="pr-body">${body}</div>` : ""}
    <div class="pr-actions">${actions}</div>${dbg}`;
}

/** Muestra al instante tu mensaje en el chat mientras se envia (se reemplaza al releer la conversacion). */
export function showPending(text) {
  document.querySelectorAll(".timeline").forEach((tl) => {
    if (!tl.isConnected) return;
    tl.insertAdjacentHTML("beforeend", `<div class="turn pending"><div class="bubble me"><div class="who">Tú <span>enviando…</span></div>${esc(text)}</div></div>`);
    const body = tl.closest(".d-body");
    if (body) body.scrollTop = body.scrollHeight;
  });
}

function gitBox(r) {
  const repos = reposOf(r);
  const prList = settings.fields.prs ? r.prs : [];
  if (!settings.fields.git || (!repos.length && !prList.length)) return "";
  const rows = repos.map(([name, g]) => {
    const pend = [g.changed && `${g.changed} modificados`, g.untracked && `${g.untracked} nuevos`, g.ahead && `${g.ahead} sin push`, g.behind && `${g.behind} atrás de ${esc(g.upstream ?? "origen")}`].filter(Boolean);
    return `<div class="gitrow"><span class="proj" style="--c:${projectColor(name)}"><i></i>${esc(name)}</span>
      <span class="chip">${icon("branch", { size: 12 })}${esc(g.branch ?? "—")}</span>
      ${pend.length ? `<span class="${g.changed || g.untracked || g.ahead ? "warntext" : "muted"}">${pend.join(" · ")}</span>` : `<span class="muted">al día</span>`}
      ${g.last ? `<span class="muted mono" title="${esc(g.last.subject)}">${esc(g.last.hash)} · ${esc(g.last.when)}</span>` : ""}</div>`;
  }).join("");
  const prRows = prList.map((p) => {
    const d = prOf(p);
    const st = d?.state ?? { key: "cargando", label: "consultando…" };
    return `<div class="gitrow"><span class="pill prpill pr-${st.key}">${icon("pr", { size: 12 })}${esc(st.label)}</span>
      <a href="${esc(p.url)}" target="_blank" class="prtitle">!${p.id} ${esc(d?.title ?? p.repo)}</a>
      <span class="muted mono">${esc(p.repo)}${d?.target ? " → " + esc(d.target.replace("refs/heads/", "")) : ""}</span></div>`;
  }).join("");
  return `<div class="box"><h3>${icon("branch")}Git y pull requests</h3>${rows}${prRows}</div>`;
}

// ---------- Detalle (bandeja y panel lateral) ----------
const detailCache = new Map();
const stat = (ico, label, value, cls = "") => `<div><dt>${icon(ico)}${label}</dt><dd class="${cls}" title="${esc(String(value).replace(/<[^>]+>/g, ""))}">${value}</dd></div>`;

/** Firma de lo que cambia el detalle desde fuera (git/PR), para saber cuando redibujar. */
export const gitSig = (r) => JSON.stringify([reposOf(r).map(([n, g]) => [n, g.branch, g.changed, g.untracked, g.ahead, g.behind]), r.prs.map((p) => prOf(p)?.state?.key)]);

// Pestaña activa del detalle: vuelve a "chat" al cambiar de sesion.
let dTab = "chat";
let dTabFor = null;
// Modo lectura: el detalle ocupa toda la pantalla (clase en <body>; el CSS elige el detalle visible).
let reading = false;
export const isReading = () => reading;
export function setReading(on) {
  reading = !!on;
  const body = document.querySelector(".drawer.open .d-body, #detail .d-body");
  const atBottom = body && body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  document.body.classList.toggle("reading", reading);
  document.querySelectorAll("[data-act='read']").forEach((b) => {
    b.innerHTML = icon(reading ? "minimize" : "maximize");
    b.title = reading ? "Salir del modo lectura (f o Esc)" : "Modo lectura: conversación a pantalla completa (f)";
  });
  if (body && atBottom) body.scrollTop = body.scrollHeight;
}
const ibtn = (act, ico, label, key, extra = "") => `<button class="btn ghost icon" data-act="${act}" title="${label}${key ? ` (${key})` : ""}" aria-label="${label}" ${extra}>${icon(ico)}</button>`;

export function renderDetail(r, host) {
  const same = host.dataset.rid === (r?.session_id ?? "") && !!r;
  // Conservar lo que estabas escribiendo, la conversacion ya cargada y la posicion del scroll.
  const prevTa = host.querySelector("[data-replytext]");
  const keep = same && prevTa ? { text: prevTa.value, focus: document.activeElement === prevTa, sel: prevTa.selectionStart } : null;
  const prevBody = host.querySelector(".d-body");
  const prevTl = same ? host.querySelector("#tl")?.innerHTML : null;
  const scroll = same && prevBody ? { top: prevBody.scrollTop, bottom: prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight < 40 } : null;
  if (!same || dTabFor !== r?.session_id) { dTab = "chat"; dTabFor = r?.session_id ?? null; }
  host.dataset.rid = r?.session_id ?? "";
  host.classList.add("chatmode");
  renderDetailInner(r, host, { prevTl, scroll });
  if (keep) {
    const ta = host.querySelector("[data-replytext]");
    if (ta) { ta.value = keep.text; autoGrow(ta); if (keep.focus) { ta.focus(); ta.setSelectionRange(keep.sel, keep.sel); } }
  } else {
    // Otra sesión: el composer ya trae su borrador (borradores.js); solo falta ajustar el alto.
    const ta = host.querySelector("[data-replytext]");
    if (ta?.value) autoGrow(ta);
  }
  host.onclick = (e) => {
    const old = e.target.closest("[data-older]");
    if (old && r) {
      turnosDe.set(r.session_id, (turnosDe.get(r.session_id) ?? 8) + 30);
      old.disabled = true; old.textContent = "Cargando…";
      const tl = host.querySelector("#tl");
      if (tl) { tl.dataset.older = "1"; loadTimeline(r, tl, false); }
      return;
    }
    const t = e.target.closest("[data-dtab]");
    if (!t || !r) return;
    dTab = t.dataset.dtab;
    renderDetail(r, host);
  };
  host.oninput = (e) => { if (e.target.matches("[data-replytext]")) autoGrow(e.target); };
}

export function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`;
}

function renderDetailInner(r, host, { prevTl, scroll }) {
  if (!r) { host.innerHTML = `<div class="empty">${icon("inbox", { size: 32 })}Elige una sesión de la lista.</div>`; return; }
  const f = settings.fields;
  const files = r.edited_files.map((x) => x.file.split(/[\\/]/).slice(-3).join("/"));
  const nFiles = (r.assets?.length ?? 0) + (f.archivos ? files.length : 0);
  const working = r.state === "trabajando";
  const meta = [
    `<span title="${esc(fmtTime(r.last_activity))}">${icon("clock", { size: 12 })}${whenText(r)}</span>`,
    r.model ? `<span class="mono">${esc(r.model.replace("claude-", ""))}</span>` : "",
    r.context_pct != null ? ctxBar(r.context_pct) : "",
  ].filter(Boolean).join("");
  const tabs = [["chat", "Conversación", ""], ["info", "Detalles", r.conflicts?.length || r.repo_choques?.length ? "!" : ""], ["files", "Archivos", nFiles || ""]];

  let body;
  if (dTab === "info") body = infoPane(r, f);
  else if (dTab === "files") body = filesPane(r, f, files);
  else body = `<div class="timeline" id="tl">${prevTl ?? `<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:90%;align-self:flex-end"></div><div class="skeleton" style="width:55%"></div>`}</div>
    ${working ? `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>Claude está trabajando${r.last_action ? ` · <span class="mono">${esc(r.last_action.tool)}${r.last_action.label ? " " + esc(r.last_action.label) : ""}</span>` : ""}</div>` : ""}`;

  host.innerHTML = `<div class="d-wrap">
    <header class="d-head">
      <div class="d-eyebrow">${statePill(r)}${badges(r)}${f.proyecto ? projects(r) : ""}</div>
      <div class="d-titlerow">
        <h1 class="d-title" title="${esc(r.title)}">${esc(r.title)}</h1>
        <div class="d-actions">
          ${r.unseen ? ibtn("seen", "check", "Marcar como vista", "v") : ""}
          ${ibtn("pin", "pin", r.pinned ? "Soltar" : "Fijar", "p", r.pinned ? `data-on="1"` : "")}
          ${ibtn("note", "note", "Nota", "n")}
          ${ibtn("autoaccept", "zap", r.auto_accept ? "Aceptación automática: ACTIVA (clic para apagar)" : "Aceptar automáticamente los permisos de esta sesión (menos preguntas)", "", r.auto_accept ? `data-on="1"` : "")}
          ${ibtn("rename", "pencil", "Renombrar", "r")}
          ${ibtn(r.archived ? "unarchive" : "archive", r.archived ? "unarchive" : "archive", r.archived ? "Desarchivar" : "Archivar", "a")}
          ${ibtn("copy", "copy", `Copiar claude --resume ${r.session_id}`, "c")}
          <button class="btn ghost icon readbtn" data-act="read" title="${reading ? "Salir del modo lectura (f o Esc)" : "Modo lectura: conversación a pantalla completa (f)"}" aria-label="Modo lectura">${icon(reading ? "minimize" : "maximize")}</button>
          <button class="btn" data-act="terminar" title="Terminé con esta sesión: guarda la conversación en su hilo, actualiza la ficha del proyecto${r.pid && r.entrypoint === "claude-vscode" ? " y cierra la pestaña en VS Code" : ""}">${icon("flag")}Terminar</button>
          <a class="btn primary" href="${esc(r.open_url)}" data-act="open" title="Abrir en VS Code (Enter en la lista)">${icon("external")}VS Code</a>
        </div>
      </div>
      <div class="d-meta">${meta}<span class="d-chips">${chips(r)}</span></div>
      ${spBarHtml(r)}
      <nav class="d-tabs" role="tablist">${tabs.map(([k, l, n]) => `<button role="tab" data-dtab="${k}" class="${k === dTab ? "on" : ""}" aria-selected="${k === dTab}">${l}${n !== "" ? `<span class="n${n === "!" ? " warn" : ""}">${n}</span>` : ""}</button>`).join("")}</nav>
    </header>
    <div class="d-body ${dTab === "chat" ? "chat" : ""}">${body}</div>
    ${dTab === "chat" ? composer(r) : ""}
  </div>`;

  const bodyEl = host.querySelector(".d-body");
  if (dTab === "chat") {
    const stick = !scroll || scroll.bottom;
    if (stick) bodyEl.scrollTop = bodyEl.scrollHeight; else bodyEl.scrollTop = scroll.top;
    loadTimeline(r, host.querySelector("#tl"), stick);
    if (r.state === "necesita_input") loadPending(r, host.querySelector("[data-permreq]"));
  } else if (scroll) bodyEl.scrollTop = scroll.top;
}

const pendingCache = new Map();
async function loadPending(r, el) {
  if (!el) return;
  // Cache corta por última actividad: el pedido no cambia hasta que la sesión avanza.
  const key = `${r.session_id}:${r.last_activity}`;
  let p = pendingCache.get(key);
  if (p === undefined) {
    try { p = await (await fetch(`/api/sesiones/${r.session_id}/pendiente`, { cache: "no-store" })).json(); }
    catch { p = null; }
    if (pendingCache.size > 30) pendingCache.clear();
    pendingCache.set(key, p);
  }
  if (el.isConnected) renderPending(p, el, r);
}

// Estado del proyecto que lleva la nota, con su color (via clase k-<kind> en CSS). Orden = orden de los presets.
export const NOTE_KIND_META = {
  bloqueo: { label: "Bloqueo" },
  validacion: { label: "En validación" },
  listo: { label: "Listo" },
  info: { label: "Info" },
};

/** Caja de Estado/Nota en el panel de detalles: presets de estado (color) + texto libre. */
function noteBox(r) {
  const presets = Object.entries(NOTE_KIND_META)
    .map(([k, m]) => `<button class="notekind k-${k} ${r.note_kind === k ? "on" : ""}" data-notekind="${k}" title="Marcar como ${esc(m.label)}">${esc(m.label)}</button>`)
    .join("");
  const text = r.note
    ? `<div class="notetext ${r.note_kind ? "k-" + r.note_kind : ""}">${esc(r.note)}</div>`
    : `<div class="muted" style="font-size:12.5px">Sin nota. Elige un estado o escribe una.</div>`;
  return `<div class="box note">
    <h3>${icon("note")}Estado / Nota<span class="spacer"></span>
      <button class="btn ghost icon" data-act="note" title="Editar texto (n)">${icon("pencil", { size: 14 })}</button>
      ${r.note || r.note_kind ? `<button class="btn ghost icon" data-act="noteclear" title="Quitar estado y nota">${icon("x", { size: 14 })}</button>` : ""}
    </h3>
    <div class="notekinds">${presets}</div>
    ${text}</div>`;
}

function infoPane(r, f) {
  return `<div class="panepad">
    ${r.conflicts?.length ? `<div class="box warn"><h3>${icon("alert")}Otra sesión editó los mismos archivos</h3>${r.conflicts.map((c) =>
      `<div class="mono">${esc(c.file)}</div><div style="margin:2px 0 8px">con ${c.with.map((w) => `<a href="${esc(w.open_url)}">${esc(w.title)}</a>`).join(", ")}</div>`).join("")}</div>` : ""}
    ${r.repo_choques?.length ? `<div class="box warn"><h3>${icon("branch")}Otra sesión abierta edita el mismo repo</h3>
      <div class="muted small" style="margin-bottom:6px">Comparten árbol de trabajo y rama: un commit de una puede llevarse los cambios de la otra. Coordinen antes de commitear.</div>
      ${r.repo_choques.map((c) => `<div class="mono">${esc(c.repo)}</div><div style="margin:2px 0 8px">con ${c.with.map((w) =>
        `<a href="${esc(w.open_url)}" title="${esc(w.archivos.join("\n"))}">${esc(w.title)}</a> <span class="muted small">(${w.archivos.length} archivo${w.archivos.length > 1 ? "s" : ""})</span>`).join(", ")}</div>`).join("")}</div>` : ""}
    ${f.nota ? noteBox(r) : ""}
    <dl class="stats">
      ${stat("clock", "Actividad", `${whenText(r)} · ${fmtTime(r.last_activity)}`)}
      ${stat("sparkles", "Inició", fmtTime(r.started_at))}
      ${r.last_action ? stat("terminal", "Última acción", `${esc(r.last_action.tool)} ${esc(r.last_action.label ?? "")}`) : ""}
      ${r.context_pct != null ? stat("layers", "Contexto", ctxBar(r.context_pct) || `${r.context_pct}%`) : ""}
      ${r.git_branch && r.git_branch !== "HEAD" ? stat("branch", "Rama", esc(r.git_branch), "mono") : ""}
      ${stat("sparkles", "Modelo", esc((r.model ?? "—").replace("claude-", "")), "mono")}
      ${stat("file", "Transcript", `${r.transcript_mb ?? "—"} MB · ${esc(r.short_id)}`, "mono")}
    </dl>
    ${gitBox(r)}
    ${f.ab && r.work_items.length ? `<div class="box"><h3>${icon("ticket")}Work items</h3><div style="display:flex;gap:6px;flex-wrap:wrap">${r.work_items.map((w) => `<a class="chip ab" href="${esc(w.url)}" target="_blank">${icon("ticket", { size: 12 })}AB#${w.id}</a>`).join("")}</div></div>` : ""}
  </div>`;
}

function filesPane(r, f, files) {
  const parts = [];
  if (r.assets?.length) parts.push(`<div class="box"><h3>${icon("note")}Generados · ${r.assets.length}<span class="spacer"></span><span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">clic para ver</span></h3>${assetList(r.assets)}</div>`);
  if (f.archivos && files.length) parts.push(`<div class="box"><h3>${icon("file")}Editados · ${files.length}</h3><ul class="files">${files.map((x) => `<li title="${esc(x)}">${esc(x)}</li>`).join("")}</ul></div>`);
  return `<div class="panepad">${parts.join("") || `<div class="empty">${icon("file", { size: 30 })}Esta sesión todavía no generó ni editó archivos.</div>`}</div>`;
}

// Cuantos intercambios se muestran por sesion: 8 al abrir; «Cargar anteriores» suma de a 30.
const turnosDe = new Map();
async function loadTimeline(r, el, stick = true) {
  const n = turnosDe.get(r.session_id) ?? 8;
  const key = `${r.session_id}:${r.last_activity}:${n}`;
  let d = detailCache.get(key);
  if (!d) {
    try { d = await (await fetch(`/api/sesiones/${r.session_id}/detalle?turnos=${n}`, { cache: "no-store" })).json(); }
    catch { el.innerHTML = `<div class="muted">No se pudo leer la conversación.</div>`; return; }
    if (detailCache.size > 20) detailCache.clear();
    detailCache.set(key, d);
  }
  if (!el.isConnected) return;
  const body = el.closest(".d-body");
  const atBottom = body && body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  if (!d.turns.length) { el.innerHTML = `<div class="muted">Sin intercambios todavía.</div>`; return; }
  const bases = assetBases(r);
  const fromBottom = body ? body.scrollHeight - body.scrollTop : 0;
  el.innerHTML = (d.hay_mas ? `<div class="tl-older muted">Se muestran los últimos ${d.turns.length} intercambios · <button class="btn small" data-older="${esc(r.session_id)}">${icon("clock", { size: 12 })}Cargar anteriores</button></div>` : d.turns.length >= 6 ? `<div class="tl-older muted">Inicio de la conversación · ${d.turns.length} intercambios</div>` : "") + d.turns.map((t) => `<div class="turn">
    <div class="bubble me"><div class="who">Tú <span>${fmtTime(t.at)}</span></div>${esc(t.prompt)}</div>
    ${t.tool_count ? `<details class="tools"><summary>${icon("terminal", { size: 14 })}${t.tool_count} acciones con herramientas</summary><ul>${t.tools.map((x) => `<li>${esc(x.tool)}${x.label ? " · " + esc(x.label) : ""}</li>`).join("")}</ul></details>` : ""}
    ${t.reply ? `<div class="bubble ai"><div class="who">Claude <span>${fmtTime(t.end_at)}</span></div><div class="md">${md(t.reply, bases)}</div></div>` : ""}
  </div>`).join("");
  if (body && (stick || atBottom)) body.scrollTop = body.scrollHeight;
  else if (body && el.dataset.older) body.scrollTop = body.scrollHeight - fromBottom;   // al cargar anteriores, no saltar
  delete el.dataset.older;
}

export function toast(text, ico = "check") {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.innerHTML = `${icon(ico)}<span>${esc(text)}</span>`;
  document.body.append(t);
  setTimeout(() => t.remove(), 2000);
}
