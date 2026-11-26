/**
 * Pseudoproyectos — escrituras. Cada funcion escribe en disco y llama a registrar() (historial.mjs), que deja
 * un commit con el actor (panel | escriba | chat | sistema), la accion, el proyecto y el hilo.
 *
 * Funciones (todas devuelven { ok, reason?, ... }):
 *   createProyecto(slug, title, objetivo, semillas)     ficha estandar + hilos/ vacio
 *   createHilo(project, name, objetivo)                 hilos/<name>.md + fila en la tabla de la ficha
 *   saveHilo(project, file, markdown, mtime)            guarda si nadie lo cambio desde mtime
 *   moveHilo(project, file, destino)                    archivo + fila de la tabla a otro proyecto
 *   archiveHilo(project, file)                          a <proyecto>/.archivo/ (recuperable) y fuera de la tabla
 *   releaseReserva(project, line)                       quita una linea de "En curso / reservas"
 *   writeHiloEscriba(project, file, markdown, detalle)  escritura del escribano
 *   writeFichaEscriba(project, markdown, detalle)       ficha consolidada por el escribano («Terminar sesion»)
 *   restaurar(hash, archivo)                            vuelve una ficha, un hilo o proyecto.json a su version de un commit
 *   setEtiquetas(project, etiquetas)                    proyecto.json: reemplaza las etiquetas
 *   vincularHistoria(project, id, info) / desvincularHistoria(project, id)   proyecto.json: historias de usuario (AB#)
 * El ultimo argumento opcional { actor } cambia el autor registrado (por defecto "panel").
 */
import fs from "node:fs";
import path from "node:path";
import { FLUJOS_DIR, LIMITS, META_FILE, SLUG, cells, mapaAsignadas, norm, read, readMeta } from "./modelo.mjs";
import { contenidoEn, registrar } from "./historial.mjs";

const HFILE = /^[\w.-]+\.md$/;
const HNAME = /^[a-z0-9][a-z0-9-]{1,60}$/;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
const hoy = () => new Date().toISOString().slice(0, 10);
const oneLine = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const fichaPath = (project) => path.join(FLUJOS_DIR, project, "ficha.md");

/** Ruta del hilo validada (proyecto y archivo simples; el archivo debe existir). */
function hiloPath(project, file) {
  if (!SLUG.test(String(project ?? "")) || String(project).startsWith(".") || !HFILE.test(String(file ?? ""))) return null;
  const p = path.join(FLUJOS_DIR, project, "hilos", file);
  return fs.existsSync(p) ? p : null;
}

/** Fila de la tabla "## Hilos" que corresponde a un archivo de hilo (por enlace o por nombre). */
function findHiloRow(lines, file) {
  const name = file.replace(/\.md$/, "");
  let inSec = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { inSec = norm(lines[i].replace(/^##\s+/, "")).startsWith("hilos"); continue; }
    if (!inSec || !/^\s*\|/.test(lines[i]) || /^\s*\|\s*-/.test(lines[i])) continue;
    const c = cells(lines[i]);
    if (c[0]?.replace(/[`*]/g, "") === "Hilo") continue;
    const link = (c[3]?.match(/\(([^)]+\.md)\)/) ?? [])[1];
    if ((link && path.basename(link) === file) || c[0]?.replace(/[`*]/g, "") === name) return i;
  }
  return -1;
}

/** Agrega una fila al final de la tabla "## Hilos" (la crea si la ficha no la tiene). */
function addHiloRow(md, row) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+/.test(l) && norm(l.replace(/^##\s+/, "")).startsWith("hilos"));
  if (start < 0) return md.replace(/\n*$/, "\n\n## Hilos\n| Hilo | Sesión | Estado | Bitácora |\n|---|---|---|---|\n" + row + "\n");
  let last = start;
  for (let i = start + 1; i < lines.length && !/^##\s+/.test(lines[i]); i++) if (/^\s*\|/.test(lines[i])) last = i;
  if (last === start) lines.splice(start + 1, 0, "| Hilo | Sesión | Estado | Bitácora |", "|---|---|---|---|", row);
  else lines.splice(last + 1, 0, row);
  return lines.join("\n");
}

function registerHiloRow(project, name, estado = "Nuevo") {
  const fp = fichaPath(project);
  const md = read(fp);
  const file = `${name}.md`;
  if (md === null || findHiloRow(md.split("\n"), file) >= 0) return false;
  fs.writeFileSync(fp, addHiloRow(md, `| ${name} | — | ${estado} | [hilos/${file}](hilos/${file}) |`), "utf8");
  return true;
}

// ---------------------------------------------------------------------------------------------------------

export function createProyecto(slug, title, objetivo = "", semillas = [], { actor = "panel", etiquetas = [] } = {}) {
  const s = String(slug ?? "").trim().toLowerCase();
  const t = oneLine(title, 120);
  if (!/^[a-z0-9][a-z0-9_-]{2,60}$/.test(s) || !t) return { ok: false, reason: "parametros" };
  const ids = [...new Set((Array.isArray(semillas) ? semillas : []).map((x) => String(x).trim().toLowerCase().slice(0, 8)).filter((x) => /^[0-9a-f]{8}$/.test(x)))].slice(0, 20);
  const base = path.join(FLUJOS_DIR, s);
  if (fs.existsSync(path.join(base, "ficha.md"))) return { ok: false, reason: "ya_existe" };
  fs.mkdirSync(path.join(base, "hilos"), { recursive: true });
  const obj = oneLine(objetivo, 600) || "(por definir)";
  const origen = ids.length ? `creado desde el panel; se arma desde las sesiones ${ids.join(", ")}` : "creado desde el panel";
  fs.writeFileSync(path.join(base, "ficha.md"), `# Ficha · ${t}

> Estado vivo del pseudoproyecto. **Se reescribe, no se agrega.** Máximo ~1,5k tokens.
> Actualizada: ${hoy()} (${origen}).

## Objetivo
${obj}

## Estado actual
**Nuevo.** ${ids.length ? "Pendiente de armar desde sus sesiones." : "Sin trabajo registrado aún."}

## Decisiones vigentes
- (ninguna)

## Bloqueos
- (ninguno)

## Inconsistencias detectadas
- (ninguna)

## En curso / reservas
- (vacío) Formato: \`- [AAAA-MM-DD HH:MM] hilo · repo/ruta · motivo\` — se libera al cerrar; vence a las 24 h.

## Próximos pasos
1. ${ids.length ? "Armar la ficha y los hilos desde las sesiones semilla." : "Definir el primer hilo de trabajo."}

## Hilos
| Hilo | Sesión | Estado | Bitácora |
|---|---|---|---|
`, "utf8");
  const tags = [...new Set((Array.isArray(etiquetas) ? etiquetas : []).map(normEtiqueta).filter(Boolean))].slice(0, 15);
  if (tags.length) writeMeta(s, { etiquetas: tags, historias: [] });
  registrar({ accion: "crear_proyecto", actor, proyecto: s, detalle: `${t}${ids.length ? ` · semillas ${ids.join(", ")}` : ""}${tags.length ? ` · ${tags.join(", ")}` : ""}`, rutas: [s] });
  return { ok: true, slug: s, title: t, ficha_path: path.join(base, "ficha.md"), semillas: ids };
}

/** Crea hilos/<nombre>.md vacio y su fila en la tabla (el escribano lo llena desde el primer chat que lo nombre). */
export function createHilo(project, name, objetivo = "", { actor = "panel" } = {}) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!SLUG.test(String(project ?? "")) || !HNAME.test(n)) return { ok: false, reason: "parametros" };
  const base = path.join(FLUJOS_DIR, project);
  if (!fs.existsSync(path.join(base, "ficha.md"))) return { ok: false, reason: "no_existe" };
  const p = path.join(base, "hilos", `${n}.md`);
  if (fs.existsSync(p)) return { ok: true, existed: true, name: n };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const obj = oneLine(objetivo, 400) || "(por definir)";
  fs.writeFileSync(p, `# Hilo: ${n}

- **Sesiones:** (ninguna aún) · **Rango de fechas:** ${hoy()}
- **Estado del hilo:** nuevo

## Objetivo del hilo
${obj}

## Estado al cierre

## Decisiones tomadas

## Hallazgos y datos clave

## Pendientes y bloqueos

## Qué toca este hilo

## Dónde buscar detalle exacto
`, "utf8");
  registerHiloRow(project, n);
  registrar({ accion: "crear_hilo", actor, proyecto: project, hilo: n, detalle: obj, rutas: [p, fichaPath(project)] });
  return { ok: true, existed: false, name: n };
}

/**
 * Guarda el texto de un hilo editado a mano. mtime = el que tenia al abrir el editor: si cambio desde entonces
 * (el escribano lo reescribio), no se pisa y se devuelve "cambiado" con la version actual.
 */
export function saveHilo(project, file, markdown, mtime, { actor = "panel" } = {}) {
  const p = hiloPath(project, file);
  if (!p) return { ok: false, reason: "no_existe" };
  if (typeof markdown !== "string" || !markdown.trim()) return { ok: false, reason: "vacio" };
  if (markdown.length > 50_000) return { ok: false, reason: "demasiado_largo" };
  const cur = fs.statSync(p).mtime.toISOString();
  if (mtime && cur !== mtime) return { ok: false, reason: "cambiado", mtime: cur, markdown: read(p) };
  const before = read(p) ?? "";
  fs.writeFileSync(p, markdown.replace(/\r/g, ""), "utf8");
  registrar({ accion: "editar_hilo", actor, proyecto: project, hilo: file.replace(/\.md$/, ""),
    detalle: `${before.length} → ${markdown.length} caracteres`, rutas: [p] });
  return { ok: true, chars: markdown.length, over: markdown.length > LIMITS.hilo, mtime: fs.statSync(p).mtime.toISOString() };
}

/** Mover un hilo a otro proyecto, con su fila de la tabla (la sesion origen viaja con ella). */
export function moveHilo(project, file, destino, { actor = "panel" } = {}) {
  const p = hiloPath(project, file);
  if (!p) return { ok: false, reason: "no_existe" };
  if (!SLUG.test(String(destino ?? "")) || destino === project || String(destino).startsWith(".")) return { ok: false, reason: "destino" };
  const dfp = fichaPath(destino);
  if (!fs.existsSync(dfp)) return { ok: false, reason: "destino_no_existe" };
  const dest = path.join(FLUJOS_DIR, destino, "hilos", file);
  if (fs.existsSync(dest)) return { ok: false, reason: "ya_existe_en_destino" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // La ficha de origen se lee antes de mover para no perder la fila si algo falla a medio camino.
  const fp = fichaPath(project);
  const md = read(fp) ?? "";
  const lines = md.split("\n"); const i = findHiloRow(lines, file);
  const name = file.replace(/\.md$/, "");
  let row = i >= 0 ? lines[i] : `| ${name} | — | (movido desde ${project}) | [hilos/${file}](hilos/${file}) |`;
  if (i >= 0) {
    const c = cells(row); c[2] = `${c[2] ?? ""} (desde ${project})`.trim();
    c[3] = `[hilos/${file}](hilos/${file})`;
    row = `| ${c.join(" | ")} |`;
  }
  fs.renameSync(p, dest);
  if (i >= 0) { lines.splice(i, 1); fs.writeFileSync(fp, lines.join("\n"), "utf8"); }
  const dmd = read(dfp) ?? "";
  if (findHiloRow(dmd.split("\n"), file) < 0) fs.writeFileSync(dfp, addHiloRow(dmd, row), "utf8");
  registrar({ accion: "mover_hilo", actor, proyecto: destino, hilo: name, detalle: `${project} → ${destino}`, rutas: [p, dest, fp, dfp],
    extra: { Desde: `${project}/hilos/${file}` } });
  return { ok: true, moved_to: dest };
}

/** Sacar un hilo: el archivo pasa a <proyecto>/.archivo/ (recuperable) y su fila sale de la tabla de la ficha. */
export function archiveHilo(project, file, { actor = "panel" } = {}) {
  const p = hiloPath(project, file);
  if (!p) return { ok: false, reason: "no_existe" };
  const dir = path.join(FLUJOS_DIR, project, ".archivo");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${file.replace(/\.md$/, "")}.${stamp()}.md`);
  fs.renameSync(p, dest);
  const fp = fichaPath(project);
  const md = read(fp);
  let row = null;
  if (md !== null) {
    const lines = md.split("\n"); const i = findHiloRow(lines, file);
    if (i >= 0) { row = lines[i]; lines.splice(i, 1); fs.writeFileSync(fp, lines.join("\n"), "utf8"); }
  }
  registrar({ accion: "sacar_hilo", actor, proyecto: project, hilo: file.replace(/\.md$/, ""), detalle: `a ${path.basename(dir)}/${path.basename(dest)}`, rutas: [p, dest, fp] });
  return { ok: true, archived_to: dest, row };
}

/** Quita una reserva exacta (misma linea) de la seccion "En curso / reservas". */
export function releaseReserva(project, line, { actor = "panel" } = {}) {
  if (!SLUG.test(String(project ?? "")) || typeof line !== "string" || !line.trim()) return { ok: false, reason: "parametros" };
  const p = fichaPath(project);
  const md = read(p);
  if (md === null) return { ok: false, reason: "no_existe" };
  const lines = md.split("\n");
  let inSec = false, idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) inSec = norm(lines[i].replace(/^##\s+/, "")).startsWith("en curso");
    else if (inSec && /^\s*-\s+/.test(lines[i]) && lines[i].replace(/^\s*-\s+/, "").trim() === line.trim()) { idx = i; break; }
  }
  if (idx < 0) return { ok: false, reason: "no_encontrada" };
  lines.splice(idx, 1);
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  registrar({ accion: "liberar_reserva", actor, proyecto: project, detalle: line.trim(), rutas: [p] });
  return { ok: true };
}

// ---------- proyecto.json: etiquetas e historias de usuario ----------
const metaPath = (project) => path.join(FLUJOS_DIR, project, META_FILE);
function writeMeta(project, meta) {
  const p = metaPath(project);
  const out = { etiquetas: meta.etiquetas ?? [], historias: meta.historias ?? [], chats: meta.chats ?? [] };
  fs.writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return p;
}
/** "Tracking DCH " -> "tracking-dch". Letras (con tildes), numeros, _ y -; hasta 30 caracteres. */
export function normEtiqueta(t) {
  return String(t ?? "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]+/gu, "").replace(/^-+|-+$/g, "").slice(0, 30);
}
/** "AB#82637", "82637" o la URL del work item -> 82637. */
export function parseWorkItemId(v) {
  const m = String(v ?? "").match(/(?:AB#|_workitems\/edit\/|^)\s*(\d{4,7})\b/i);
  return m ? Number(m[1]) : null;
}

/** Reemplaza las etiquetas del proyecto (normalizadas, sin duplicados, maximo 15). */
export function setEtiquetas(project, etiquetas, { actor = "panel" } = {}) {
  if (!SLUG.test(String(project ?? "")) || !Array.isArray(etiquetas)) return { ok: false, reason: "parametros" };
  if (!fs.existsSync(fichaPath(project))) return { ok: false, reason: "no_existe" };
  const meta = readMeta(project);
  const nuevas = [...new Set(etiquetas.map(normEtiqueta).filter(Boolean))].slice(0, 15);
  if (JSON.stringify(nuevas) === JSON.stringify(meta.etiquetas)) return { ok: true, etiquetas: nuevas, sin_cambios: true };
  const quitadas = meta.etiquetas.filter((t) => !nuevas.includes(t)), puestas = nuevas.filter((t) => !meta.etiquetas.includes(t));
  const p = writeMeta(project, { ...meta, etiquetas: nuevas });
  registrar({ accion: "etiquetas", actor, proyecto: project,
    detalle: [puestas.length ? `+${puestas.join(" +")}` : "", quitadas.length ? `-${quitadas.join(" -")}` : ""].filter(Boolean).join(" "), rutas: [p] });
  return { ok: true, etiquetas: nuevas };
}

/** Vincula un work item (normalmente una User Story) al proyecto. `info` = lo leido de ADO, para el registro. */
export function vincularHistoria(project, id, info = {}, { actor = "panel" } = {}) {
  const n = parseWorkItemId(id);
  if (!SLUG.test(String(project ?? "")) || !n) return { ok: false, reason: "parametros" };
  if (!fs.existsSync(fichaPath(project))) return { ok: false, reason: "no_existe" };
  const meta = readMeta(project);
  if (meta.historias.some((h) => h.id === n)) return { ok: false, reason: "ya_vinculada" };
  const p = writeMeta(project, { ...meta, historias: [...meta.historias, { id: n, vinculada: hoy() }] });
  registrar({ accion: "vincular_historia", actor, proyecto: project,
    detalle: `AB#${n}${info.title ? ` · ${oneLine(info.title, 120)}` : ""}${info.type ? ` (${info.type})` : ""}`, rutas: [p] });
  return { ok: true, id: n };
}

export function desvincularHistoria(project, id, { actor = "panel" } = {}) {
  const n = parseWorkItemId(id);
  if (!SLUG.test(String(project ?? "")) || !n) return { ok: false, reason: "parametros" };
  const meta = readMeta(project);
  if (!meta.historias.some((h) => h.id === n)) return { ok: false, reason: "no_vinculada" };
  const p = writeMeta(project, { ...meta, historias: meta.historias.filter((h) => h.id !== n) });
  registrar({ accion: "desvincular_historia", actor, proyecto: project, detalle: `AB#${n}`, rutas: [p] });
  return { ok: true, id: n };
}

/** Vincula varias de una vez (un solo commit). `infos` = { id: info de ADO } para el registro. */
export function vincularHistorias(project, ids, infos = {}, { actor = "panel" } = {}) {
  if (!SLUG.test(String(project ?? "")) || !Array.isArray(ids)) return { ok: false, reason: "parametros" };
  if (!fs.existsSync(fichaPath(project))) return { ok: false, reason: "no_existe" };
  const meta = readMeta(project);
  const nuevas = [...new Set(ids.map(parseWorkItemId).filter(Boolean))].filter((n) => !meta.historias.some((h) => h.id === n)).slice(0, 40);
  if (!nuevas.length) return { ok: true, ids: [], sin_cambios: true };
  const p = writeMeta(project, { ...meta, historias: [...meta.historias, ...nuevas.map((id) => ({ id, vinculada: hoy() }))] });
  registrar({ accion: "vincular_historia", actor, proyecto: project,
    detalle: nuevas.map((n) => `AB#${n}${infos[n]?.title ? ` ${oneLine(infos[n].title, 60)}` : ""}`).join(" · "), rutas: [p] });
  return { ok: true, ids: nuevas };
}

// ---------- asignacion de sesiones (chats) a un proyecto/hilo ----------
const SID = /^[0-9a-f-]{36}$/i;

/**
 * Asigna una sesion a un proyecto (y opcionalmente a un hilo). Una sesion pertenece a un solo proyecto: si estaba
 * en otro, sale de alli en el mismo commit. Con hilo, el escribano empieza a resumirla en ese hilo.
 */
export function asignarSesion(project, sessionId, hilo = null, { actor = "panel", titulo = "" } = {}) {
  const sid = String(sessionId ?? "").toLowerCase();
  if (!SLUG.test(String(project ?? "")) || !SID.test(sid)) return { ok: false, reason: "parametros" };
  if (!fs.existsSync(fichaPath(project))) return { ok: false, reason: "no_existe" };
  const h = hilo ? String(hilo).trim() : null;
  if (h && (!HNAME.test(h) && !/^[\w.-]+$/.test(h)
    || (!fs.existsSync(path.join(FLUJOS_DIR, project, "hilos", `${h}.md`)) && findHiloRow(read(fichaPath(project)).split("\n"), `${h}.md`) < 0)))
    return { ok: false, reason: "hilo_no_existe" };
  const rutas = [];
  let desde = null;
  for (const [otro, a] of mapaAsignadas()) {
    if (otro !== sid || a.project === project) continue;
    const m = readMeta(a.project);
    rutas.push(writeMeta(a.project, { ...m, chats: m.chats.filter((c) => c.id.toLowerCase() !== sid) }));
    desde = a.project;
  }
  const meta = readMeta(project);
  const prev = meta.chats.find((c) => c.id.toLowerCase() === sid);
  if (prev && (prev.hilo ?? null) === h && !desde) return { ok: true, sin_cambios: true };
  const chats = meta.chats.filter((c) => c.id.toLowerCase() !== sid).concat({ id: sid, hilo: h, asignada: hoy() });
  rutas.push(writeMeta(project, { ...meta, chats }));
  registrar({ accion: "asignar_sesion", actor, proyecto: project, hilo: h,
    detalle: `chat ${sid.slice(0, 8)}${titulo ? ` «${oneLine(titulo, 80)}»` : ""}${desde ? ` (antes en ${desde})` : ""}`, rutas });
  return { ok: true, project, hilo: h, desde };
}

export function desasignarSesion(sessionId, { actor = "panel" } = {}) {
  const sid = String(sessionId ?? "").toLowerCase();
  const a = mapaAsignadas().get(sid);
  if (!a) return { ok: false, reason: "no_asignada" };
  const m = readMeta(a.project);
  const p = writeMeta(a.project, { ...m, chats: m.chats.filter((c) => c.id.toLowerCase() !== sid) });
  registrar({ accion: "desasignar_sesion", actor, proyecto: a.project, hilo: a.hilo, detalle: `chat ${sid.slice(0, 8)}`, rutas: [p] });
  return { ok: true, project: a.project };
}

/** Escritura del escribano (ya valido el texto y que nadie lo cambio mientras resumia). */
export function writeHiloEscriba(project, file, markdown, detalle = "") {
  const p = path.join(FLUJOS_DIR, project, "hilos", file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, markdown, "utf8");
  registrar({ accion: "resumen_escriba", actor: "escriba", proyecto: project, hilo: file.replace(/\.md$/, ""), detalle, rutas: [p] });
}

/** Escritura de la ficha por el escribano («Terminar sesion»; ya valido reservas, tabla de hilos y mtime). */
export function writeFichaEscriba(project, markdown, detalle = "") {
  const p = fichaPath(project);
  fs.writeFileSync(p, markdown, "utf8");
  registrar({ accion: "consolidar_ficha", actor: "escriba", proyecto: project, detalle, rutas: [p] });
}

/** Restaura una ficha o un hilo a su contenido en un commit (queda como un cambio nuevo, no reescribe la historia). */
export async function restaurar(hash, archivo, { actor = "panel" } = {}) {
  const m = String(archivo ?? "").match(/^([\w.-]+)\/(ficha\.md|proyecto\.json|hilos\/[\w.-]+\.md)$/);
  if (!m || m[1].startsWith(".")) return { ok: false, reason: "ruta" };
  if (!fs.existsSync(fichaPath(m[1]))) return { ok: false, reason: "proyecto_no_existe" };
  const text = await contenidoEn(hash, archivo);
  if (text === null) return { ok: false, reason: "no_esta_en_ese_commit" };
  const p = path.join(FLUJOS_DIR, ...archivo.split("/"));
  const isHilo = m[2].startsWith("hilos/");
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  const rutas = [p];
  if (isHilo && !existed && registerHiloRow(m[1], path.basename(p, ".md"), "Restaurado")) rutas.push(fichaPath(m[1]));
  registrar({ accion: "restaurar", actor, proyecto: m[1], hilo: isHilo ? path.basename(p, ".md") : null,
    detalle: `${archivo} desde ${String(hash).slice(0, 10)}`, rutas });
  return { ok: true, chars: text.length, archivo };
}
