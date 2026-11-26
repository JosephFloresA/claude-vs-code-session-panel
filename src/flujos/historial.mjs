/**
 * Historial de cambios de los pseudoproyectos: la carpeta flujos/ es un repositorio git local y cada cambio
 * queda en un commit con QUIEN lo hizo y QUE accion fue.
 *
 *   Autor del commit = actor:  panel (tu, desde el panel) · escriba (resumen automatico) · chat (edicion externa:
 *                              un chat o tu a mano en el editor) · sistema (inicial, mantenimiento).
 *   Mensaje:  "<accion>: <proyecto>[/<hilo>]" + detalle + trailers Accion/Proyecto/Hilo/Actor.
 *
 * registrar() se llama justo despues de escribir y hace el commit EN EL MISMO MOMENTO (sincrono, ~0,1-0,3 s):
 * asi dos cambios seguidos nunca quedan mezclados en un commit con el actor equivocado. barrerExternos() corre
 * cada minuto y commitea lo que nadie registro, agrupado por proyecto, como actor "chat". Ademas cada accion va a
 * .historial/AAAA-MM.jsonl (fuera de git), por si git falla.
 *
 * Tolerante a fallos: si git no esta o falla (p. ej. OneDrive bloqueo un archivo), la escritura ya ocurrio; queda
 * anotado en el journal y el siguiente barrido lo commitea (como "chat", con el journal como respaldo del actor).
 * Las lecturas (historial, diff, contenidoEn) son asincronas y no toman el indice.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FLUJOS_DIR, HISTORIAL_ON } from "../config.mjs";

const ACTORES = new Set(["panel", "escriba", "chat", "sistema"]);
const IGNORE = [
  "# Generado por el panel de sesiones (flujos/historial.mjs)",
  ".escriba.json", ".escriba.json.tmp", ".ado.json", ".ado.json.tmp", "*/.escriba/", ".historial/", "*.tmp", "Thumbs.db", "Desktop.ini", "",
].join("\n");
const BASE = ["-c", "core.quotepath=off", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

const rel = (p) => path.relative(FLUJOS_DIR, p).split(path.sep).join("/");

/** git sincrono (escrituras). Devuelve stdout o lanza con el stderr. */
function gitSync(args, { input, allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", FLUJOS_DIR, ...BASE, ...args],
      { input, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return null;
    throw new Error(String(e.stderr || e.message).trim().slice(0, 400));
  }
}

/** git asincrono (lecturas). */
function git(args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", FLUJOS_DIR, ...BASE, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function journal(entry) {
  try {
    const dir = path.join(FLUJOS_DIR, ".historial");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

let estado = { on: HISTORIAL_ON, ready: false, error: null, last_commit: null };
export const estadoHistorial = () => ({ ...estado });
/** Compatibilidad: las escrituras ya son sincronas, no hay cola que esperar. */
export const esperarHistorial = () => Promise.resolve();

function commitPaths(paths, { accion, actor, proyecto, hilo, detalle, subject, extra = {} }) {
  gitSync(["add", "-A", "--", ...paths]);
  if (gitSync(["diff", "--cached", "--quiet"], { allowFail: true }) !== null) return null;   // sin cambios
  const who = ACTORES.has(actor) ? actor : "chat";
  const subj = subject ?? `${accion}: ${proyecto ?? "flujos"}${hilo ? `/${hilo}` : ""}`;
  const trailers = [`Accion: ${accion}`, proyecto && `Proyecto: ${proyecto}`, hilo && `Hilo: ${hilo}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ")}`), `Actor: ${who}`].filter(Boolean).join("\n");
  const msg = `${subj}\n\n${detalle ? `${String(detalle).slice(0, 2000)}\n\n` : ""}${trailers}\n`;
  gitSync(["commit", "-q", "--no-verify", "--author", `${who} <${who}@flujos.local>`, "-F", "-"], { input: msg });
  const h = gitSync(["rev-parse", "--short", "HEAD"]).trim();
  estado.last_commit = { hash: h, at: new Date().toISOString(), subject: subj };
  estado.error = null;
  return h;
}

/** Crea el repo si falta (con .gitignore e identidad local, sin usar la del usuario) y hace el commit inicial. */
export function iniciarHistorial(mensaje = "inicial: historial de flujos") {
  if (!HISTORIAL_ON) return Promise.resolve(estado);
  try {
    fs.mkdirSync(FLUJOS_DIR, { recursive: true });
    if (!fs.existsSync(path.join(FLUJOS_DIR, ".git"))) {
      gitSync(["init", "-q", "-b", "main"]);
      journal({ accion: "git_init", actor: "sistema" });
    }
    const gi = path.join(FLUJOS_DIR, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, IGNORE, "utf8");
    else {   // repos creados antes: agregar las entradas nuevas sin tocar las existentes
      const cur = fs.readFileSync(gi, "utf8").replace(/\r/g, "").split("\n");
      const falta = IGNORE.split("\n").filter((l) => l && !cur.includes(l));
      if (falta.length) fs.writeFileSync(gi, `${cur.join("\n").replace(/\n*$/, "\n")}${falta.join("\n")}\n`, "utf8");
    }
    gitSync(["config", "user.name", "sistema"]);
    gitSync(["config", "user.email", "sistema@flujos.local"]);
    if (gitSync(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }) === null) {
      commitPaths(["."], { accion: "inicial", actor: "sistema", detalle: mensaje, subject: mensaje });
    }
    estado = { ...estado, ready: true, error: null };
  } catch (e) { estado = { ...estado, ready: false, error: e.message }; }
  return Promise.resolve(estado);
}

/**
 * Registra (y commitea) un cambio ya escrito en disco. rutas: absolutas o relativas a flujos/ (archivos o carpetas).
 * Devuelve el hash corto, o null si no hubo cambios o git fallo.
 */
export function registrar({ accion, actor = "panel", proyecto = null, hilo = null, detalle = "", rutas = [], extra = {} }) {
  const paths = (rutas.length ? rutas : [proyecto ?? "."]).map((p) => (path.isAbsolute(p) ? rel(p) : p) || ".");
  journal({ accion, actor, proyecto, hilo, detalle: String(detalle).slice(0, 500), rutas: paths });
  if (!HISTORIAL_ON || !estado.ready) return null;
  try { return commitPaths(paths, { accion, actor, proyecto, hilo, detalle, extra }); }
  catch (e) { estado.error = e.message; journal({ accion: "commit_error", actor: "sistema", detalle: e.message, rutas: paths }); return null; }
}

/** Commitea lo que cambio en flujos/ sin pasar por registrar(): ediciones de chats o a mano. */
export function barrerExternos() {
  if (!HISTORIAL_ON || !estado.ready) return Promise.resolve([]);
  const out = [];
  try {
    // -z: "XY ruta\0"; en renombres/copias la ruta de origen viene como entrada siguiente, sin estado.
    const toks = gitSync(["status", "--porcelain", "-uall", "-z"]).split("\0");
    const files = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.length < 4) continue;
      files.push(t.slice(3));
      if (t[0] === "R" || t[0] === "C") { files.push(toks[i + 1]); i++; }
    }
    const byProj = new Map();
    for (const f of files.filter(Boolean)) {
      const proj = f.includes("/") ? f.split("/")[0] : "(raiz)";
      if (!byProj.has(proj)) byProj.set(proj, []);
      byProj.get(proj).push(f);
    }
    for (const [proj, fs_] of byProj) {
      const hilos = [...new Set(fs_.map((f) => f.match(/\/hilos\/([^/]+)\.md$/)?.[1]).filter(Boolean))];
      const fichas = fs_.some((f) => f.endsWith("/ficha.md"));
      const que = [fichas && "ficha", hilos.length && `hilo${hilos.length > 1 ? "s" : ""} ${hilos.join(", ")}`].filter(Boolean).join(" + ") || fs_.join(", ");
      const h = commitPaths(fs_, { accion: "edicion_externa", actor: "chat", proyecto: proj === "(raiz)" ? null : proj,
        hilo: hilos.length === 1 ? hilos[0] : null, detalle: `Cambio hecho fuera del panel (chat o editor): ${que}.\n${fs_.join("\n")}` });
      if (h) { out.push(h); journal({ accion: "edicion_externa", actor: "chat", proyecto: proj, rutas: fs_ }); }
    }
  } catch (e) { estado.error = e.message; }
  return Promise.resolve(out);
}

let timer = null;
export function startHistorial({ everyMs = 60_000 } = {}) {
  if (!HISTORIAL_ON || timer) return;
  iniciarHistorial().then(() => barrerExternos());
  timer = setInterval(() => { barrerExternos(); }, everyMs);
  timer.unref?.();
}

// ---------- lectura ----------
const SEP = "\x1e", FS = "\x1f";

async function logRaw(extra, n) {
  const fmt = `${SEP}%h${FS}%H${FS}%aI${FS}%an${FS}%s${FS}%(trailers:key=Accion,valueonly,separator=)${FS}%(trailers:key=Proyecto,valueonly,separator=)${FS}%(trailers:key=Hilo,valueonly,separator=)${FS}%(trailers:key=Desde,valueonly,separator=)`;
  const r = await git(["log", `-n${n}`, `--format=${fmt}`, "--name-status", "--no-renames", ...extra]);
  if (!r.ok) return { error: r.stderr.trim().slice(0, 300), items: [] };
  const items = r.stdout.split(SEP).filter((b) => b.trim()).map((block) => {
    const [head, ...rest] = block.split("\n");
    const [hash, full, fecha, actor, asunto, accion, proy, hilo, desde] = head.split(FS);
    const archivos = rest.filter((l) => l.trim()).map((l) => { const c = l.split("\t"); return { estado: c[0], path: c[1] }; });
    return { hash, full, fecha, actor, asunto, accion: accion.trim() || null, proyecto: proy.trim() || null, hilo: hilo.trim() || null,
      desde: desde.trim() || null, archivos };
  });
  return { items };
}

/**
 * Commits que tocan un proyecto, un archivo (ficha o hilo) o todo flujos/.
 * Un hilo se sigue a traves de sus movimientos con el trailer "Desde:" que deja mover_hilo (no con la deteccion
 * de renombres de git, que confunde hilos nuevos hechos desde la misma plantilla).
 */
export async function historial({ proyecto = null, archivo = null, limit = 60 } = {}) {
  if (!HISTORIAL_ON || !fs.existsSync(path.join(FLUJOS_DIR, ".git"))) return { on: false, items: [] };
  const n = Math.max(1, Math.min(500, Number(limit) || 60));
  if (!archivo) {
    const r = await logRaw(proyecto ? ["--", `${proyecto}/`] : [], n);
    return { on: true, items: r.items, ...(r.error ? { error: r.error } : {}) };
  }
  const out = [], seen = new Set();
  let cur = archivo, antes = null;
  for (let tramo = 0; cur && tramo < 8; tramo++) {
    const r = await logRaw([...(antes ? [`--until=${antes}`] : []), "--", cur], n);
    if (r.error) return { on: true, items: out, error: r.error };
    let next = null, corte = null;
    for (const it of r.items) {
      if (seen.has(it.hash) || (antes && it.fecha > antes)) continue;
      seen.add(it.hash); out.push(it);
      // El commit que trajo el hilo a esta ruta: seguir con la ruta anterior, solo hacia atras.
      if (it.archivos.some((f) => f.path === cur && f.estado === "A")) {
        if (it.accion === "mover_hilo" && it.desde) { next = it.desde; corte = it.fecha; }   // llego aqui movido: seguir atras
        break;                                                                             // o nacio aqui
      }
    }
    cur = next; antes = corte;
  }
  out.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return { on: true, items: out.slice(0, n) };
}

const HASH = /^[0-9a-f]{7,40}$/i;
const SAFE_REL = (p) => typeof p === "string" && p.length < 300 && !p.includes("..") && !path.isAbsolute(p) && /^[\w.\-/ ]+$/.test(p);

/** Diff de un commit (opcional: de un archivo). Recortado a 200 KB. */
export async function diffCommit(hash, archivo = null) {
  if (!HASH.test(String(hash ?? ""))) return { ok: false, reason: "hash" };
  if (archivo && !SAFE_REL(archivo)) return { ok: false, reason: "ruta" };
  const args = ["show", "--format=%h %an %aI%n%s%n%n%b", "-M", "--stat", "--patch", hash];
  if (archivo) args.push("--", archivo);
  const r = await git(args, { allowFail: true });
  if (!r.ok) return { ok: false, reason: r.stderr.trim().slice(0, 300) };
  return { ok: true, text: r.stdout.length > 200_000 ? `${r.stdout.slice(0, 200_000)}\n… (recortado)` : r.stdout };
}

/** Contenido de un archivo en un commit (para restaurar). */
export async function contenidoEn(hash, archivo) {
  if (!HASH.test(String(hash ?? "")) || !SAFE_REL(archivo)) return null;
  const r = await git(["show", `${hash}:${archivo}`], { allowFail: true });
  return r.ok ? r.stdout : null;
}
