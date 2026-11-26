// Vista "Proyectos": pseudoproyectos = ficha viva + hilos + reservas, leidos de /api/flujos.
// Muestra el estado de cada proyecto, que hilo esta vivo, que esta reservado y el historial de cambios; abre
// chats (retomar, hilo, consolidar, condensar). Las acciones estan en proyectos-dialogos.js y el historial en
// proyectos-historial.js. No escribe en repos.
import { esc, ago, plain, toast, NOTE_KIND_META } from "./ui.js";
import { renderMarkdown } from "./markdown.js";
import { icon } from "./icons.js";
import { STATE_LABEL } from "./store.js";
import { CFG } from "./config.js";
import { api, copy, editarHilo, moverHilo, nuevoHilo, nuevoProyecto, prompts, sacarHilo } from "./proyectos-dialogos.js";
import { mountHistorial } from "./proyectos-historial.js";
import { historiasCard, metaClick, tagChips, tagFilterHtml, tagsEditHtml, toggleTemas, wireMeta } from "./proyectos-meta.js";

const L = CFG.vscode_label;

let DATA = null, lastFetch = 0, fetching = false, error = null;
let selProj = null, selTab = "ficha", histFile = null;   // selTab: "ficha" | <archivo de hilo> | "historial"
const tagOn = new Set();                                  // filtro de etiquetas de la lista (todas deben estar)

async function load(force = false) {
  if (fetching || (!force && Date.now() - lastFetch < 5000)) return false;
  fetching = true;
  try {
    const r = await fetch("/api/flujos", { cache: "no-store" });
    DATA = await r.json(); error = null;
  } catch (e) { error = String(e); }
  lastFetch = Date.now(); fetching = false;
  return true;
}

// Texto de fichas e hilos: /api/flujos ya no lo trae (se pide al abrirlo y se guarda por fecha de modificación).
const textos = new Map();   // "slug|archivo" -> { mtime, text }
const tkey = (slug, file) => `${slug}|${file ?? ""}`;
function textoCache(slug, file, mtime) { const t = textos.get(tkey(slug, file)); return t && t.mtime === mtime ? t.text : null; }
async function cargarTexto(slug, file, mtime) {
  const r = await fetch(`/api/flujos/texto?project=${encodeURIComponent(slug)}&file=${encodeURIComponent(file ?? "")}`, { cache: "no-store" }).then((x) => x.json()).catch(() => ({ ok: false }));
  const text = r.ok ? r.text : null;
  if (text !== null) textos.set(tkey(slug, file), { mtime, text });
  return text;
}
/** Choques (automáticos) que involucran chats del proyecto. */
const choquesDe = (p) => (DATA?.choques ?? []).filter((c) => c.sesiones.some((s) => (p.chats ?? []).some((x) => x.session_id === s.session_id)));

const liveCount = (p) => new Set([...(p.chats ?? []).filter((c) => c.alive).map((c) => c.session_id),
  ...p.hilos.filter((h) => h.session_info?.alive).map((h) => h.session_info.session_id)]).size;
const activeRes = (p) => p.reservas.filter((r) => !r.stale);
const staleRes = (p) => p.reservas.filter((r) => r.stale);
const oneLine = (s) => plain(String(s ?? "").replace(/\*\*|`/g, ""));

function hiloDot(h) {
  const s = h.session_info;
  if (!s) return `<span class="dot cerrada" title="Sesión no encontrada"></span>`;
  return `<span class="dot ${s.alive ? s.state : "cerrada"}" title="${esc(s.alive ? STATE_LABEL[s.state] ?? s.state : "Sin proceso vivo")}"></span>`;
}

// Notas (Estado/Nota de la Bandeja) de los chats del proyecto; los bloqueos primero.
const ORDEN_NOTA = { bloqueo: 0, validacion: 1, info: 2, listo: 3 };
const conNota = (p) => (p.chats ?? []).filter((c) => c.note || c.note_kind)
  .sort((a, b) => (ORDEN_NOTA[a.note_kind] ?? 2.5) - (ORDEN_NOTA[b.note_kind] ?? 2.5));
const notaTxt = (c) => c.note ? plain(c.note) : (NOTE_KIND_META[c.note_kind]?.label ?? "");
const notaLinea = (c, cls) => `<div class="${cls} ${c.note_kind ? "k-" + c.note_kind : ""}" data-chatpanel="${esc(c.session_id)}" title="${esc(`${c.title ?? ""}
${c.note ?? ""}`)}">${icon("note", { size: 12 })}<span>${c.note_kind ? `<b>${esc(NOTE_KIND_META[c.note_kind]?.label ?? c.note_kind)}</b>${c.note ? " · " : ""}` : ""}${c.note ? esc(plain(c.note)) : ""}</span></div>`;
function notasHtml(p, max) {
  const ns = conNota(p);
  if (!ns.length) return "";
  return ns.slice(0, max).map((c) => notaLinea(c, "l4 note")).join("") + (ns.length > max ? `<div class="muted small pj-notamas">+${ns.length - max} nota${ns.length - max > 1 ? "s" : ""} más</div>` : "");
}

function listHtml(projects) {
  if (!projects.length) return `<div class="empty">${icon("layers", { size: 32 })}No hay proyectos en ${esc(DATA?.dir ?? "flujos")}.
    <button class="btn primary" data-newproj>${icon("plus")}Nuevo proyecto</button></div>`;
  return `<div class="pj-listhead">${icon("layers", { size: 13 })}Pseudoproyectos · ${projects.length}<span class="muted mono">${esc(DATA.dir)}</span>${DATA.historial?.error ? `<span class="pill necesita_input" title="${esc(DATA.historial.error)}">${icon("alert", { size: 12 })}historial</span>` : ""}
      ${(DATA.choques ?? []).length ? `<span class="pill conflict" title="${esc(DATA.choques.map((c) => `${c.nivel === "archivo" ? c.file : c.repo}: ${c.sesiones.map((s) => s.title).join(" / ")}`).join("\n"))}">${icon("alert", { size: 12 })}${DATA.choques.length} choque${DATA.choques.length > 1 ? "s" : ""}</span>` : ""}
      <button class="btn pj-newbtn" data-newproj title="Crear un pseudoproyecto (opcional: armarlo desde sesiones existentes)">${icon("plus", { size: 13 })}Nuevo proyecto</button></div>` +
    tagFilterHtml(DATA.etiquetas, tagOn) +
    projects.filter((p) => [...tagOn].every((t) => (p.etiquetas ?? []).includes(t))).map((p) => {
      const act = activeRes(p), st = staleRes(p), over = p.ficha_over || p.hilos.some((h) => h.over);
      return `<div class="item pj-item ${selProj === p.slug ? "sel" : ""}" data-pj="${esc(p.slug)}">
        <div class="strip" style="background:${act.length ? "var(--blue)" : p.bloqueos.length ? "var(--amber)" : "var(--line-2)"}"></div>
        <span class="pj-ico">${icon("layers", { size: 15 })}</span>
        <div class="body">
          <div class="l1"><span class="ttl">${esc(p.title)}</span><span class="when">${p.ficha_mtime ? ago(p.ficha_mtime) : ""}</span></div>
          <div class="l2"><span class="txt">${esc(oneLine(p.estado))}</span></div>
          <div class="l3">
            <span class="pill cerrada" title="Hilos (vivos)">${icon("branch", { size: 12 })}${p.hilos.length} hilos${liveCount(p) ? ` · <b>${liveCount(p)} vivo${liveCount(p) > 1 ? "s" : ""}</b>` : ""}</span>
            ${act.length ? `<span class="pill trabajando" title="Reservas activas">${icon("hand", { size: 12 })}${act.length} reservado</span>` : ""}
            ${st.length ? `<span class="pill cerrada" title="Reservas vencidas (más de 24 h)">${icon("clock", { size: 12 })}${st.length} vencida</span>` : ""}
            ${p.bloqueos.length ? `<span class="pill esperando">${icon("alert", { size: 12 })}${p.bloqueos.length} bloqueos</span>` : ""}
            ${p.inconsistencias.length ? `<span class="pill q">${icon("question", { size: 12 })}${p.inconsistencias.length} inconsist.</span>` : ""}
            ${over ? `<span class="pill necesita_input" title="Ficha o hilo sobre el límite de tamaño">${icon("alert", { size: 12 })}tamaño</span>` : ""}
            ${(p.historias ?? []).length ? `<span class="pill cerrada" title="${esc(p.historias.map((h) => `AB#${h.id} ${h.title ?? ""}`).join("\n"))}">${icon("ticket", { size: 12 })}${p.historias.length} US</span>` : ""}
            ${usCerradas(p).length ? `<span class="pill necesita_input" title="US vinculadas ya cerradas en Azure Boards: ${esc(usCerradas(p).map((h) => `AB#${h.id}`).join(", "))}">${icon("ticket", { size: 12 })}${usCerradas(p).length} US cerrada${usCerradas(p).length > 1 ? "s" : ""}</span>` : ""}
            ${choquesDe(p).length ? `<span class="pill conflict" title="Chats del proyecto que chocan con otra sesión abierta">${icon("alert", { size: 12 })}${choquesDe(p).length} choque${choquesDe(p).length > 1 ? "s" : ""}</span>` : ""}
          </div>
          ${(p.etiquetas ?? []).length ? `<div class="pj-tags">${tagChips(p)}</div>` : ""}
          ${notasHtml(p, 2)}
          <div class="pj-hilos">${p.hilos.map((h) => `<span class="pj-h ${h.over ? "over" : ""}" data-pj="${esc(p.slug)}" data-tab="${esc(h.file)}">${hiloDot(h)}${esc(h.name)}</span>`).join("")}</div>
        </div>
      </div>`;
    }).join("");
}

const CERRADO = new Set(["Closed", "Cerrado", "Done", "Removed", "Resolved"]);
const usCerradas = (p) => (p.historias ?? []).filter((h) => CERRADO.has(h.state));

/** Choques detectados solos: chats del proyecto que editan el mismo archivo o repo que otra sesión abierta. */
function choquesHtml(p) {
  const cs = choquesDe(p);
  if (!cs.length) return `<div class="muted small pj-auto">${icon("check", { size: 12 })}Sin choques detectados entre sesiones abiertas.</div>`;
  return `<div class="pj-choques"><div class="small"><b>${icon("alert", { size: 12 })}Choques detectados</b> <span class="muted">(automático, últimas 12 h)</span></div>
    ${cs.map((c) => `<div class="pj-choque ${c.nivel}">
      <div><span class="pill ${c.nivel === "archivo" ? "conflict" : "esperando"}">${c.nivel === "archivo" ? "mismo archivo" : "mismo repo"}</span>
        <span class="mono">${esc(c.nivel === "archivo" ? c.file : c.repo)}</span></div>
      ${c.sesiones.map((s) => `<div class="small"><span class="dot ${s.alive ? s.state : "cerrada"}"></span><a href="${esc(s.open_url)}" data-chatpanel="${esc(s.session_id)}" title="Ver el chat aquí (Ctrl+clic: abrir en ${esc(L)})">${esc(s.title ?? s.session_id.slice(0, 8))}</a>
        ${c.nivel === "repo" ? `<span class="muted" title="${esc(s.archivos.join("\n"))}">· ${s.archivos.length} archivo${s.archivos.length > 1 ? "s" : ""}</span>` : ""}</div>`).join("")}
    </div>`).join("")}</div>`;
}

function detailHtml(p) {
  if (!p) return `<div class="empty">${icon("layers", { size: 32 })}Elige un proyecto.</div>`;
  const act = activeRes(p), st = staleRes(p);
  const tab = selTab === "ficha" || selTab === "historial" ? null : p.hilos.find((h) => h.file === selTab);
  const sizeBar = (n, max) => `<span class="pj-size ${n > max ? "over" : ""}" title="${n} / ${max} caracteres"><i style="width:${Math.min(100, (n / max) * 100)}%"></i></span>`;
  return `<div class="apv-head pj-head">
      <span class="pj-ico big">${icon("layers", { size: 18 })}</span>
      <div class="vname"><b>${esc(p.title)}</b><span class="mono muted">${esc(p.path)}</span></div><span class="spacer"></span>
      <button class="btn primary" data-copy="retomar" title="Abre un chat en ${esc(L)} con el prompt y lo envía (Shift+clic: solo copiar)">${icon("external")}Retomar proyecto</button>
      <button class="btn" data-copy="nuevo" title="Crea el hilo y, si quieres, abre su chat en ${esc(L)}">${icon("plus")}Nuevo hilo</button>
      <button class="btn" data-copy="consolidar" title="Abre la consolidación en ${esc(L)} (Shift+clic: solo copiar)">${icon("rotate")}Consolidar ficha</button>
    </div>
    ${tagsEditHtml(p, DATA.etiquetas)}
    <div class="pj-grid">
      <section class="pj-card ${act.length ? "hot" : ""}">
        <h4>${icon("hand", { size: 14 })}En curso / reservas</h4>
        ${p.reservas.length ? p.reservas.map((r) => `<div class="pj-res ${r.stale ? "stale" : ""}">
            <div><b>${esc(r.hilo || "—")}</b> · <span class="mono">${esc(r.target || r.raw)}</span>${r.motivo ? `<div class="muted">${esc(r.motivo)}</div>` : ""}
            <div class="muted small">${r.at ? `${esc(ago(r.at))}${r.stale ? " · <b>vencida</b>" : ""}` : "sin fecha válida · se trata como vencida"}</div></div>
            <button class="btn ghost danger" data-release="${esc(r.raw)}" title="Quitar esta reserva de la ficha">${icon("x")}Liberar</button>
          </div>`).join("") : `<div class="muted">Sin reservas manuales.</div>`}
        ${st.length ? `<div class="muted small">${st.length} vencida(s): libérala(s) o pide «Consolidar ficha».</div>` : ""}
        ${choquesHtml(p)}
      </section>
      <section class="pj-card">
        <h4>${icon("branch", { size: 14 })}Hilos</h4>
        ${p.hilos.map((h) => `<div class="pj-hrow ${selTab === h.file ? "on" : ""}" data-tab="${esc(h.file)}">
            ${hiloDot(h)}<b>${esc(h.name)}</b><span class="muted small">${esc(h.estado)}</span><span class="spacer"></span>
            ${escribaHtml(h)}${sizeBar(h.chars, DATA.limits.hilo)}
            <button class="btn ghost icon" data-guardar="${esc(h.name)}" title="Guardar ahora: el escribano resume lo nuevo de sus chats sin esperar">${icon("rotate")}</button>            <button class="btn ghost icon" data-copyh="${esc(h.file)}" title="Seguir este hilo en un chat nuevo de ${esc(L)} (Shift+clic: solo copiar)">${icon("external")}</button>
            ${h.over ? `<button class="btn ghost icon" data-condense="${esc(h.file)}" title="Condensarlo en un chat nuevo de ${esc(L)} (Shift+clic: solo copiar)">${icon("minimize")}</button>` : ""}
            ${h.session_info?.open_url ? `<a class="btn ghost icon" href="${esc(h.session_info.open_url)}" data-chatpanel="${esc(h.session_info.session_id)}" title="Ver aquí el chat origen: ${esc(h.session_info.title ?? "")} (Ctrl+clic: abrir en ${esc(L)})">${icon("message")}</a>` : ""}
          </div>`).join("")}
      </section>
      <section class="pj-card">
        <h4>${icon("message", { size: 14 })}Chats del proyecto <span class="muted small">(últimos 7 días)</span></h4>
        ${(p.chats ?? []).length ? p.chats.filter((c, i) => i < 8 || c.note || c.note_kind).map((c) => `<div class="pj-hrow pj-chatrow" data-chatpanel="${esc(c.session_id)}" title="Ver el chat aquí · ${esc(c.first_prompt)}">
            <span class="dot ${c.alive ? c.state : "cerrada"}"></span><b class="pj-ct">${esc(c.title ?? c.session_id.slice(0, 8))}</b>
            <span class="muted small">${c.via === "asignada" ? `${icon("check", { size: 11 })}asignada · ` : ""}${c.via_us ? `por AB#${c.via_us}` : c.hilo ? `hilo ${esc(c.hilo)}` : "sin hilo"} ·${c.alive ? esc(STATE_LABEL[c.state] ?? c.state) : esc(ago(c.last_activity))}</span><span class="spacer"></span>
            ${c.open_url ? `<a class="btn ghost icon" href="${esc(c.open_url)}" data-vsonly title="Abrir en ${esc(L)}">${icon("external")}</a>` : ""}
          </div>${c.note || c.note_kind ? notaLinea(c, "pj-chatnote") : ""}`).join("") : `<div class="muted">Ningún chat está en este proyecto. Asígnalos desde la Bandeja (barra «Proyecto» de cada sesión) o usa «Retomar proyecto».</div>`}
      </section>
      ${historiasCard(p)}
      <section class="pj-card">
        <h4>${icon("alert", { size: 14 })}Bloqueos</h4>
        ${p.bloqueos.length ? `<ol>${p.bloqueos.map((b) => `<li>${renderInline(b)}</li>`).join("")}</ol>` : `<div class="muted">Sin bloqueos.</div>`}
      </section>
      <section class="pj-card">
        <h4>${icon("flag", { size: 14 })}Próximos pasos</h4>
        ${p.proximos.length ? `<ol>${p.proximos.map((b) => `<li>${renderInline(b)}</li>`).join("")}</ol>` : `<div class="muted">—</div>`}
      </section>
    </div>
    <div class="pj-tabs">
      <button class="chipfilter ${selTab === "ficha" ? "on" : ""}" data-tab="ficha">${icon("note", { size: 13 })}Ficha ${sizeBar(p.ficha_chars, DATA.limits.ficha)}</button>
      ${p.hilos.map((h) => `<button class="chipfilter ${selTab === h.file ? "on" : ""}" data-tab="${esc(h.file)}">${hiloDot(h)}${esc(h.name)}</button>`).join("")}
      ${CFG.historial ? `<button class="chipfilter pj-histchip ${selTab === "historial" ? "on" : ""}" data-tab="historial" title="Quién cambió qué y cuándo (git de flujos/)">${icon("clock", { size: 13 })}Historial</button>` : ""}
    </div>
    ${tab?.exists ? `<div class="pj-tabbar"><span class="muted small">hilos/${esc(tab.file)} · ${tab.chars} caracteres${tab.mtime ? ` · modificado ${esc(ago(tab.mtime))}` : ""}</span><span class="spacer"></span>
      <button class="btn" data-edith="${esc(tab.file)}" title="Editar el texto del hilo">${icon("pencil")}Editar</button>
      ${CFG.historial ? `<button class="btn" data-histh="${esc(tab.file)}" title="Cambios de este hilo (con diff y restaurar)">${icon("clock")}Historial</button>` : ""}
      <button class="btn" data-moveh="${esc(tab.file)}" title="Mover este hilo a otro proyecto">${icon("layers")}Mover</button>
      <button class="btn danger" data-sacarh="${esc(tab.file)}" title="Sacar el hilo del proyecto (queda en .archivo, recuperable)">${icon("archive")}Sacar</button></div>` : ""}
    ${selTab === "historial" ? `<div class="pj-hist" id="pjhist"></div>`
      : `<article class="prose pj-prose" data-texto>${proseHtml(p, tab)}</article>`}`;
}
function proseHtml(p, tab) {
  if (tab && !tab.exists) return renderMarkdown(`_No existe hilos/${tab.file}._`, { resolve: () => null });
  const t = tab ? textoCache(p.slug, tab.file, tab.mtime) : textoCache(p.slug, "", p.ficha_mtime);
  return t === null ? `<p class="muted">Cargando…</p>` : renderMarkdown(t, { resolve: () => null });
}
function escribaHtml(h) {
  const e = h.escriba;
  if (!e?.on) return "";
  if (e.running) return `<span class="pj-esc run" title="El escribano está resumiendo este hilo">guardando…</span>`;
  if (e.error) return `<span class="pj-esc err" title="${esc(e.error)}">error al guardar</span>`;
  const cost = e.passes ? ` · ${e.passes} pasada${e.passes > 1 ? "s" : ""}, US$ ${e.cost_usd.toFixed(4)}` : "";
  if (e.pending_kb > 0) return `<span class="pj-esc pend" title="Lo nuevo de sus chats aún no está en el hilo (se guarda tras 60 s sin actividad)${cost}">${e.forced ? "en cola" : `pendiente ${e.pending_kb} KB`}</span>`;
  if (e.last_run) return `<span class="pj-esc ok" title="Hilo al día con sus chats${cost}">guardado ${esc(ago(e.last_run))}</span>`;
  return e.sessions ? `<span class="pj-esc ok" title="Sin novedades desde que se encendió el escribano">al día</span>` : "";
}
const renderInline = (s) => renderMarkdown(s, { resolve: () => null }).replace(/^<p>|<\/p>\s*$/g, "");

export function proyectos(host, rows, ctx) {
  ctx.setOrder?.([]);
  if (!host.querySelector(".pj-view")) {
    host.innerHTML = `<div class="bandeja files-view pj-view"><div class="list" id="pjlist"></div><div class="detail" id="pjdetail"></div></div>`;
  }
  const rerender = () => { if (host.dataset.layout === "proyectos") proyectos(host, rows, ctx); };
  load().then((changed) => { if (changed) rerender(); });
  const listEl = host.querySelector("#pjlist"), detEl = host.querySelector("#pjdetail");
  if (!DATA) { listEl.innerHTML = `<div class="empty">${error ? esc(error) : "Cargando proyectos…"}</div>`; return; }
  const projects = DATA.projects;
  if (!selProj || !projects.some((p) => p.slug === selProj)) selProj = projects[0]?.slug ?? null;
  const p = projects.find((x) => x.slug === selProj);
  if (p && selTab !== "ficha" && selTab !== "historial" && !p.hilos.some((h) => h.file === selTab)) selTab = "ficha";

  const metaSig = (x) => [x?.etiquetas, (x?.historias ?? []).map((h) => [h.id, h.state, h.title]), (x?.us_detectadas ?? []).map((h) => [h.id, h.title]),
    x ? choquesDe(x).map((c) => [c.nivel, c.repo, c.file, c.sesiones.length]) : null, (x?.chats ?? []).map((c) => [c.session_id, c.hilo, c.via])];
  const lsig = JSON.stringify([selProj, [...tagOn], DATA.etiquetas, projects.map((x) => [metaSig(x), x.slug, x.ficha_mtime, x.estado, x.reservas.map((r) => [r.raw, r.stale]), x.hilos.map((h) => [h.file, h.chars, h.session_info?.state, h.session_info?.alive, h.escriba]), (x.chats ?? []).map((c) => [c.session_id, c.state, c.alive, c.note, c.note_kind])])]);
  if (listEl.dataset.sig !== lsig) { const sc = listEl.scrollTop; listEl.dataset.sig = lsig; listEl.innerHTML = listHtml(projects); listEl.scrollTop = sc; }
  const dsig = JSON.stringify([metaSig(p), DATA.etiquetas, selProj, selTab, histFile, p?.ficha_mtime, p?.reservas.map((r) => [r.raw, r.stale]), p?.hilos.map((h) => [h.file, h.mtime, h.session_info?.state, h.session_info?.alive, h.escriba]), (p?.chats ?? []).map((c) => [c.session_id, c.state, c.alive, c.last_activity, c.note, c.note_kind])]);
  if (detEl.dataset.sig !== dsig) {
    const sc = detEl.scrollTop; detEl.dataset.sig = dsig; detEl.innerHTML = detailHtml(p); detEl.scrollTop = sc;
    const hist = detEl.querySelector("#pjhist");
    if (hist && p) mountHistorial(hist, p.slug, histFile, async () => { await load(true); rerender(); });
  }
  // Texto pedido al abrir: si no estaba en cache, se carga y se pinta solo el artículo (sin repintar todo el detalle).
  const art = detEl.querySelector("[data-texto]");
  if (art && p && art.textContent.trim() === "Cargando…") {
    const tab = selTab === "ficha" ? null : p.hilos.find((h) => h.file === selTab);
    const want = [p.slug, tab?.file ?? "", tab ? tab.mtime : p.ficha_mtime];
    if (art.dataset.want !== want.join("|")) {
      art.dataset.want = want.join("|");
      cargarTexto(...want).then(() => { if (art.isConnected && art.dataset.want === want.join("|")) art.innerHTML = proseHtml(p, tab); });
    }
  }
  wireMeta(detEl, () => DATA?.projects.find((x) => x.slug === selProj), async () => { await load(true); rerender(); });
  if (!detEl.dataset.histwired) {
    detEl.dataset.histwired = "1";
    detEl.addEventListener("historial-todo", () => { histFile = null; detEl.dataset.sig = ""; proyectos(host, rows, ctx); });
  }

  host.onclick = async (e) => {
    // Chats: se abren en el panel lateral; Ctrl/Shift+clic o el boton de VS Code los abren alla.
    const chp = e.target.closest("[data-chatpanel]");
    if (chp && !e.target.closest("[data-vsonly]") && !(e.ctrlKey || e.metaKey || e.shiftKey) && ctx.openChat) {
      e.preventDefault(); ctx.openChat(chp.dataset.chatpanel); return;
    }
    const tabEl = e.target.closest("[data-tab]");
    const pjEl = e.target.closest("[data-pj]");
    const gd = e.target.closest("[data-guardar]");
    const cp = e.target.closest("[data-copy]"), cph = e.target.closest("[data-copyh]"), cnd = e.target.closest("[data-condense]"), rel = e.target.closest("[data-release]");
    const cur = projects.find((x) => x.slug === selProj);
    const edh = e.target.closest("[data-edith]"), mvh = e.target.closest("[data-moveh]"), sch = e.target.closest("[data-sacarh]"), hsh = e.target.closest("[data-histh]");
    const hiloOf = (el, attr) => cur?.hilos.find((x) => x.file === el.dataset[attr]);
    const refresh = async () => { await load(true); rerender(); };
    if (edh && cur) {
      const h = hiloOf(edh, "edith");
      if (!h) return;
      const text = textoCache(cur.slug, h.file, h.mtime) ?? await cargarTexto(cur.slug, h.file, h.mtime);
      if (text === null) { toast("No se pudo leer el hilo", "alert"); return; }
      editarHilo(DATA, cur, { ...h, markdown: text }, refresh);
      return;
    }
    if (mvh && cur) { const h = hiloOf(mvh, "moveh"); if (h) moverHilo(DATA, cur, h, async (dest) => { selProj = dest; selTab = h.file; await refresh(); }); return; }
    if (sch && cur) { const h = hiloOf(sch, "sacarh"); if (h) sacarHilo(cur, h, async () => { if (selTab === h.file) selTab = "ficha"; await refresh(); }); return; }
    if (hsh && cur) { histFile = `${cur.slug}/hilos/${hsh.dataset.histh}`; selTab = "historial"; rerender(); return; }
    if (e.target.closest("#pjhist")) return;
    const tf = e.target.closest("[data-tagfilter]");
    if (tf) { const t = tf.dataset.tagfilter; if (tagOn.has(t)) tagOn.delete(t); else tagOn.add(t); rerender(); return; }
    if (e.target.closest("[data-tagclear]")) { tagOn.clear(); rerender(); return; }
    if (e.target.closest("[data-tagfold]")) { toggleTemas(); listEl.dataset.sig = ""; rerender(); return; }
    if (metaClick(e, cur, refresh)) return;
    if (e.target.closest("[data-newproj]")) {
      nuevoProyecto(DATA, async (slug) => { selProj = slug; selTab = "ficha"; await load(true); rerender(); });
      return;
    }
    if (cp && cur) {
      const k = cp.dataset.copy;
      if (k === "nuevo") nuevoHilo(cur, async (file) => { selTab = file; await load(true); rerender(); });
      else copy(prompts[k](cur), k === "retomar" ? "Retomar" : "Consolidar", e.shiftKey);
      return;
    }
    if (cph && cur) { const h = cur.hilos.find((x) => x.file === cph.dataset.copyh); if (h) copy(prompts.hilo(cur, h), `Hilo ${h.name}`, e.shiftKey); return; }
    if (cnd && cur) { const h = cur.hilos.find((x) => x.file === cnd.dataset.condense); if (h) copy(prompts.condensar(cur, h), `Condensar ${h.name}`, e.shiftKey); return; }
    if (gd && cur) {
      const r = await api("/api/escriba/ahora", { project: cur.slug, hilo: gd.dataset.guardar });
      toast(r.ok ? (r.sessions ? `Escribano en cola para ${gd.dataset.guardar}` : "Este hilo no tiene chats que resumir todavía") : "No se pudo encolar", r.ok ? "check" : "alert");
      setTimeout(async () => { await load(true); rerender(); }, 1500);
      return;
    }
    if (rel && cur) {
      if (!window.confirm(`¿Quitar esta reserva de la ficha de ${cur.slug}?\n\n${rel.dataset.release}`)) return;
      const r = await api("/api/flujos/liberar", { project: cur.slug, line: rel.dataset.release });
      toast(r.ok ? "Reserva liberada" : `No se pudo liberar (${r.reason ?? r.error ?? "error"})`, r.ok ? "check" : "alert");
      await load(true); rerender();
      return;
    }
    if (e.target.closest("a")) return;
    if (pjEl) { selProj = pjEl.dataset.pj; selTab = tabEl ? tabEl.dataset.tab : "ficha"; histFile = null; rerender(); return; }
    if (tabEl) { selTab = tabEl.dataset.tab; if (selTab === "historial") histFile = null; rerender(); }
  };
}
