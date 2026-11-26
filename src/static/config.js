// Configuracion publica del servidor (va en <meta name="panel-config"> del HTML; ver config.mjs → publicConfig).
const raw = document.querySelector('meta[name="panel-config"]')?.content ?? "";
let cfg = {};
try { cfg = JSON.parse(raw); } catch {}
export const CFG = {
  perfil: "default", vscode_label: "VS Code", flujos_dir: "", limits: { ficha: 4500, hilo: 5500 },
  brief_migracion: "", extractor: "", historial: false, escriba: false, teclado: true,
  links_via_server: false, ado: false, ...cfg,
};
CFG.tags = { types: ["proyectos-de-mejora", "entregas", "soporte", "gestion"], groups: [], ...(cfg.tags ?? {}) };
/** Perfil distinto del normal (p. ej. un sandbox con su propio CLAUDE_CONFIG_DIR). */
export const IS_ALT_PROFILE = CFG.perfil !== "default";

// En un perfil alternativo, una marca visible junto al nombre del panel (para no confundirlo con el normal).
if (IS_ALT_PROFILE) {
  const b = document.querySelector(".topbar .brand");
  const label = String(CFG.perfil).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 12);
  if (b && !b.querySelector(".lab-badge")) b.insertAdjacentHTML("beforeend", ` <span class="pill necesita_input lab-badge" title="Perfil ${label}">${label}</span>`);
}
