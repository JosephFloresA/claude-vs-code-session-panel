// Vista Proyectos — acciones: prompts de chat, diálogos de hilos y de proyecto nuevo. Sin estado propio:
// reciben los datos (/api/flujos) y una función onDone para refrescar.
import { esc, ago, toast } from "./ui.js";
import { icon } from "./icons.js";
import { TOKEN } from "./perms.js";
import { openVs } from "./abrir.js";
import { CFG } from "./config.js";

const L = CFG.vscode_label;

export const api = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN },
  body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e) }));

// Abre un chat nuevo en VS Code con el prompt y lo envía (enviar-chat.ps1 verifica la ventana antes de pulsar
// Enter). También lo deja en el portapapeles por si la extensión no lo recibe. Con Shift+clic solo copia.
export async function copy(text, label, onlyCopy = false) {
  let copied = true;
  try { await navigator.clipboard.writeText(text); } catch { copied = false; }
  if (onlyCopy) { if (copied) toast(`${label}: copiado.`); else window.prompt("Copia este prompt:", text); return; }
  openVs(`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(text)}`, `${label}: enviado en ${L}.`, { send: true });
}

const usTxt = (p) => ((p.historias ?? []).length ? ` Historias de usuario vinculadas: ${p.historias.map((h) => `AB#${h.id}`).join(", ")}.` : "");
export const prompts = {
  retomar: (p) => `Proyecto ${p.slug}. Lee la ficha (${p.ficha_path}) y dime en qué estamos y qué sigue.${usTxt(p)}`,
  hilo: (p, h) => `Proyecto ${p.slug}, sigo el hilo ${h.name}. Lee la ficha y hilos/${h.file}.`,
  nuevo: (p, n, obj) => `Proyecto ${p.slug}, hilo ${n} (nuevo). Lee la ficha (${p.ficha_path}).${obj ? ` Objetivo: ${obj}` : ""}`,
  consolidar: (p) => `Eres la sesión principal del proyecto ${p.slug}. Consolida la ficha (${p.ficha_path}) a partir de sus hilos según la regla 4: máximo ${CFG.limits.ficha.toLocaleString("es-CL")} caracteres, contradicciones a Inconsistencias, borra reservas vencidas y actualiza la tabla Hilos.`,
  condensar: (p, h) => `Proyecto ${p.slug}: el hilo ${h.name} pasa del límite (${h.chars}/${CFG.limits.hilo.toLocaleString("es-CL")} caracteres). Condénsalo sin perder datos literales; el detalle va en "Dónde buscar detalle exacto". (Edición pedida por el usuario: excepción a la regla del escribano.)`,
};

function dialog(id, cls, html) {
  let d = document.getElementById(id);
  if (!d) { d = document.createElement("dialog"); d.id = id; d.className = cls; document.body.appendChild(d); }
  d.innerHTML = html;
  d.showModal();
  return d;
}
export const dhead = (ico, title) => `<div class="dh"><h2>${icon(ico)}${title}</h2><span class="spacer"></span>
  <button type="button" class="btn ghost icon" data-close title="Cerrar">${icon("x")}</button></div>`;
const wireClose = (d) => d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
export { dialog, wireClose };

/** Editor del texto de un hilo. Guarda solo si nadie (el escribano) lo cambió desde que se abrió. */
export function editarHilo(data, p, h, onDone) {
  let mtime = h.mtime;
  const d = dialog("pjedit", "pj-edit", `${dhead("pencil", `Editar hilo <span class="mono">${esc(h.name)}</span>`)}
    <div class="pje-body"><textarea class="mono" spellcheck="false" data-ta></textarea></div>
    <div class="pjn-err" data-err hidden></div>
    <div class="pjn-foot"><span class="muted small" data-count></span><span class="spacer"></span>
      <button type="button" class="btn" data-close>Cancelar</button>
      <button type="button" class="btn" data-force hidden>Sobrescribir igual</button>
      <button type="button" class="btn primary" data-save>${icon("check")}Guardar</button></div>`);
  wireClose(d);
  const ta = d.querySelector("[data-ta]"), err = d.querySelector("[data-err]"), cnt = d.querySelector("[data-count]"), force = d.querySelector("[data-force]");
  ta.value = h.markdown;
  const count = () => { const n = ta.value.length; cnt.innerHTML = `${n.toLocaleString("es-CL")} / ${data.limits.hilo.toLocaleString("es-CL")} caracteres${n > data.limits.hilo ? " · <b>sobre el límite</b>" : ""}`; };
  ta.addEventListener("input", count); count(); ta.focus();
  const save = async (useMtime) => {
    const r = await api("/api/flujos/hilo/guardar", { project: p.slug, file: h.file, markdown: ta.value, mtime: useMtime });
    if (r.ok) { d.close(); toast(`Hilo ${h.name} guardado${r.over ? " (sobre el límite)" : ""}`, "check"); onDone(); return; }
    err.hidden = false;
    if (r.reason === "cambiado") {
      mtime = r.mtime; force.hidden = false;
      err.innerHTML = `El escribano reescribió este hilo mientras lo editabas. «Sobrescribir igual» guarda tu texto (su versión queda en el historial y se puede restaurar); o cierra y vuelve a abrir el editor para partir de la suya.`;
    } else err.textContent = `No se pudo guardar (${r.reason ?? r.error ?? "error"}).`;
  };
  d.querySelector("[data-save]").addEventListener("click", () => save(mtime));
  force.addEventListener("click", () => save(mtime));
}

export function moverHilo(data, p, h, onDone) {
  const otros = data.projects.filter((x) => x.slug !== p.slug);
  const d = dialog("pjmove", "pj-small", `${dhead("layers", `Mover hilo <span class="mono">${esc(h.name)}</span>`)}
    <div class="pjn-body"><label class="pjn-f"><span>Proyecto destino</span>
      <select data-dest>${otros.map((x) => `<option value="${esc(x.slug)}">${esc(x.title)} · ${esc(x.slug)}</option>`).join("")}</select></label>
      <div class="muted small">Se mueve el archivo y su fila de la tabla de hilos (con la sesión origen). Los chats que nombraban «${esc(p.slug)}» seguirán apareciendo en ese proyecto, no en el destino.</div>
      <div class="pjn-err" data-err hidden></div></div>
    <div class="pjn-foot"><span class="spacer"></span><button type="button" class="btn" data-close>Cancelar</button>
      <button type="button" class="btn primary" data-ok>${icon("layers")}Mover</button></div>`);
  wireClose(d);
  d.querySelector("[data-ok]").addEventListener("click", async () => {
    const destino = d.querySelector("[data-dest]").value;
    const r = await api("/api/flujos/hilo/mover", { project: p.slug, file: h.file, destino });
    if (!r.ok) { const e = d.querySelector("[data-err]"); e.hidden = false; e.textContent = r.reason === "ya_existe_en_destino" ? "El destino ya tiene un hilo con ese nombre." : `No se pudo mover (${r.reason ?? "error"}).`; return; }
    d.close(); toast(`Hilo ${h.name} movido a ${destino}`, "check"); onDone(destino);
  });
}

export async function sacarHilo(p, h, onDone) {
  if (!window.confirm(`¿Sacar el hilo «${h.name}» de ${p.slug}?\n\nEl archivo pasa a ${p.slug}\\.archivo\\ (recuperable, y queda en el historial) y su fila sale de la tabla de la ficha. Los datos que la ficha cite de ese hilo no se tocan.`)) return;
  const r = await api("/api/flujos/hilo/sacar", { project: p.slug, file: h.file });
  toast(r.ok ? `Hilo ${h.name} sacado (queda en .archivo)` : `No se pudo sacar (${r.reason ?? "error"})`, r.ok ? "check" : "alert");
  if (r.ok) onDone();
}

export function nuevoHilo(p, onDone) {
  const d = dialog("pjhilo", "pj-small", `${dhead("plus", `Nuevo hilo en <span class="mono">${esc(p.slug)}</span>`)}
    <div class="pjn-body">
      <label class="pjn-f"><span>Nombre</span><input data-n class="mono" maxlength="61" placeholder="ej.: pruebas-en-mirror"><small class="muted">Minúsculas, números y guiones.</small></label>
      <label class="pjn-f"><span>Objetivo <small class="muted">(opcional)</small></span><textarea data-o rows="2" maxlength="400"></textarea></label>
      <label class="pjn-chk"><input type="checkbox" data-chat checked> Abrir y enviar un chat de este hilo en ${esc(L)}</label>
      <div class="pjn-err" data-err hidden></div></div>
    <div class="pjn-foot"><span class="spacer"></span><button type="button" class="btn" data-close>Cancelar</button>
      <button type="button" class="btn primary" data-ok>${icon("plus")}Crear hilo</button></div>`);
  wireClose(d);
  const nEl = d.querySelector("[data-n]"); nEl.focus();
  nEl.addEventListener("input", () => { const v = nEl.value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-"); if (v !== nEl.value) nEl.value = v; });
  d.querySelector("[data-ok]").addEventListener("click", async (ev) => {
    const n = nEl.value.replace(/^-+|-+$/g, ""), obj = d.querySelector("[data-o]").value.trim();
    const err = d.querySelector("[data-err]");
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(n)) { err.hidden = false; err.textContent = "Nombre no válido (mínimo 2 caracteres)."; return; }
    if (p.hilos.some((h) => h.name === n)) { err.hidden = false; err.textContent = "Ya existe un hilo con ese nombre."; return; }
    const r = await api("/api/flujos/hilo", { project: p.slug, name: n, objetivo: obj });
    if (!r.ok) { err.hidden = false; err.textContent = `No se pudo crear (${r.reason ?? "error"}).`; return; }
    d.close(); toast(`Hilo ${n} creado`, "check"); onDone(`${n}.md`);
    if (d.querySelector("[data-chat]").checked) copy(prompts.nuevo(p, n, obj), `Hilo ${n}`, ev.shiftKey);
  });
}

// ---- Nuevo proyecto -------------------------------------------------------------------------------------
const slugify = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const promptNuevoProyecto = (r, obj) => r.semillas.length
  ? `Proyecto ${r.slug} (nuevo, creado desde el panel): eres su sesión principal. Arma la ficha (${r.ficha_path}) y sus hilos desde las sesiones ${r.semillas.join(", ")}, siguiendo ${CFG.brief_migracion}. Para las transcripciones grandes usa subagentes y el extractor que indica el brief.${obj ? ` Objetivo: ${obj}` : ""} (Edición de ficha e hilos pedida por el usuario: excepción a la regla del escribano.)`
  : `Proyecto ${r.slug} (nuevo, creado desde el panel): eres su sesión principal. Lee la ficha (${r.ficha_path}).${obj ? ` Objetivo: ${obj}.` : ""} Pregúntame lo que falte para completar Estado actual, Decisiones y Próximos pasos, y propón el primer hilo.`;

/** Sesiones de los últimos 7 días que ningún proyecto tiene como hilo ni como chat. */
async function sesionesLibres(data) {
  const used = new Set();
  for (const p of data?.projects ?? []) {
    for (const h of p.hilos) if (h.session) used.add(h.session.slice(0, 8));
    for (const c of p.chats ?? []) used.add(c.session_id.slice(0, 8));
  }
  try {
    const r = await fetch("/api/sesiones?hours=168&archivadas=1", { cache: "no-store" }).then((x) => x.json());
    return (r.sessions ?? r ?? []).filter((s) => !used.has(s.session_id.slice(0, 8)) && String(s.first_prompt ?? "").trim().length > 8)
      .sort((a, b) => Date.parse(b.last_activity ?? 0) - Date.parse(a.last_activity ?? 0)).slice(0, 40);
  } catch { return []; }
}

export function nuevoProyecto(data, onDone) {
  let dlg = document.getElementById("pjnew");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "pjnew"; dlg.className = "pj-new"; document.body.appendChild(dlg); }
  dlg.innerHTML = `<form method="dialog" class="pjn-form">
    <div class="dh"><h2>${icon("layers")}Nuevo pseudoproyecto</h2><span class="spacer"></span>
      <button class="btn ghost icon" value="cancel" formnovalidate title="Cerrar">${icon("x")}</button></div>
    <div class="pjn-body">
      <label class="pjn-f"><span>Título</span><input name="title" required maxlength="120" placeholder="Ej.: Alertas de trazabilidad DMH" autofocus></label>
      <label class="pjn-f"><span>Carpeta (slug)</span><input name="slug" required pattern="[a-z0-9][a-z0-9_\\-]{2,60}" class="mono" placeholder="alertas_trazabilidad_dmh">
        <small class="muted">Minúsculas, números, _ o -. Se crea <span class="mono">${esc(data?.dir ?? "flujos")}\\&lt;slug&gt;\\ficha.md</span>.</small></label>
      <label class="pjn-f"><span>Objetivo <small class="muted">(opcional)</small></span><textarea name="objetivo" rows="2" maxlength="600" placeholder="Qué se quiere lograr y con qué restricciones"></textarea></label>
      <label class="pjn-f"><span>Etiquetas <small class="muted">(opcional, separadas por coma)</small></span><input name="etiquetas" list="pjn-tags-dl" placeholder="dch, alertas, tracking">
        <datalist id="pjn-tags-dl">${(data?.etiquetas ?? []).map((t) => `<option value="${esc(t)}">`).join("")}</datalist></label>
      <div class="pjn-f"><span>Armar desde sesiones existentes <small class="muted">(opcional)</small></span>
        <div class="pjn-ses" data-ses><div class="muted small">Buscando sesiones de los últimos 7 días que no están en ningún proyecto…</div></div>
        <input name="ids" class="mono" placeholder="IDs de sesiones más antiguas, separados por coma (8 caracteres basta)"></div>
      <label class="pjn-chk"><input type="checkbox" name="abrir" checked> Abrir y enviar el chat en ${esc(L)} al crear</label>
      <div class="pjn-err" data-err hidden></div>
    </div>
    <div class="pjn-foot"><span class="muted small" data-hint>Sin sesiones: se crea la ficha vacía y el chat te pregunta lo que falte.</span><span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button>
      <button class="btn primary" value="ok" data-ok>${icon("plus")}Crear proyecto</button></div>
  </form>`;
  const f = dlg.querySelector("form");
  const titleEl = f.elements.title, slugEl = f.elements.slug;
  let slugTouched = false;
  titleEl.addEventListener("input", () => { if (!slugTouched) slugEl.value = slugify(titleEl.value); });
  slugEl.addEventListener("input", () => { slugTouched = true; });
  const hint = () => {
    const n = f.querySelectorAll("[data-ses] input:checked").length + f.elements.ids.value.split(/[\s,;]+/).filter((x) => /^[0-9a-f]{8}/i.test(x)).length;
    f.querySelector("[data-hint]").textContent = n
      ? `${n} sesión(es): el chat armará la ficha y los hilos desde ellas (lee las transcripciones; cuesta tokens del modelo del chat).`
      : "Sin sesiones: se crea la ficha vacía y el chat te pregunta lo que falte.";
  };
  f.addEventListener("change", hint); f.elements.ids.addEventListener("input", hint);
  dlg.showModal();
  sesionesLibres(data).then((ss) => {
    const box = f.querySelector("[data-ses]");
    if (!box) return;
    box.innerHTML = ss.length ? ss.map((s) => `<label class="pjn-row" title="${esc(String(s.first_prompt).slice(0, 300))}">
        <input type="checkbox" value="${esc(s.session_id.slice(0, 8))}">
        <span class="mono small">${esc(s.session_id.slice(0, 8))}</span>
        <b>${esc(s.title ?? s.auto_title ?? String(s.first_prompt).slice(0, 60))}</b>
        <span class="muted small">${esc(ago(s.last_activity))}</span></label>`).join("")
      : `<div class="muted small">No hay sesiones recientes sin proyecto. Puedes pegar IDs abajo.</div>`;
  });
  f.onsubmit = async (ev) => {
    if (ev.submitter?.value !== "ok") return;
    ev.preventDefault();
    const err = f.querySelector("[data-err]");
    const semillas = [...f.querySelectorAll("[data-ses] input:checked")].map((x) => x.value)
      .concat(f.elements.ids.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean));
    const bad = semillas.filter((x) => !/^[0-9a-f]{8}/i.test(x));
    if (bad.length) { err.hidden = false; err.textContent = `IDs no válidos: ${bad.join(", ")}`; return; }
    const obj = f.elements.objetivo.value.trim();
    const okBtn = f.querySelector("[data-ok]"); okBtn.disabled = true;
    const r = await api("/api/flujos/proyecto", { slug: slugEl.value.trim(), title: titleEl.value.trim(), objetivo: obj, semillas,
      etiquetas: f.elements.etiquetas.value.split(/[,;]+/).map((x) => x.trim()).filter(Boolean) });
    okBtn.disabled = false;
    if (!r.ok) {
      err.hidden = false;
      err.textContent = r.reason === "ya_existe" ? "Ya existe un proyecto con esa carpeta." : r.reason === "parametros" ? "Revisa el título y el slug." : `No se pudo crear (${r.reason ?? r.error ?? "error"}).`;
      return;
    }
    dlg.close();
    toast(`Proyecto ${r.slug} creado`, "check");
    onDone(r.slug);
    if (f.elements.abrir.checked) copy(promptNuevoProyecto(r, obj), `Proyecto ${r.slug}`, ev.shiftKey);
  };
}
