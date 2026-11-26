// Panel de ajustes: apariencia, datos visibles, colores, vistas, avisos y umbrales.
import { settings, save, FIELDS, BUILTIN_VIEWS, projectColor, resetSettings, exportSettings, importSettings } from "./store.js";
import { esc, toast } from "./ui.js";
import { icon, VIEW_ICON } from "./icons.js";

const TABS = [
  ["apariencia", "Apariencia"], ["datos", "Datos"], ["colores", "Colores"],
  ["vistas", "Vistas"], ["avisos", "Avisos"], ["umbrales", "Umbrales"],
];
let tab = "apariencia";
const NL = String.fromCharCode(10);

const sw = (path, on) => `<label class="switch"><input type="checkbox" data-path="${path}" ${on ? "checked" : ""}><i></i></label>`;
const field = (title, hint, control) => `<div class="field"><div class="lbl"><b>${title}</b>${hint ? `<span>${hint}</span>` : ""}</div>${control}</div>`;
const select = (path, value, opts) => `<select class="input" data-path="${path}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("")}</select>`;
const number = (path, value, min, max, step = 1) => `<input class="input num" type="number" data-path="${path}" value="${value}" min="${min}" max="${max}" step="${step}">`;

function pane(knownRepos) {
  const s = settings;
  switch (tab) {
    case "apariencia": return [
      field("Vista", "Cómo se organizan las sesiones (también con <kbd>g</kbd>)", select("layout", s.layout, [["bandeja", "Bandeja + detalle"], ["tabla", "Tabla"], ["tablero", "Tablero"], ["archivos", "Archivos generados"], ["proyectos", "Proyectos (ficha + hilos)"]])),
      field("Tema", "Oscuro es el recomendado para uso prolongado", select("theme", s.theme, [["dark", "Oscuro"], ["light", "Claro"], ["alto-contraste", "Alto contraste (VS Code)"], ["system", "Según el sistema"]])),
      field("Densidad", "Compacta muestra más sesiones por pantalla", select("density", s.density, [["comoda", "Cómoda"], ["compacta", "Compacta"]])),
      field("Tablero: agrupar por", "", select("kanban.groupBy", s.kanban.groupBy, [["estado", "Estado"], ["proyecto", "Proyecto"]])),
      field("Tablero: modo foco", "Oculta lo que está en pausa o cerrado", sw("kanban.focus", s.kanban.focus)),
      field("Mostrar archivadas", "", sw("showArchived", s.showArchived)),
      field("Orden manual del tablero", "Olvida lo que reordenaste arrastrando", `<button class="btn" data-do="reset-order">Restablecer</button>`),
    ].join("");
    case "datos": return `<p class="muted">Qué información aparece en la lista, la tabla, el tablero y el detalle.</p>` +
      Object.entries(FIELDS).map(([k, label]) => field(label, "", sw(`fields.${k}`, s.fields[k] !== false))).join("") +
      `<h4>Respuestas rápidas</h4><p class="muted">Una por línea. Aparecen como botones en «Responder».</p>
      <textarea class="input" rows="6" style="width:100%" data-quickreplies>${esc((s.quickReplies ?? []).join(NL))}</textarea>`;
    case "colores": return `<p class="muted">Cada proyecto recibe un color automático; aquí puedes fijar el tuyo.</p>` +
      (knownRepos.length ? knownRepos.map((repo) => field(esc(repo), s.projectColors[repo] ? "personalizado" : "automático",
        `<span style="display:flex;gap:6px;align-items:center"><input type="color" class="color" data-color="${esc(repo)}" value="${projectColor(repo)}">
        ${s.projectColors[repo] ? `<button class="btn icon" data-uncolor="${esc(repo)}" title="Volver al automático">${icon("rotate")}</button>` : ""}</span>`)).join("")
        : `<div class="empty">Todavía no hay proyectos detectados.</div>`);
    case "vistas": return `<p class="muted">Cambia de vista con <kbd>1</kbd>…<kbd>9</kbd>. Para crear una, filtra arriba y pulsa <b>Guardar vista</b>.</p>
      <h4>De fábrica</h4>${BUILTIN_VIEWS.map((v) => `<div class="viewrow">${icon(VIEW_ICON[v.id] ?? "star")}<span class="name">${esc(v.name)}</span>${sw(`hide:${v.id}`, !s.hiddenViews.includes(v.id))}</div>`).join("")}
      <h4>Tuyas</h4>${s.views.length ? s.views.map((v) => `<div class="viewrow">${icon("star")}
        <input class="input name" data-vname="${esc(v.id)}" value="${esc(v.name)}"><button class="btn danger" data-vdel="${esc(v.id)}">Borrar</button></div>`).join("")
        : `<div class="muted">Aún no guardas ninguna.</div>`}`;
    case "avisos": return [
      field("Avisos del navegador", "Notificación de Windows desde esta pestaña (debe quedar abierta)", sw("notify.enabled", s.notify.enabled)),
      field("Sonido", "", sw("notify.sound", s.notify.sound)),
      field("Solo si la pestaña no está a la vista", "", sw("notify.onlyHidden", s.notify.onlyHidden)),
      `<h4>Avisar cuando…</h4>`,
      field("Pide permiso o una respuesta", "", sw("notify.necesita", s.notify.necesita)),
      field("Termina un turno", "", sw("notify.termino", s.notify.termino)),
      field("Termina con una pregunta para ti", "", sw("notify.pregunta", s.notify.pregunta)),
      field("Queda una sesión sin ver", "Marca de la extensión de VS Code", sw("notify.sinver", s.notify.sinver)),
      field("Probar", "", `<button class="btn" data-do="test-notify">Enviar aviso de prueba</button>`),
    ].join("");
    case "umbrales": return [
      field("Pasa a «en pausa» tras", "horas sin respuesta tuya", number("thresholds.pausaH", s.thresholds.pausaH, 0.25, 168, 0.25)),
      field("Conflicto si editan lo mismo en", "horas", number("thresholds.conflictoH", s.thresholds.conflictoH, 1, 168)),
      field("Avisar contexto desde", "% de la ventana", number("thresholds.contextoPct", s.thresholds.contextoPct, 30, 100, 5)),
      field("Mostrar cerradas de las últimas", "horas", number("thresholds.cerradasH", s.thresholds.cerradasH, 1, 168)),
      `<h4>Respaldo</h4>`,
      field("Exportar ajustes", "Copia un JSON con todo (vistas, colores…)", `<button class="btn" data-do="export">Copiar</button>`),
      field("Importar ajustes", "Pega un JSON exportado", `<button class="btn" data-do="import">Importar</button>`),
      field("Restablecer todo", "", `<button class="btn danger" data-do="reset">Restablecer</button>`),
    ].join("");
    default: return "";
  }
}

function setPath(path, value) {
  save((s) => {
    const parts = path.split(".");
    let o = s;
    for (const p of parts.slice(0, -1)) o = o[p];
    o[parts.at(-1)] = value;
  });
}

export function openSettings(knownRepos, onTestNotify) {
  let el = document.getElementById("settings");
  const render = () => {
    el.querySelector(".stabs").innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("");
    el.querySelector(".spane").innerHTML = pane(knownRepos());
  };
  el.classList.add("open");
  document.getElementById("scrim").classList.remove("hidden");
  render();
  el.onclick = async (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; render(); return; }
    if (e.target.closest("[data-close]")) { closeSettings(); return; }
    const un = e.target.closest("[data-uncolor]");
    if (un) { save((s) => { delete s.projectColors[un.dataset.uncolor]; }); render(); return; }
    const del = e.target.closest("[data-vdel]");
    if (del) { save((s) => { s.views = s.views.filter((v) => v.id !== del.dataset.vdel); if (s.activeView === del.dataset.vdel) s.activeView = "todo"; }); render(); return; }
    const d = e.target.closest("[data-do]")?.dataset.do;
    if (d === "reset-order") { save((s) => { s.kanban.order = {}; }); toast("Orden restablecido"); }
    if (d === "test-notify") onTestNotify();
    if (d === "export") { await navigator.clipboard?.writeText(exportSettings()); toast("Ajustes copiados"); }
    if (d === "import") { const t = prompt("Pega aquí el JSON de ajustes:"); if (t) { try { importSettings(t); } catch { toast("JSON inválido"); } } }
    if (d === "reset" && confirm("¿Restablecer todos los ajustes del panel?")) resetSettings();
  };
  el.onchange = (e) => {
    const x = e.target;
    if (x.dataset.color) { save((s) => { s.projectColors[x.dataset.color] = x.value; }); render(); return; }
    if (x.dataset.quickreplies !== undefined) { save((s) => { s.quickReplies = x.value.split(NL).map((l) => l.trim()).filter(Boolean).slice(0, 12); }); return; }
    if (x.dataset.vname) { save((s) => { s.views.find((v) => v.id === x.dataset.vname).name = x.value || "Vista"; }); return; }
    if (x.dataset.vicon) { save((s) => { s.views.find((v) => v.id === x.dataset.vicon).icon = x.value.slice(0, 2) || "★"; }); return; }
    const p = x.dataset.path;
    if (!p) return;
    if (p.startsWith("hide:")) {
      const id = p.slice(5);
      save((s) => { s.hiddenViews = x.checked ? s.hiddenViews.filter((v) => v !== id) : [...s.hiddenViews, id]; });
      return;
    }
    const value = x.type === "checkbox" ? x.checked : x.type === "number" ? Number(x.value) : x.value;
    setPath(p, value);
    if (p === "notify.enabled" && value && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  };
}

export function closeSettings() {
  document.getElementById("settings").classList.remove("open");
  if (!document.querySelector(".drawer.open")) document.getElementById("scrim").classList.add("hidden");
}
