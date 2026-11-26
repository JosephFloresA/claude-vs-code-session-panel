/**
 * Rutas del esqueleto: HTML del panel (con token y configuracion publica), archivos estaticos, /ver y /health.
 *   GET /                 panel HTML (se relee en cada pedido: editarlo no exige reiniciar)
 *   GET /static/<archivo> front (solo nombres simples dentro de static/)
 *   GET /ver/<ruta>       archivo generado por una sesion (solo los autorizados por resolveServable)
 *   GET /api/config       configuracion publica (perfil, rutas de flujos, interruptores)
 *   GET /health           ok
 *   GET /api/diagnostico  version, rutas efectivas e integraciones activas
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, describeConfig, publicConfig } from "../config.mjs";
import { collectSessions, resolveServable } from "../core.mjs";
import { hasConfiguredRoots, roots } from "../workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const HTML = path.join(ROOT, "dashboard.html");
const STATIC = path.join(ROOT, "static");
const MIME = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const VIEW_MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  pdf: "application/pdf", json: "application/json; charset=utf-8", csv: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function register(router, { token }) {
  const page = (c) => {
    const cfg = publicConfig();
    let html = fs.readFileSync(HTML, "utf8").replace("{{MONITOR_TOKEN}}", token.value).replace("{{PANEL_CONFIG}}", attr(JSON.stringify(cfg)));
    // Un perfil distinto del normal (p. ej. un sandbox) se marca en el titulo para no confundirlo.
    if (cfg.perfil !== "default") html = html.replace("<title>Sesiones de Claude</title>", `<title>${attr(cfg.perfil.toUpperCase())} · Sesiones de Claude</title>`);
    c.send(200, "text/html; charset=utf-8", html);
  };
  router.get("/", page);
  router.get("/index.html", page);
  router.get("/health", (c) => c.send(200, "text/plain", "ok"));
  router.get("/api/config", (c) => c.json(200, publicConfig()));
  // Rutas efectivas e integraciones activas: para diagnosticar una instalacion (sin secretos).
  router.get("/api/diagnostico", (c) => c.json(200, { version: VERSION, node: process.version, ...describeConfig(),
    workspace_roots_effective: roots(), workspace_roots_mode: hasConfiguredRoots() ? "configuradas" : "automaticas" }));

  router.get(/^\/static\/([a-z0-9_-]+\.(?:js|css|svg))$/i, (c) => {
    const file = path.join(STATIC, c.params[0]);
    if (!fs.existsSync(file)) { c.send(404, "text/plain", "no encontrado"); return; }
    c.send(200, MIME[path.extname(file)] ?? "application/octet-stream", fs.readFileSync(file));
  });

  // /ver/C:/ruta/al/archivo.html. Las rutas relativas de un HTML (css, imagenes) caen en la misma ruta.
  router.get(/^\/ver\/(.+)$/, (c) => {
    const requested = decodeURIComponent(c.url.pathname.slice(5));
    const real = resolveServable(requested, collectSessions({ hours: 168, includeArchived: true }).sessions);
    if (!real) { c.send(404, "text/plain; charset=utf-8", "No disponible: el archivo no fue generado por una sesión, no existe o no se permite."); return; }
    const ext = path.extname(real).slice(1).toLowerCase();
    c.res.writeHead(200, {
      "content-type": VIEW_MIME[ext] ?? "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // El contenido corre en un origen opaco: no puede llamar a la API del panel.
      "content-security-policy": "sandbox allow-scripts allow-popups allow-forms allow-modals",
    });
    fs.createReadStream(real).pipe(c.res);
  });
}
