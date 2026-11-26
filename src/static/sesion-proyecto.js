// Bandeja — a qué proyecto/hilo pertenece cada sesión. Muestra la asignación (o sugerencias), permite asignar con un
// clic y ofrece «Guardar y cerrar» (= «Terminar» de la cabecera): hilo → ficha → cierra la pestaña (flujos/terminar.mjs).
// La asignación vive en <proyecto>/proyecto.json (historial git, actor panel).
import { esc, toast } from "./ui.js";
import { icon } from "./icons.js";
import { TOKEN } from "./perms.js";
import { CFG } from "./config.js";

let DATA = null, loading = false, lastAt = 0;
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN },
  body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e) }));

async function refresh(force = false) {
  if (loading || (!force && Date.now() - lastAt < 15000)) return;
  loading = true;
  try { DATA = await (await fetch("/api/flujos/sesiones", { cache: "no-store" })).json(); lastAt = Date.now(); repaint(); }
  catch {} finally { loading = false; }
}
setInterval(() => refresh(), 15000);
refresh(true);

const VIA = { asignada: "asignada en el panel", origen: "la tabla de hilos de la ficha la cita como sesión origen", nombre: "su primer mensaje nombra el proyecto", us: "cita una US vinculada" };

function inner(r) {
  const a = DATA?.asignaciones?.[r.session_id];
  if (!a) return `<span class="muted small">${icon("layers", { size: 13 })}Proyecto…</span>`;
  if (a.project) {
    const live = !!r.pid && r.entrypoint === "claude-vscode";
    const puedeGuardar = !!a.hilo && CFG.escriba;
    return `${icon("layers", { size: 13 })}<span class="sp-lbl">Proyecto</span><b>${esc(a.title ?? a.project)}</b>
      ${a.hilo ? `<span class="sp-hilo">${icon("branch", { size: 12 })}${esc(a.hilo)}</span>` : `<span class="muted small">sin hilo (el escribano no la resume)</span>`}
      <span class="muted small" title="${esc(VIA[a.via] ?? "")}">· ${esc(a.via === "asignada" ? "asignada" : a.via === "origen" ? "sesión origen" : a.via === "us" ? "por US" : "por nombre")}</span>
      <span class="spacer"></span>
      <button class="btn ghost small" data-spassign>${icon("pencil", { size: 12 })}Cambiar</button>
      ${a.via === "asignada" ? `<button class="btn ghost small" data-spunassign title="Quitar la asignación">${icon("x", { size: 12 })}</button>` : ""}
      <button class="btn small ${puedeGuardar ? "" : "disabled"}" data-spsave="${live ? "cerrar" : "solo"}" ${puedeGuardar ? "" : "disabled"}
        title="${puedeGuardar ? (live ? "El escribano guarda lo pendiente en el hilo, actualiza la ficha y luego se cierra la pestaña en VS Code" : "El escribano guarda lo pendiente en el hilo y actualiza la ficha") : "Asígnale un hilo para que el escribano la guarde"}">
        ${icon("check", { size: 12 })}${live ? "Guardar y cerrar" : "Guardar"}</button>`;
  }
  const sug = a.sugerencias ?? [];
  return `${icon("layers", { size: 13 })}<span class="sp-lbl">Sin proyecto</span>
    ${sug.map((s, i) => `<button class="sp-sug" data-spsug="${i}" title="Asignar a ${esc(s.title)}: ${esc(s.motivos.join(" · "))}">
      ${i === 0 ? icon("star", { size: 11 }) : ""}${esc(s.title)}<span class="muted small">${esc(s.motivos[0] ?? "")}</span></button>`).join("")}
    ${sug.length ? "" : `<span class="muted small">sin coincidencias claras</span>`}
    <span class="spacer"></span><button class="btn ghost small" data-spassign>${icon("plus", { size: 12 })}Asignar…</button>`;
}

/** Barra bajo la cabecera del detalle (se repinta sola al llegar los datos). */
export const spBarHtml = (r) => `<div class="sp-bar" data-spbar="${esc(r.session_id)}">${inner(r)}</div>`;

let rowsRef = () => [];
export function setRowsSource(fn) { rowsRef = fn; }
function repaint() {
  document.querySelectorAll("[data-spbar]").forEach((el) => {
    const r = rowsRef().find((x) => x.session_id === el.dataset.spbar);
    if (r) el.innerHTML = inner(r);
  });
}

function dialogo(r, pre = {}) {
  const ps = DATA?.proyectos ?? [];
  const a = DATA?.asignaciones?.[r.session_id] ?? {};
  const sugs = (a.sugerencias ?? []).map((s) => s.project);
  const orden = [...ps].sort((x, y) => (sugs.indexOf(x.slug) + 1 || 99) - (sugs.indexOf(y.slug) + 1 || 99) || x.title.localeCompare(y.title));
  let d = document.getElementById("spdlg");
  if (!d) { d = document.createElement("dialog"); d.id = "spdlg"; d.className = "pj-small"; document.body.appendChild(d); }
  d.innerHTML = `<form method="dialog" class="pjn-form">
    <div class="dh"><h2>${icon("layers")}Asignar sesión a un proyecto</h2><span class="spacer"></span><button class="btn ghost icon" value="cancel" formnovalidate>${icon("x")}</button></div>
    <div class="pjn-body">
      <div class="muted small">«${esc(r.title)}»</div>
      <label class="pjn-f"><span>Proyecto</span><select name="project">${orden.map((p) => `<option value="${esc(p.slug)}" ${p.slug === (pre.project ?? a.project ?? sugs[0]) ? "selected" : ""}>${sugs.includes(p.slug) ? "★ " : ""}${esc(p.title)}</option>`).join("")}</select></label>
      <label class="pjn-f"><span>Hilo</span><select name="hilo"></select></label>
      <label class="pjn-f" data-nuevo hidden><span>Nombre del hilo nuevo</span><input name="nuevo" class="mono" pattern="[a-z0-9][a-z0-9\\-]{1,60}" placeholder="p. ej. ajuste-reglas-balance"></label>
      <label class="pjn-chk"><input type="checkbox" name="reciente" checked> Resumir también lo ya conversado (último tramo de la transcripción; unas 2 a 4 pasadas del escribano)</label>
      <div class="pjn-err" data-err hidden></div>
    </div>
    <div class="pjn-foot"><span class="muted small">Queda en el historial de flujos con autor «panel».</span><span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="ok">${icon("check")}Asignar</button></div></form>`;
  const f = d.querySelector("form");
  const fillHilos = () => {
    const p = ps.find((x) => x.slug === f.elements.project.value);
    const preH = pre.hilo ?? (a.project === p?.slug ? a.hilo : null) ?? (a.sugerencias ?? []).find((s) => s.project === p?.slug)?.hilo;
    f.elements.hilo.innerHTML = `<option value="">(sin hilo)</option>${(p?.hilos ?? []).map((h) => `<option ${h === preH ? "selected" : ""}>${esc(h)}</option>`).join("")}<option value="__nuevo">+ hilo nuevo…</option>`;
    f.querySelector("[data-nuevo]").hidden = f.elements.hilo.value !== "__nuevo";
  };
  f.elements.project.addEventListener("change", fillHilos);
  f.elements.hilo.addEventListener("change", () => { f.querySelector("[data-nuevo]").hidden = f.elements.hilo.value !== "__nuevo"; });
  fillHilos();
  d.showModal();
  f.onsubmit = async (ev) => {
    if (ev.submitter?.value !== "ok") return;
    ev.preventDefault();
    const nuevo = f.elements.hilo.value === "__nuevo" ? f.elements.nuevo.value.trim() : "";
    const err = f.querySelector("[data-err]");
    if (f.elements.hilo.value === "__nuevo" && !/^[a-z0-9][a-z0-9-]{1,60}$/.test(nuevo)) { err.hidden = false; err.textContent = "Nombre de hilo: minúsculas, números y guiones."; return; }
    const res = await post("/api/flujos/asignar", { session: r.session_id, project: f.elements.project.value,
      hilo: nuevo ? null : f.elements.hilo.value || null, nuevo_hilo: nuevo || null, reciente: f.elements.reciente.checked });
    if (!res.ok) { err.hidden = false; err.textContent = `No se pudo asignar (${res.reason ?? res.error ?? "error"}${res.paso ? `, al ${res.paso}` : ""}).`; return; }
    d.close();
    toast(res.sin_cambios ? "Ya estaba asignada así" : `Asignada a ${res.project}${res.hilo ? ` · ${res.hilo}` : ""}${res.escriba?.pendiente_kb ? ` (el escribano resumirá ~${res.escriba.pendiente_kb} KB)` : ""}`, "check");
    refresh(true);
  };
}

const PASO = { inicio: "Preparando", hilo: "1/3 Guardando la conversación en el hilo", ficha: "2/3 Actualizando la ficha", cerrar: "3/3 Cerrando la pestaña en VS Code" };
const WHY_CLOSE = { no_tab: "no encontré su pestaña", ambiguous: "hay dos pestañas activas con el mismo título", still_open: "la pestaña siguió abierta",
  no_vscode: "VS Code no está abierto", not_open: "ya no estaba abierta", keyboard_disabled: "el teclado está desactivado en este perfil", no_close_button: "la pestaña no expone su botón de cerrar" };
const enCurso = new Set();

/**
 * «Terminar»: la persona da por terminada la sesión. En el servidor (flujos/terminar.mjs): 1) el escribano guarda lo
 * pendiente en el hilo, 2) integra el hilo en la ficha, 3) cierra la pestaña en VS Code y archiva la sesión.
 * Sin proyecto/hilo, primero abre el diálogo de asignación. cerrar=false: solo guarda (hilo + ficha).
 */
export async function terminarSesion(r, { cerrar = true } = {}) {
  if (enCurso.has(r.session_id)) { toast("Ya se está terminando esta sesión", "rotate"); return; }
  if (!DATA) await refresh(true);
  const a = DATA?.asignaciones?.[r.session_id];
  if (!a?.project || !a?.hilo) {
    toast(a?.project ? "Elige un hilo para esta sesión: el escribano guarda en un hilo" : "Primero asígnala a un proyecto y un hilo", "layers");
    dialogo(r); return;
  }
  const live = !!r.pid && r.entrypoint === "claude-vscode";
  const pasos = [`1. El escribano guarda lo pendiente de la conversación en el hilo «${a.hilo}».`,
    `2. Actualiza la ficha de «${a.title ?? a.project}» con ese hilo.`,
    cerrar && live ? "3. Cierra la pestaña en VS Code y la archiva en el panel." : cerrar ? "3. La archiva en el panel (ya no está abierta en VS Code)." : null].filter(Boolean);
  const aviso = r.state === "trabajando" ? "\n\n⚠ Claude todavía está trabajando en esta sesión: si la cierras, se corta." : "";
  if (!window.confirm(`¿Terminar «${r.title}»?\n\n${pasos.join("\n")}${aviso}\n\nSi falla el paso 1 o el 2, no se cierra nada.`)) return;
  enCurso.add(r.session_id);
  try {
    const q = await post("/api/flujos/sesion/terminar", { session: r.session_id, cerrar });
    if (!q.ok) { toast(`No se pudo iniciar (${q.reason})`, "alert"); if (/sin_(hilo|proyecto)|hilo_no_existe/.test(q.reason)) dialogo(r); return; }
    let st = q, last = "";
    const t0 = Date.now();
    while (!st.fin && Date.now() - t0 < 12 * 60_000) {
      const msg = `${PASO[st.paso] ?? st.paso}${st.detalle ? ` · ${st.detalle}` : ""}…`;
      if (msg !== last) { toast(msg, "rotate"); last = msg; }
      await new Promise((ok) => setTimeout(ok, 2500));
      try { st = await (await fetch(`/api/flujos/sesion/${r.session_id}/terminar`, { cache: "no-store" })).json(); } catch {}
    }
    if (!st.fin) { toast("Sigue en curso en el servidor; revisa en unos minutos.", "alert"); return; }
    if (st.paso === "error") { toast(`No se terminó: ${st.error}`, "alert"); return; }
    const ficha = st.ficha_result?.result === "sin_cambios" ? "la ficha no necesitaba cambios" : "ficha actualizada";
    if (!st.cerrar) { toast(`Guardado en «${a.hilo}» y ${ficha}.`, "check"); return; }
    const c = st.cerrar_result;
    if (!st.live || c?.ok) toast(`Listo: hilo «${a.hilo}» guardado, ${ficha}${st.live ? " y pestaña cerrada" : ""}.`, "check");
    else toast(`Hilo guardado y ${ficha}. No se cerró la pestaña (${WHY_CLOSE[c?.reason] ?? c?.reason ?? "sin respuesta"}): ciérrala con Ctrl+F4.`, "alert");
  } finally { enCurso.delete(r.session_id); refresh(true); }
}

document.addEventListener("click", async (e) => {
  const bar = e.target.closest("[data-spbar]");
  if (!bar) return;
  const r = rowsRef().find((x) => x.session_id === bar.dataset.spbar);
  if (!r) return;
  if (e.target.closest("[data-spassign]")) { dialogo(r); return; }
  const sg = e.target.closest("[data-spsug]");
  if (sg) { const s = DATA.asignaciones[r.session_id].sugerencias[Number(sg.dataset.spsug)]; dialogo(r, { project: s.project, hilo: s.hilo }); return; }
  if (e.target.closest("[data-spunassign]")) {
    if (!window.confirm("¿Quitar la asignación de esta sesión? (El hilo conserva lo ya resumido.)")) return;
    const res = await post("/api/flujos/desasignar", { session: r.session_id });
    toast(res.ok ? "Asignación quitada" : `No se pudo (${res.reason})`, res.ok ? "check" : "alert");
    refresh(true); return;
  }
  const sv = e.target.closest("[data-spsave]");
  if (sv && !sv.disabled) { sv.disabled = true; try { await terminarSesion(r, { cerrar: sv.dataset.spsave !== "solo" }); } finally { sv.disabled = false; } }
});
