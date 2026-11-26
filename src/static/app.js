// Controlador del panel: datos, filtros y vistas guardadas, seleccion multiple, acciones, atajos y avisos.
import "./token.js";   // primero: envoltorio de fetch que renueva el token si el panel se reinicio
import { settings, save, onChange, allViews, applyTheme, projectColor, STATE_LABEL, STATES } from "./store.js";
import { hasAtts, uploadAtts, clearAtts, withAtts } from "./adjuntos.js";
import { clearDraft, setDraft } from "./borradores.js";
import { $, esc, toast, mainRepo, renderDetail, setGit, gitSig, replyUrl, showPending, autoGrow, isReading, setReading, NOTE_KIND_META } from "./ui.js";
import { openDay } from "./dia.js";
import { openSearch, initSearch } from "./buscar.js";
import { VIEWS } from "./views.js";
import { openSettings, closeSettings } from "./settings.js";
import { icon, VIEW_ICON } from "./icons.js";
import { openViewer } from "./viewer.js";
import { TOKEN, loadPerms, initPerms } from "./perms.js";
import { openVs } from "./abrir.js";
import { setRowsSource, terminarSesion } from "./sesion-proyecto.js";

const state = {
  data: null,
  selectedId: null,
  order: [],
  drawerId: null,
  picked: new Set(),                              // seleccion multiple para acciones en lote
  adhoc: { states: [], repos: [], noteKinds: [], text: "" },     // filtros de la barra, encima de la vista activa
  prev: null,                                     // estados anteriores, para detectar transiciones
  extra: new Map(),                               // sesiones abiertas en el panel que no estan en la lista (viejas o cerradas)
};
// Fila de una sesion: de la lista, o la traida aparte para abrir su chat en el panel.
const rowOf = (id) => state.data?.sessions.find((r) => r.session_id === id) ?? state.extra.get(id);

// ---------------- Datos ----------------
async function load() {
  const t = settings.thresholds;
  const q = new URLSearchParams({ hours: t.cerradasH, pausa_h: t.pausaH, conflicto_h: t.conflictoH });
  if (settings.showArchived) q.set("archivadas", "1");
  try {
    const res = await fetch(`/api/sesiones?${q}`, { cache: "no-store" });
    state.data = await res.json();
    // La sesion abierta aparte (fuera de la lista) tambien se refresca: puede seguir viva en otro lado.
    const xid = state.drawerId;
    if (xid && state.extra.has(xid) && !state.data.sessions.some((r) => r.session_id === xid)) {
      try { const fr = await fetch(`/api/sesiones/${xid}/fila`, { cache: "no-store" }); if (fr.ok) state.extra.set(xid, await fr.json()); } catch {}
    }
    setStatus(`en vivo · ${new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, false);
    notify();
    render();
    loadPerms(state.data.sessions, push);
  } catch {
    setStatus("sin conexión con el servidor", true);
  }
}
function setStatus(text, err) {
  $("#status").innerHTML = `<span class="live"></span>${esc(text)}`;
  $("#status").classList.toggle("err", err);
}

// ---------------- Filtros ----------------
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
function matches(r, f) {
  if (f.states?.length && !f.states.includes(r.state)) return false;
  if (f.repos?.length && !f.repos.some((x) => r.repos.includes(x) || r.workspace === x)) return false;
  if (f.noteKinds?.length && !f.noteKinds.includes(r.note_kind)) return false;
  if (f.pending && !(r.state === "necesita_input" || r.state === "esperando" || r.unseen)) return false;
  if (f.onlyUnseen && !r.unseen) return false;
  if (f.onlyPinned && !r.pinned) return false;
  if (f.today && Date.parse(r.last_activity ?? 0) < today0()) return false;
  if (f.text) {
    const hay = [r.title, r.auto_title, r.repos.join(" "), r.last_prompt, r.last_response, r.note, r.short_id,
      r.work_items.map((w) => "ab#" + w.id + " " + w.id).join(" "), r.prs.map((p) => p.repo + " " + p.id).join(" ")].join(" ").toLowerCase();
    if (!f.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
const activeView = () => allViews().find((v) => v.id === settings.activeView) ?? allViews()[0];
const visibleRows = () => {
  const v = activeView();
  return (state.data?.sessions ?? []).filter((r) => matches(r, v.filter) && matches(r, state.adhoc));
};

// ---------------- Render ----------------
function render() {
  if (!state.data) return;
  const all = state.data.sessions;
  const rows = visibleRows();
  const ids = new Set(all.map((r) => r.session_id));
  for (const id of [...state.picked]) if (!ids.has(id)) state.picked.delete(id);
  const count = (fn) => all.filter(fn).length;
  const nNeeds = count((r) => r.state === "necesita_input"), nUnseen = count((r) => r.unseen);
  const nTurn = count((r) => r.state === "esperando"), nWork = count((r) => r.state === "trabajando");

  $("#kpis").innerHTML = [
    ["necesita_input", nNeeds, "te necesitan", "hand", "Pidieron permiso o una respuesta"],
    ["unseen", nUnseen, "sin ver", "eye", "Terminaron mientras no las mirabas"],
    ["esperando", nTurn, "tu turno", "message", "Terminaron y esperan tu respuesta"],
    ["trabajando", nWork, "trabajando", "activity", "Trabajando ahora"],
  ].map(([k, n, l, ico, tip]) => `<button class="kpi ${k} ${n ? "" : "zero"}" data-quick="${k}" title="${tip}"><span class="ico">${icon(ico, { size: 15 })}</span><b>${n}</b><span>${l}</span></button>`).join("");

  $("#tabs").innerHTML = allViews().map((v, i) => {
    const n = all.filter((r) => matches(r, v.filter)).length;
    return `<button class="tab ${v.id === activeView().id ? "on" : ""}" data-view="${esc(v.id)}" title="Atajo: ${i + 1}">${icon(VIEW_ICON[v.id] ?? "star", { size: 14 })}${esc(v.name)}<span class="n">${n}</span></button>`;
  }).join("");

  const repos = [...new Set(all.map(mainRepo).filter(Boolean))].sort();
  const kinds = Object.keys(NOTE_KIND_META).filter((k) => all.some((r) => r.note_kind === k));
  $("#chipfilters").innerHTML =
    STATES.filter((s) => all.some((r) => r.state === s)).map((s) =>
      `<button class="chipfilter ${state.adhoc.states.includes(s) ? "on" : ""}" data-fstate="${s}"><span class="dot ${s}"></span>${STATE_LABEL[s]}</button>`).join("") +
    (kinds.length ? `<span class="sep"></span>` + kinds.map((k) =>
      `<button class="chipfilter notekindchip k-${k} ${state.adhoc.noteKinds.includes(k) ? "on" : ""}" data-fkind="${k}"><span class="ndot"></span>${esc(NOTE_KIND_META[k].label)}</button>`).join("") : "") +
    `<span class="sep"></span>` +
    repos.map((x) => `<button class="chipfilter ${state.adhoc.repos.includes(x) ? "on" : ""}" data-frepo="${esc(x)}"><span class="proj" style="--c:${projectColor(x)}"><i></i></span>${esc(x)}</button>`).join("");
  const dirty = state.adhoc.states.length || state.adhoc.repos.length || state.adhoc.noteKinds.length || state.adhoc.text;
  $("#save-view").classList.toggle("hidden", !dirty);
  $("#clear-filters").classList.toggle("hidden", !dirty);

  const conf = all.filter((r) => r.conflicts?.length && r.state !== "cerrada");
  $("#banner").innerHTML = conf.length ? `<div class="banner">${icon("alert")}<span><b>${conf.length} sesiones</b> editaron los mismos archivos: ${conf.map((r) =>
    `<a href="#" data-goto="${esc(r.session_id)}">${esc(r.title)}</a>`).join(", ")}. Revisa antes de commitear.</span></div>` : "";

  document.querySelectorAll("#layout button").forEach((b) => b.classList.toggle("on", b.dataset.layout === settings.layout));
  $("#btn-bell").innerHTML = icon(settings.notify.enabled ? "bell" : "bellOff");
  $("#btn-bell").classList.toggle("on", settings.notify.enabled);

  const host = $("#main");
  if (host.dataset.layout !== settings.layout) { host.innerHTML = ""; host.dataset.layout = settings.layout; }
  if (state.selectedId && !rows.some((r) => r.session_id === state.selectedId)) state.selectedId = null;
  VIEWS[settings.layout](host, rows, ctx);

  if (state.drawerId) {
    const r = rowOf(state.drawerId);
    const body = $("#drawer .db");
    const sig = r ? `${r.session_id}|${r.last_activity}|${r.state}|${r.unseen}|${r.pinned}|${r.note}|${r.note_kind}|${r.auto_accept}|${r.title}|${gitSig(r)}|${(settings.quickReplies ?? []).join("¦")}` : "";
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; renderDetail(r, body); }
  }
  renderBulk();

  document.title = `${nNeeds ? "(!) " : ""}(${nNeeds + nTurn + nUnseen}) Sesiones de Claude`;
  favicon(nNeeds ? "#f87171" : nUnseen ? "#a78bfa" : nTurn ? "#fbbf24" : "#22c55e", nNeeds + nUnseen || nTurn);
}

function renderBulk() {
  const n = state.picked.size;
  let bar = $("#bulkbar");
  if (!n) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "bulkbar"; bar.className = "bulkbar"; document.body.append(bar); }
  bar.innerHTML = `<b>${n}</b><span class="lbl">seleccionada${n > 1 ? "s" : ""}</span>
    <button class="btn" data-bulk="seen">${icon("checkAll")}Marcar vistas</button>
    <button class="btn" data-bulk="pin">${icon("pin")}Fijar</button>
    <button class="btn" data-bulk="unpin">${icon("pin")}Soltar</button>
    <button class="btn" data-bulk="archive">${icon("archive")}Archivar</button>
    <button class="btn ghost icon" data-bulk="clear" title="Quitar selección (Esc)">${icon("x")}</button>`;
}

const ctx = {
  get selectedId() { return state.selectedId; },
  get picked() { return state.picked; },
  select(id, { silent = false } = {}) { state.selectedId = id; if (!silent) render(); },
  setOrder(ids) { state.order = ids; },
  togglePick(id) { if (state.picked.has(id)) state.picked.delete(id); else state.picked.add(id); render(); },
  pickMany(ids, on) { for (const id of ids) on ? state.picked.add(id) : state.picked.delete(id); render(); },
  openDrawer(id) {
    state.selectedId = id;
    state.drawerId = id;
    $("#drawer").classList.add("open");
    $("#scrim").classList.remove("hidden");
    $("#drawer .db").dataset.sig = "";
    render();
  },
  /** Abre la conversacion de una sesion en el panel lateral, aunque no este en la lista (vieja o cerrada). */
  async openChat(id) {
    id = String(id ?? "").toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(id)) return false;
    if (!state.data?.sessions.some((r) => r.session_id === id)) {
      try {
        const res = await fetch(`/api/sesiones/${id}/fila`, { cache: "no-store" });
        if (!res.ok) { toast("No encontré esa sesión en este equipo", "alert"); return false; }
        state.extra.set(id, await res.json());
        if (state.extra.size > 20) state.extra.delete(state.extra.keys().next().value);
      } catch (e) { toast(`No se pudo abrir la sesión: ${e.message}`, "alert"); return false; }
    }
    ctx.openDrawer(id);
    return true;
  },
};
function closeDrawer() {
  if (isReading() && state.drawerId) setReading(false);
  state.drawerId = null;
  $("#drawer").classList.remove("open");
  if (!$("#settings").classList.contains("open")) $("#scrim").classList.add("hidden");
}

// ---------------- Acciones ----------------
const current = () => rowOf(state.drawerId ?? state.selectedId);
setRowsSource(() => state.data?.sessions ?? []);

/** Abre en el Explorador la carpeta de un archivo que la sesion menciona, con el archivo seleccionado. */
async function revealFile(r, nombre) {
  const name = nombre.split(/[\\/]/).pop();
  try {
    const j = await (await fetch(`/api/sesiones/${r.session_id}/revelar`, { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify({ nombre }) })).json();
    if (j.ok) toast(`Carpeta abierta: ${j.dir}`, "external");
    else toast(j.reason === "no_encontrado" ? `No encontré «${name}» en este equipo (ni en la conversación ni en su carpeta)` : `No se pudo abrir la carpeta (${j.reason ?? j.error})`, "alert");
  } catch (err) { toast(`No se pudo abrir la carpeta: ${err.message}`, "alert"); }
}

async function postMeta(id, patch) {
  await fetch(`/api/sesiones/${id}/meta`, { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify(patch) });
}
async function setMeta(id, patch) { await postMeta(id, patch); await load(); }

async function act(name, r = current()) {
  if (!r) return;
  switch (name) {
    case "read": setReading(!isReading()); break;
    case "open": if (r.unseen) postMeta(r.session_id, { seen: true }); openVs(r.open_url); break;
    case "seen": await setMeta(r.session_id, { seen: true }); toast("Marcada como vista"); break;
    case "pin": await setMeta(r.session_id, { pinned: !r.pinned }); toast(r.pinned ? "Soltada" : "Fijada arriba", "pin"); break;
    case "archive": await setMeta(r.session_id, { archived: true }); toast("Archivada: vuelve sola si tiene actividad nueva", "archive"); break;
    case "unarchive": await setMeta(r.session_id, { archived: false }); toast("Desarchivada", "unarchive"); break;
    case "note": { const v = prompt("Nota para esta sesión (vacío = borrar):", r.note ?? ""); if (v !== null) { await setMeta(r.session_id, { note: v }); toast(v ? "Nota guardada" : "Nota borrada", "note"); } break; }
    case "noteclear": await setMeta(r.session_id, { note: "", note_kind: null }); toast("Estado y nota borrados", "note"); break;
    case "autoaccept": await setMeta(r.session_id, { auto_accept: !r.auto_accept }); toast(r.auto_accept ? "Aceptación automática apagada" : "Aceptación automática ACTIVA: se aprobarán solos los permisos (menos preguntas)", "zap"); break;
    case "rename": { const v = prompt(`Nombre propio (vacío = volver a «${r.auto_title ?? r.title}»):`, r.title); if (v !== null) { await setMeta(r.session_id, { custom_title: v }); toast("Renombrada", "pencil"); } break; }
    case "copy": await navigator.clipboard?.writeText(`claude --resume ${r.session_id}`); toast("Comando copiado", "copy"); break;
    case "terminar": await terminarSesion(r); await load(); break;
  }
}

// Marca el estado del proyecto en la nota. Reclicar el mismo estado lo quita. Si no hay texto, usa el rótulo.
async function setNoteKind(r, k) {
  const patch = r.note_kind === k ? { note_kind: null } : { note_kind: k };
  if (patch.note_kind && !r.note) patch.note = NOTE_KIND_META[k]?.label ?? k;
  await setMeta(r.session_id, patch);
  toast(patch.note_kind ? `Estado: ${NOTE_KIND_META[k]?.label ?? k}` : "Estado quitado", "note");
}

async function bulk(kind) {
  const ids = [...state.picked];
  if (kind === "clear") { state.picked.clear(); render(); return; }
  const patch = { seen: { seen: true }, pin: { pinned: true }, unpin: { pinned: false }, archive: { archived: true } }[kind];
  await Promise.all(ids.map((id) => postMeta(id, patch)));
  state.picked.clear();
  await load();
  toast(`${ids.length} sesiones actualizadas`, "checkAll");
}

document.addEventListener("click", (e) => {
  const qr = e.target.closest("[data-reply]");
  if (qr) { const r = current(); if (r) sendReply(r, (settings.quickReplies ?? [])[Number(qr.dataset.reply)] ?? ""); return; }
  const rp = e.target.closest("[data-respond]");
  if (rp) { const r = current(); if (r) { try { respond(r, JSON.parse(rp.dataset.respond)); } catch {} } return; }
  const ch = e.target.closest("[data-choose]");
  if (ch) { const r = current(); if (r) chooseOption(r, ch.dataset.choose); return; }
  const dc = e.target.closest("[data-dbgcombo]");
  if (dc) { const r = current(); if (r) respond(r, dc.dataset.dbgcombo.split(",").map((x) => x.trim()).filter(Boolean)); return; }
  const ds = e.target.closest("[data-dbgsend]");
  if (ds) { const r = current(); const inp = ds.closest(".pr-dbg")?.querySelector("[data-dbgkeys]"); if (r && inp) respond(r, inp.value.split(/[ ,]+/).map((x) => x.trim()).filter(Boolean)); return; }
  const as = e.target.closest("[data-asset]");
  if (as) { const r = current(); if (r) openViewer(r.assets[Number(as.dataset.asset)], r.assets); return; }
  const dm = e.target.closest("[data-docmention]");
  if (dm) {
    e.preventDefault();
    const r = current();
    const raw = dm.dataset.docmention;
    const base = raw.split(/[\\/]/).pop().toLowerCase();
    const a = r?.assets?.find((x) => x.path.split(/[\\/]/).pop().toLowerCase() === base);
    // Previsualizable en el panel: visor. Office o desconocido: abrir su carpeta (Alt+clic: carpeta siempre).
    if (a && a.type !== "office" && a.servable && !e.altKey) { openViewer(a, r.assets); return; }
    if (r) revealFile(r, raw);
    return;
  }
  const nk = e.target.closest("[data-notekind]");
  if (nk) { const r = current(); if (r) setNoteKind(r, nk.dataset.notekind); return; }
  const b = e.target.closest("[data-bulk]");
  if (b) { bulk(b.dataset.bulk); return; }
  const a = e.target.closest("[data-act]");
  if (a) { e.preventDefault(); act(a.dataset.act); return; }
  const v = e.target.closest("[data-view]");
  if (v) { save((s) => { s.activeView = v.dataset.view; }); return; }
  const l = e.target.closest("[data-layout]");
  if (l) { save((s) => { s.layout = l.dataset.layout; }); closeDrawer(); return; }
  const fs = e.target.closest("[data-fstate]");
  if (fs) { toggle(state.adhoc.states, fs.dataset.fstate); render(); return; }
  const fr = e.target.closest("[data-frepo]");
  if (fr) { toggle(state.adhoc.repos, fr.dataset.frepo); render(); return; }
  const fk = e.target.closest("[data-fkind]");
  if (fk) { toggle(state.adhoc.noteKinds, fk.dataset.fkind); render(); return; }
  const qk = e.target.closest("[data-quick]");
  if (qk) {
    const map = { necesita_input: "pendientes", unseen: "sinver", esperando: "pendientes", trabajando: "trabajando" };
    if (allViews().some((x) => x.id === map[qk.dataset.quick])) save((s) => { s.activeView = map[qk.dataset.quick]; });
    return;
  }
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); goto(g.dataset.goto); }
});
const toggle = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); else arr.push(x); };

function goto(id) {
  save((s) => { s.activeView = "todo"; });
  state.adhoc = { states: [], repos: [], noteKinds: [], text: "" };
  $("#q").value = "";
  if (settings.layout === "bandeja") ctx.select(id); else ctx.openDrawer(id);
}

$("#q").addEventListener("input", () => { state.adhoc.text = $("#q").value.trim(); render(); });
// Enter en el buscador: buscar en TODAS las conversaciones (no solo filtrar las visibles).
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && $("#q").value.trim().length >= 2) { e.preventDefault(); openSearch($("#q").value.trim()); } });
initSearch((id) => {
  if (!state.data?.sessions.some((r) => r.session_id === id)) return false;
  goto(id);
  return true;
});

// ---------- Responder ----------
// La extension solo acepta ?prompt= si la conversacion NO esta abierta en una pestaña; si ya lo esta,
// la enfoca y descarta el texto ("Session is already open. Your prompt was not applied"). Por eso:
//   - sesion viva en VS Code -> se copia la respuesta al portapapeles y solo se enfoca (pegar + Enter)
//   - sesion cerrada         -> ?prompt= (la abre con el texto ya escrito)
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try {
    const ta = Object.assign(document.createElement("textarea"), { value: t });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// Responder al diálogo de permiso/pregunta: enfoca la pestaña y pulsa las teclas (como lo harías tú).
// Elegir una opción de un AskUserQuestion: activa la pestaña y aprobar.ps1 pulsa la opción + "Submit answers".
async function chooseOption(r, label) {
  const live = !!r.pid && r.entrypoint === "claude-vscode";
  if (!live) { openVs(r.open_url); toast("Abre la sesión y elige en VS Code", "external"); return; }
  const sent = fetch(`/api/sesiones/${r.session_id}/responder`, {
    method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify({ options: [label] }),
  }).then((x) => x.json()).catch(() => ({ ok: false, reason: "red" }));
  openVs(r.open_url);
  toast(`Eligiendo «${label}»…`, "external");
  const res = await sent;
  if (res.ok) { toast(`Elegido: ${label}`, "check"); setTimeout(load, 1500); }
  else {
    const why = { no_dialog: "no vi el diálogo de preferencias", title_mismatch: "VS Code mostró otra pestaña", no_button: "no encontré esa opción" }[res.reason] ?? `no se pudo (${res.reason})`;
    toast(`${why}: elígela en VS Code`, "alert");
  }
}

async function respond(r, keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  const live = !!r.pid && r.entrypoint === "claude-vscode";
  if (!live) { openVs(r.open_url); toast("Abre la sesión y responde en VS Code", "external"); return; }
  const label = keys.includes("2") || keys.includes("esc") ? "Rechazando…" : keys.includes("1") ? "Aprobando…" : "Enviando…";
  const sent = fetch(`/api/sesiones/${r.session_id}/responder`, {
    method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify({ keys }),
  }).then((x) => x.json()).catch(() => ({ ok: false, reason: "red" }));
  openVs(r.open_url);
  toast(label, "external");
  const res = await sent;
  const why = {
    title_mismatch: "VS Code mostró otra pestaña",
    no_vscode: "VS Code no quedó en primer plano",
    not_open: "la sesión ya no está abierta",
  }[res.reason] ?? `no se pudo responder (${res.reason})`;
  if (res.ok) { toast("Enviado a la sesión", "check"); setTimeout(load, 1200); }
  else toast(`${why}: respóndelo en VS Code`, "alert");
}

async function sendReply(r, text) {
  let t = String(text ?? "").trim();
  if (!t && !hasAtts(r.session_id)) { toast("Escribe una respuesta o adjunta algo", "message"); return false; }
  if (hasAtts(r.session_id)) {
    toast("Subiendo adjuntos…", "file");
    try { t = withAtts(t, await uploadAtts(r.session_id)); }
    catch (err) { toast(`No se pudo adjuntar ${err.message}; no se envió nada`, "alert"); return false; }
    clearAtts(r.session_id);
  }
  if (r.unseen) postMeta(r.session_id, { seen: true });
  const open = !!r.pid && r.entrypoint === "claude-vscode";
  const copied = await copyText(t);
  showPending(t);
  if (open) {
    // El servidor (enviar.ps1) espera a que VS Code muestre esta pestaña, comprueba el título y pega + Enter.
    const sent = fetch(`/api/sesiones/${r.session_id}/enviar`, {
      method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify({ text: t }),
    }).then((x) => x.json()).catch(() => ({ ok: false, reason: "red" }));
    // La pestaña la abre el NAVEGADOR: Windows solo deja pasar al frente a VS Code si el vscode:// lo lanza la app
    // que tiene el foco. Lanzado desde el servidor (proceso oculto) no cambia de pestaña y el foco vuelve al
    // navegador (se probó el 2026-11-23: title_mismatch / focus_lost en cada envío). enviar.ps1 verifica y pega.
    openVs(r.open_url);
    toast("Enviando a VS Code…", "external");
    const res = await sent;
    const why = {
      title_mismatch: "VS Code mostró otra pestaña",
      no_vscode: "VS Code no quedó en primer plano",
      not_open: "la sesión ya no está abierta",
      focus_lost: "otra ventana tomó el foco al pegar",
      not_confirmed: "VS Code no registró el mensaje tras 3 intentos",
    }[res.reason] ?? `no se pudo enviar (${res.reason})`;
    if (res.ok) { toast("Enviado a la sesión", "check"); setTimeout(load, 1500); }
    else toast(`${why}: ${copied ? "la respuesta quedó copiada, pégala con Ctrl+V y Enter" : "escríbela en VS Code"}`, "alert");
  } else {
    openVs(replyUrl(r, t));
    toast("Abriendo la sesión en VS Code con tu respuesta escrita", "external");
  }
}
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-replyform]");
  if (!f) return;
  e.preventDefault();
  const ta = f.querySelector("[data-replytext]");
  const r = current();
  if (!r) return;
  const text = ta.value;
  ta.value = ""; autoGrow(ta);
  clearDraft(r.session_id);
  sendReply(r, text).then((ok) => {
    if (ok === false && !ta.value) { ta.value = text; autoGrow(ta); setDraft(r.session_id, text); }
  });
});
// Como en un chat: Enter envía, Shift+Enter agrega una línea (y no se envía mientras se compone un acento).
document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("[data-replytext]") && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form?.requestSubmit(); }
}, true);

// ---------- Git y PRs (cada 20 s; el servidor responde desde su cache) ----------
async function loadGit() {
  try { setGit(await (await fetch("/api/git", { cache: "no-store" })).json()); render(); } catch {}
}
$("#clear-filters").addEventListener("click", () => { state.adhoc = { states: [], repos: [], noteKinds: [], text: "" }; $("#q").value = ""; render(); });
$("#save-view").addEventListener("click", () => {
  const name = prompt("Nombre de la vista:", state.adhoc.repos[0] ?? "Mi vista");
  if (!name) return;
  const base = activeView().filter;
  const filter = { ...base, ...(state.adhoc.states.length && { states: [...state.adhoc.states] }),
    ...(state.adhoc.repos.length && { repos: [...state.adhoc.repos] }),
    ...(state.adhoc.noteKinds.length && { noteKinds: [...state.adhoc.noteKinds] }), ...(state.adhoc.text && { text: state.adhoc.text }) };
  const id = "u" + Date.now().toString(36);
  save((s) => { s.views.push({ id, name, icon: "★", filter }); s.activeView = id; });
  state.adhoc = { states: [], repos: [], noteKinds: [], text: "" }; $("#q").value = "";
  toast(`Vista «${name}» guardada`, "star");
});
$("#btn-settings").addEventListener("click", () => openSettings(knownRepos, testNotify));
$("#scrim").addEventListener("click", () => { closeDrawer(); closeSettings(); });
$("#drawer [data-close]").addEventListener("click", closeDrawer);
$("#btn-hoy").addEventListener("click", openDay);
$("#btn-help").addEventListener("click", () => $("#dlg-help").showModal());
$("#btn-bell").addEventListener("click", () => {
  save((s) => { s.notify.enabled = !s.notify.enabled; });
  if (settings.notify.enabled && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  toast(settings.notify.enabled ? "Avisos activados" : "Avisos desactivados", settings.notify.enabled ? "bell" : "bellOff");
});
document.querySelectorAll("dialog [data-dclose]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$("#dlg-copy").addEventListener("click", async () => { await navigator.clipboard?.writeText($("#dlg-body").textContent); toast("Resumen copiado", "copy"); });

const knownRepos = () => [...new Set((state.data?.sessions ?? []).flatMap((r) => r.repos.length ? r.repos : [r.workspace]).filter(Boolean))].sort();

async function showToday() {
  $("#dlg-body").textContent = "Cargando…";
  $("#dlg-hoy").showModal();
  $("#dlg-body").textContent = await (await fetch("/api/hoy", { cache: "no-store" })).text();
}

// ---------------- Atajos ----------------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches("input, textarea, select")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (document.querySelector("dialog[open]")) return;
  const k = e.key;
  if (k === "Escape" && isReading()) { setReading(false); return; }
  if (k === "f") { if (current()) setReading(!isReading()); return; }
  if (k === "Escape") { if (state.picked.size) { state.picked.clear(); render(); } else { closeDrawer(); closeSettings(); } return; }
  if (k === "/") { e.preventDefault(); $("#q").focus(); return; }
  if (k === "?") { $("#dlg-help").showModal(); return; }
  if (k === ",") { openSettings(knownRepos, testNotify); return; }
  if (k === "h") { openDay(); return; }
  if (k === "e") { const ta = document.querySelector(".drawer.open [data-replytext], #detail [data-replytext]"); if (ta) { e.preventDefault(); ta.focus(); } return; }
  if (k === "g") { const L = ["bandeja", "tabla", "tablero", "archivos", "proyectos"]; save((s) => { s.layout = L[(L.indexOf(s.layout) + 1) % L.length]; }); closeDrawer(); return; }
  if (/^[1-9]$/.test(k)) { const v = allViews()[Number(k) - 1]; if (v) save((s) => { s.activeView = v.id; }); return; }
  if (k === "x") { const id = state.drawerId ?? state.selectedId; if (id) ctx.togglePick(id); return; }
  if (settings.layout === "archivos") {
    if (k === "j" || k === "ArrowDown") { e.preventDefault(); ctx.assetNav?.(1); return; }
    if (k === "k" || k === "ArrowUp") { e.preventDefault(); ctx.assetNav?.(-1); return; }
    if (k === "Enter" || k === "o") { ctx.assetOpen?.(); return; }
  }
  if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
    e.preventDefault();
    const i = state.order.indexOf(state.drawerId ?? state.selectedId);
    const next = state.order[Math.max(0, Math.min(state.order.length - 1, i + (k === "j" || k === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    if (state.drawerId) ctx.openDrawer(next); else ctx.select(next);
    document.querySelector(`[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (k === "Enter" || k === "o") {
    if (e.target.closest?.(".card") && !state.drawerId) { ctx.openDrawer(e.target.closest(".card").dataset.id); return; }
    if (settings.layout !== "bandeja" && !state.drawerId && state.selectedId) ctx.openDrawer(state.selectedId); else act("open");
    return;
  }
  const map = { v: "seen", p: "pin", a: "archive", n: "note", r: "rename", c: "copy" };
  if (map[k]) {
    if (state.picked.size && ["v", "p", "a"].includes(k)) { bulk({ v: "seen", p: "pin", a: "archive" }[k]); return; }
    const r = current();
    act(r?.archived && k === "a" ? "unarchive" : map[k], r);
  }
});

// ---------------- Avisos ----------------
let audio;
function beep(kind = "fin") {
  if (!settings.notify.sound) return;
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine";
    o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime;
    const notes = kind === "urgente" ? [880, 660, 880] : [660, 990];
    notes.forEach((f, i) => o.frequency.setValueAtTime(f, t + i * 0.11));
    g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + notes.length * 0.11 + 0.1);
    o.start(t); o.stop(t + notes.length * 0.11 + 0.12);
  } catch {}
}

function push(title, body, r, urgent) {
  const n = settings.notify;
  if (!n.enabled || (n.onlyHidden && !document.hidden)) return;
  if ("Notification" in window && Notification.permission === "granted") {
    const x = new Notification(title, { body, tag: r?.session_id, requireInteraction: !!urgent });
    x.onclick = () => { window.focus(); if (r) act("open", r); x.close(); };
  }
  beep(urgent ? "urgente" : "fin");
}
function testNotify() {
  const was = settings.notify.onlyHidden;
  settings.notify.onlyHidden = false;
  if (!settings.notify.enabled) toast("Activa primero «Avisos del navegador»", "bellOff");
  push("Monitor de sesiones", "Así se verá un aviso. Clic para abrir la sesión.", null, false);
  settings.notify.onlyHidden = was;
}

function notify() {
  const cur = new Map(state.data.sessions.map((r) => [r.session_id, r]));
  if (state.prev) {
    for (const [id, r] of cur) {
      const before = state.prev.get(id);
      if (!before) continue;
      const n = settings.notify;
      if (r.state === "necesita_input" && before.state !== "necesita_input" && n.necesita) push(`Te necesita: ${r.title}`, r.needs_input_detail ?? "Necesita tu input", r, true);
      else if (r.state === "esperando" && before.state === "trabajando") {
        if (r.asks_question && n.pregunta) push(`Te preguntó: ${r.title}`, (r.last_response ?? "").slice(-180), r);
        else if (n.termino) push(`Terminó: ${r.title}`, (r.last_response ?? "").slice(0, 180), r);
      } else if (r.unseen && !before.unseen && n.sinver) push(`Sin ver: ${r.title}`, "Terminó y no la has visto", r);
    }
  }
  state.prev = new Map([...cur].map(([id, r]) => [id, { state: r.state, unseen: r.unseen }]));
}

function favicon(color, n) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = color; g.beginPath(); g.roundRect(1, 1, 30, 30, 8); g.fill();
  g.fillStyle = "#0f172a"; g.font = "bold 17px Segoe UI"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(n ? (n > 9 ? "9+" : String(n)) : "✓", 16, 17);
  $("#favicon").href = c.toDataURL();
}

// ---------------- Arranque ----------------
// Iconos estaticos del HTML: <i data-icon="nombre" data-size="15">.
document.querySelectorAll("i[data-icon]").forEach((el) => {
  el.outerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 16 });
});
// ?vista=bandeja|tabla|tablero&tema=claro|oscuro&ajustes=1: utiles para marcadores (no cambian lo guardado).
{
  const u = new URLSearchParams(location.search);
  if (["bandeja", "tabla", "tablero", "archivos", "proyectos"].includes(u.get("vista"))) settings.layout = u.get("vista");
  if (u.get("tema")) settings.theme = { claro: "light", oscuro: "dark", contraste: "alto-contraste", hc: "alto-contraste" }[u.get("tema")] ?? settings.theme;
  if (u.get("ajustes")) setTimeout(() => openSettings(knownRepos, testNotify), 600);
  if (u.get("dia")) setTimeout(() => openDay(), 600);
  if (u.get("lectura")) setTimeout(() => setReading(true), 600);
  if (u.get("debugteclas")) window.__dbgteclas = true;
  if (u.get("buscar")) setTimeout(() => openSearch(u.get("buscar")), 600);
  if (u.get("chat")) setTimeout(() => ctx.openChat(u.get("chat")), 900);   // ?chat=<session_id>: abrir esa conversacion en el panel
}
let lastThresholds = JSON.stringify(settings.thresholds) + settings.showArchived;
onChange(() => {
  applyTheme();
  const t = JSON.stringify(settings.thresholds) + settings.showArchived;
  if (t !== lastThresholds) { lastThresholds = t; load(); } else render();
});
applyTheme();
initPerms();
load();
setInterval(load, 4000);
loadGit();
setInterval(loadGit, 20000);
