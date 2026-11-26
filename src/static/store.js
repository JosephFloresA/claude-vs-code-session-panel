// Ajustes del panel (localStorage). Todo lo personalizable vive aqui.
const KEY = "monitor-sesiones:v2";

export const STATES = ["necesita_input", "esperando", "trabajando", "en_pausa", "vacia", "cerrada"];
export const STATE_LABEL = {
  necesita_input: "Te necesita", esperando: "Tu turno", trabajando: "Trabajando",
  en_pausa: "En pausa", vacia: "Sin uso", cerrada: "Cerrada",
};

export const FIELDS = {
  proyecto: "Proyecto (repos)",
  accion: "Qué está haciendo ahora",
  pedido: "Tu último pedido",
  respuesta: "Última respuesta de Claude",
  ab: "Work items (AB#)",
  prs: "Pull requests",
  contexto: "Uso de contexto",
  archivos: "Archivos editados",
  rama: "Rama git",
  git: "Git y PRs (cambios sin commit, estado de los PR)",
  nota: "Notas",
};

// Vistas que vienen de fabrica; las del usuario se agregan a continuacion.
export const BUILTIN_VIEWS = [
  { id: "todo", name: "Todo", icon: "◎", filter: {} },
  { id: "pendientes", name: "Pendientes", icon: "⚑", filter: { pending: true } },
  { id: "sinver", name: "Sin ver", icon: "●", filter: { onlyUnseen: true } },
  { id: "trabajando", name: "Trabajando", icon: "⟳", filter: { states: ["trabajando"] } },
  { id: "hoy", name: "Hoy", icon: "☀", filter: { today: true } },
];

const DEFAULTS = {
  layout: "bandeja",          // bandeja | tabla | tablero | archivos
  assetType: "todos",         // filtro de la vista Archivos
  theme: "dark",              // system | light | dark (oscuro por defecto: recomendacion del sistema de diseño)
  density: "comoda",          // comoda | compacta
  fields: { proyecto: true, accion: true, pedido: true, respuesta: true, ab: true, prs: true, contexto: true, archivos: true, rama: false, nota: true, git: true },
  quickReplies: ["dale", "sí, continúa", "súbelo", "explícamelo más corto", "¿qué falta para terminar?", "no, espera"],
  views: [],                  // vistas guardadas por el usuario: { id, name, icon, filter }
  activeView: "todo",
  hiddenViews: [],            // vistas de fabrica ocultas
  projectColors: {},          // repo -> #rrggbb elegido por la persona
  autoColors: {},             // repo -> color asignado automaticamente (estable, sin repetir mientras alcance la paleta)
  kanban: { groupBy: "estado", focus: false, order: {} },
  table: { sort: "prioridad", dir: 1 },
  collapsed: { cerrada: true },
  notify: { enabled: false, sound: true, onlyHidden: false, necesita: true, termino: true, pregunta: true, sinver: false },
  thresholds: { pausaH: 3, conflictoH: 24, contextoPct: 85, cerradasH: 12 },
  showArchived: false,
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = merge(base[k], over[k]);
  return out;
}

export const settings = merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || "{}"));
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export function save(patchFn) {
  if (patchFn) patchFn(settings);
  localStorage.setItem(KEY, JSON.stringify(settings));
  for (const fn of listeners) fn();
}
export const resetSettings = () => { localStorage.removeItem(KEY); location.reload(); };
export const exportSettings = () => JSON.stringify(settings, null, 2);
export function importSettings(text) {
  const obj = JSON.parse(text);
  localStorage.setItem(KEY, JSON.stringify(merge(DEFAULTS, obj)));
  location.reload();
}

export const allViews = () => [
  ...BUILTIN_VIEWS.filter((v) => !settings.hiddenViews.includes(v.id)),
  ...settings.views,
];

// Paleta pensada para distinguirse en claro y oscuro.
const PALETTE = ["#4f7cff", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a5b0", "#a3e635", "#7c8b2c", "#d9730d", "#5b6b85"];
export function projectColor(repo) {
  if (!repo) return "transparent";
  if (settings.projectColors[repo]) return settings.projectColors[repo];
  if (!settings.autoColors[repo]) {
    // El primer color de la paleta que nadie use; si se acaban, el menos usado.
    const used = Object.values(settings.autoColors);
    const free = PALETTE.find((c) => !used.includes(c))
      ?? PALETTE.reduce((a, b) => (used.filter((x) => x === a).length <= used.filter((x) => x === b).length ? a : b));
    settings.autoColors[repo] = free;
    localStorage.setItem(KEY, JSON.stringify(settings));
  }
  return settings.autoColors[repo];
}

export function applyTheme() {
  let t = settings.theme;
  if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (!["light", "dark", "alto-contraste"].includes(t)) t = "dark";
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.density = settings.density;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
