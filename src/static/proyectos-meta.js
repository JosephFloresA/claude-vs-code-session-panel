// Vista Proyectos — etiquetas e historias de usuario (proyecto.json). Cada cambio pasa por la API, que lo registra
// en el historial git de flujos/ con actor «panel». Título, tipo y estado de cada AB# vienen de ADO (solo lectura, con cache).
import { esc, toast, ago } from "./ui.js";
import { CFG } from "./config.js";
import { icon } from "./icons.js";
import { api } from "./proyectos-dialogos.js";

const ESTADO_CLS = { New: "cerrada", Nuevo: "cerrada", Priorizada: "esperando", Active: "trabajando", Activo: "trabajando",
  Resolved: "trabajando", Closed: "listo", Cerrado: "listo", Done: "listo", Removed: "cerrada" };

/** Chips de etiquetas para la lista (compactos). */
export const tagChips = (p) => [...(p.etiquetas ?? [])].sort((a, b) => "tipodivtema".indexOf(familia(a)) - "tipodivtema".indexOf(familia(b)))
  .map((t) => `<span class="pj-tag ${familia(t)}"data-tagfilter="${esc(t)}" title="Filtrar por «${esc(t)}»">#${esc(t)}</span>`).join("");

// Familias de etiquetas (config.tags): el tipo de proyecto (uno por proyecto) y el grupo (area, equipo, cliente...).
// El resto son temas libres.
export const TIPOS = CFG.tags.types;
export const DIVISIONES = CFG.tags.groups;
const familia = (t) => (TIPOS.includes(t) ? "tipo" : DIVISIONES.includes(t) ? "div" : "tema");

const FOLD_KEY = "pj-temas-abiertos";
function temasAbiertos() { try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; } }
export function toggleTemas() { try { localStorage.setItem(FOLD_KEY, temasAbiertos() ? "0" : "1"); } catch {} }

/** Filtro de etiquetas sobre la lista, en tres filas: tipo, grupo (config.tags.groupsLabel) y temas. */
export function tagFilterHtml(all, on) {
  if (!all?.length) return "";
  const btn = (t) => `<button class="pj-tag ${familia(t)} ${on.has(t) ? "on" : ""}" data-tagfilter="${esc(t)}">#${esc(t)}</button>`;
  const fila = (label, ts) => (ts.length ? `<div class="pj-tagrow"><span class="pj-taglbl">${label}</span>${ts.map(btn).join("")}</div>` : "");
  const tipos = TIPOS.filter((t) => all.includes(t)), divs = DIVISIONES.filter((t) => all.includes(t));
  const temas = all.filter((t) => familia(t) === "tema");
  // Los temas van plegados (salvo que haya uno marcado): son muchos y empujan la lista hacia abajo.
  const abiertos = temasAbiertos() || temas.some((t) => on.has(t));
  const filaTemas = temas.length ? `<div class="pj-tagrow"><button class="pj-taglbl pj-fold" data-tagfold title="${abiertos ? "Plegar" : "Mostrar"} los temas">Tema ${abiertos ? "▾" : `▸ ${temas.length}`}</button>${abiertos ? temas.map(btn).join("") : ""}</div>` : "";
  return `<div class="pj-tagbar">${fila("Tipo", tipos)}${fila(CFG.tags.groupsLabel || "Grupo", divs)}${filaTemas}
    ${on.size ? `<button class="btn ghost small" data-tagclear>${icon("x", { size: 12 })}quitar filtro</button>` : ""}</div>`;
}

/** Fila de etiquetas editable bajo la cabecera del proyecto. */
export function tagsEditHtml(p, all) {
  const libres = (all ?? []).filter((t) => !(p.etiquetas ?? []).includes(t));
  return `<div class="pj-meta">${icon("flag", { size: 13 })}
    ${(p.etiquetas ?? []).map((t) => `<span class="pj-tag edit">#${esc(t)}<button type="button" data-tagdel="${esc(t)}" aria-label="Quitar ${esc(t)}" title="Quitar">${icon("x", { size: 11 })}</button></span>`).join("")}
    <input class="pj-taginput" data-tagadd list="pj-tags-dl" maxlength="30" placeholder="${(p.etiquetas ?? []).length ? "+ etiqueta" : "Agregar etiquetas (Enter)"}">
    <datalist id="pj-tags-dl">${libres.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
  </div>`;
}

function usRow(h, linked) {
  const st = h.state ? `<span class="pill ${ESTADO_CLS[h.state] ?? "cerrada"}">${esc(h.state)}</span>` : "";
  const err = h.error && !h.title ? `<span class="muted small" title="${esc(h.error)}">sin datos de ADO</span>` : "";
  return `<div class="pj-us">
    <a class="mono pj-usid" href="${esc(h.url)}" target="_blank" rel="noopener" title="Abrir en Azure Boards">AB#${h.id}</a>
    ${h.type && h.type !== "User Story" ? `<span class="muted small">${esc(h.type)}</span>` : ""}${st}
    <span class="pj-ust" title="${esc(h.title ?? "")}${h.assigned ? ` · ${esc(h.assigned)}` : ""}">${esc(h.title ?? "")}${err}</span>
    <span class="spacer"></span>
    ${linked ? `<button class="btn ghost icon" data-usdel="${h.id}" title="Desvincular del proyecto (no toca ADO)">${icon("x")}</button>`
      : `<button class="btn ghost small" data-usadd="${h.id}" title="Vincular al proyecto">${icon("plus", { size: 12 })}Vincular</button>`}
  </div>`;
}

/** Tarjeta «Historias de usuario» del detalle. */
export function historiasCard(p) {
  const hs = p.historias ?? [], det = p.us_detectadas ?? [];
  const fresh = hs.map((h) => h.at).filter(Boolean).sort()[0];
  return `<section class="pj-card">
    <h4>${icon("ticket", { size: 14 })}Historias de usuario <span class="spacer"></span>
      ${hs.length ? `<button class="btn ghost icon" data-usrefresh title="Volver a leer título y estado desde Azure Boards${fresh ? ` (leído ${esc(ago(fresh))})` : ""}">${icon("rotate", { size: 13 })}</button>` : ""}</h4>
    ${hs.length ? hs.map((h) => usRow(h, true)).join("") : `<div class="muted">Sin historias vinculadas. Los chats que citen un AB# vinculado aparecen en «Chats del proyecto».</div>`}
    <form class="pj-usform" data-usform><input class="mono" name="id" placeholder="AB#12345 o URL del work item" autocomplete="off">
      <button class="btn" type="submit">${icon("plus", { size: 13 })}Vincular</button></form>
    ${det.length ? `<div class="pj-usdet"><div class="muted small pj-usdethead">Citadas en la ficha o los hilos, sin vincular (${det.length}):
        ${det.length > 1 ? `<button class="btn small" data-uslote title="Elegir cuáles vincular, todas de una vez">${icon("check", { size: 12 })}Revisar y vincular…</button>` : ""}</div>
      ${det.map((h) => usRow(h, false)).join("")}</div>` : ""}
  </section>`;
}

const reasonTxt = (r) => ({ ya_vinculada: "ya está vinculada", id_invalido: "ID no válido", no_existe: "el proyecto no existe" }[r.reason] ?? r.reason ?? r.error ?? "error");

async function vincular(p, id, refresh) {
  toast(`Leyendo AB#${id} en Azure Boards…`, "ticket");
  const r = await api("/api/flujos/historia", { project: p.slug, id });
  if (!r.ok) { toast(`No se pudo vincular: ${reasonTxt(r)}`, "alert"); return; }
  toast(r.info?.title ? `AB#${r.id} vinculada: ${r.info.title}` : `AB#${r.id} vinculada (sin datos de ADO: ${r.info?.error ?? "?"})`, r.info?.title ? "check" : "alert");
  await refresh();
}
async function guardarTags(p, tags, refresh) {
  const r = await api("/api/flujos/etiquetas", { project: p.slug, etiquetas: tags });
  if (!r.ok) toast(`No se pudieron guardar las etiquetas (${reasonTxt(r)})`, "alert");
  await refresh();
}

/** Diálogo para vincular varias US citadas de una vez (un solo commit). Las cerradas vienen desmarcadas. */
function dialogoLote(p, refresh) {
  const det = p.us_detectadas ?? [];
  let d = document.getElementById("pjlote");
  if (!d) { d = document.createElement("dialog"); d.id = "pjlote"; d.className = "pj-small"; document.body.appendChild(d); }
  d.innerHTML = `<form method="dialog" class="pjn-form">
    <div class="dh"><h2>${icon("ticket")}Vincular historias citadas</h2><span class="spacer"></span><button class="btn ghost icon" value="cancel" formnovalidate>${icon("x")}</button></div>
    <div class="pjn-body pj-lote">
      <div class="muted small">AB# que la ficha o los hilos de <b>${esc(p.title)}</b> mencionan. Marca las que pertenecen al proyecto. Las cerradas vienen sin marcar.</div>
      ${det.map((h) => `<label class="pjn-row"><input type="checkbox" value="${h.id}" ${CERRADAS.has(h.state) ? "" : "checked"}>
        <span class="mono small">AB#${h.id}</span>${h.state ? `<span class="pill ${ESTADO_CLS[h.state] ?? "cerrada"}">${esc(h.state)}</span>` : ""}
        <span class="pj-ust">${esc(h.title ?? (h.error ? "sin datos de ADO" : "leyendo…"))}</span></label>`).join("")}
    </div>
    <div class="pjn-foot"><span class="muted small" data-n></span><span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="ok">${icon("check")}Vincular</button></div></form>`;
  const f = d.querySelector("form");
  const cuenta = () => { f.querySelector("[data-n]").textContent = `${f.querySelectorAll("input:checked").length} de ${det.length}`; };
  f.addEventListener("change", cuenta); cuenta();
  d.showModal();
  f.onsubmit = async (ev) => {
    if (ev.submitter?.value !== "ok") return;
    ev.preventDefault();
    const ids = [...f.querySelectorAll("input:checked")].map((x) => Number(x.value));
    if (!ids.length) { d.close(); return; }
    toast(`Vinculando ${ids.length} historia${ids.length > 1 ? "s" : ""}…`, "ticket");
    const r = await api("/api/flujos/historia/lote", { project: p.slug, ids });
    d.close();
    toast(r.ok ? `${r.ids?.length ?? 0} vinculada${r.ids?.length === 1 ? "" : "s"} (un cambio en el historial)` : `No se pudo (${reasonTxt(r)})`, r.ok ? "check" : "alert");
    await refresh();
  };
}
const CERRADAS = new Set(["Closed", "Cerrado", "Done", "Removed", "Resolved"]);

/** Clics de esta sección. Devuelve true si el clic era suyo. */
export function metaClick(e, p, refresh) {
  if (!p) return false;
  const del = e.target.closest("[data-tagdel]");
  if (del) { guardarTags(p, p.etiquetas.filter((t) => t !== del.dataset.tagdel), refresh); return true; }
  const ud = e.target.closest("[data-usdel]");
  if (ud) {
    if (!window.confirm(`¿Desvincular AB#${ud.dataset.usdel} de ${p.slug}? (No cambia nada en Azure Boards.)`)) return true;
    api("/api/flujos/historia/quitar", { project: p.slug, id: Number(ud.dataset.usdel) })
      .then((r) => { toast(r.ok ? `AB#${ud.dataset.usdel} desvinculada` : `No se pudo (${reasonTxt(r)})`, r.ok ? "check" : "alert"); return refresh(); });
    return true;
  }
  if (e.target.closest("[data-uslote]")) { dialogoLote(p, refresh); return true; }
  const ua = e.target.closest("[data-usadd]");
  if (ua) { vincular(p, Number(ua.dataset.usadd), refresh); return true; }
  if (e.target.closest("[data-usrefresh]")) {
    toast("Leyendo historias en Azure Boards…", "ticket");
    api("/api/flujos/historia/refrescar", { project: p.slug }).then(refresh);
    return true;
  }
  return !!e.target.closest(".pj-meta, [data-usform]");
}

/** Enter en el campo de etiqueta y envío del formulario de historia. */
export function wireMeta(detEl, getP, refresh) {
  if (detEl.dataset.metawired) return;
  detEl.dataset.metawired = "1";
  detEl.addEventListener("keydown", (e) => {
    if (!e.target.matches?.("[data-tagadd]") || e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const p = getP(), v = e.target.value.trim();
    if (!p || !v) return;
    guardarTags(p, [...p.etiquetas, ...v.split(/[,;]+/).map((x) => x.trim()).filter(Boolean)], refresh);
  });
  detEl.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-usform]");
    if (!f) return;
    e.preventDefault();
    const p = getP(), v = f.elements.id.value.trim();
    const m = v.match(/(?:AB#|_workitems\/edit\/|^)\s*(\d{4,7})\b/i);
    if (!m) { toast("Escribe un AB# (p. ej. AB#82637) o pega la URL del work item", "alert"); return; }
    if (p) vincular(p, Number(m[1]), refresh);
  });
}
