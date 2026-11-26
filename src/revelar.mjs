/**
 * «Abrir carpeta» de un archivo que una sesion menciona en su texto (p. ej. «Avances_Q3_v1.pptx»).
 *
 *   buscarArchivo(sessionId, nombre)  ruta real del archivo, o null. Orden:
 *       1. nombre ya es una ruta absoluta que existe
 *       2. documentos de la sesion (assets)
 *       3. rutas completas que terminan en ese nombre dentro de la transcripcion (lo mas reciente primero):
 *          los archivos que crean los scripts (pptxgenjs, python) no pasan por Write, pero su ruta aparece
 *          en los comandos y salidas
 *       4. busqueda acotada bajo la carpeta de trabajo de la sesion
 *   revelar(ruta)  abre el Explorador de Windows con el archivo seleccionado (no lo ejecuta).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SECRET_RE, sessionRow } from "./core.mjs";

const SALTAR = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".tools", "dist", ".mirror"]);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const winPath = (p) => p.replace(/^\/([a-z])\//i, "$1:/").replace(/\//g, "\\");

function existe(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Rutas absolutas que terminan en `base`, leidas de la transcripcion desde el final hacia atras. */
function rutasEnTranscripcion(file, base, sufijo) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  // C:\..\base  C:/../base  /c/../base, tal como quedan escritas en el JSON (barras invertidas dobles).
  const re = new RegExp(String.raw`(?:[A-Za-z]:|/[a-zA-Z])(?:(?:\\\\|\\|/)[^"'\x60\s<>|*?:\\/]+(?: [^"'\x60\s<>|*?:\\/]+)*)*?(?:\\\\|\\|/)` + reEsc(base) + String.raw`(?![\w.-])`, "gi");
  const CHUNK = 8 * 1048576;
  const fd = fs.openSync(file, "r");
  try {
    for (let end = size; end > 0; end -= CHUNK - 4096) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      const hits = [...buf.toString("utf8").matchAll(re)].map((m) => winPath(m[0].replace(/\\\\/g, "\\")));
      // La mas reciente primero; si la mencion traia carpeta (exports/x.pptx), las que coinciden van antes.
      const orden = [...new Set(hits.reverse())].sort((a, b) => Number(!!sufijo && b.toLowerCase().endsWith(sufijo)) - Number(!!sufijo && a.toLowerCase().endsWith(sufijo)));
      const ok = orden.find(existe);
      if (ok) return ok;
      if (start === 0) break;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

/** Busqueda acotada (profundidad y cantidad) del nombre bajo `raiz`. */
function buscarBajo(raiz, base, { prof = 6, max = 30000 } = {}) {
  let vistos = 0;
  const low = base.toLowerCase();
  const pila = [[raiz, 0]];
  while (pila.length) {
    const [dir, d] = pila.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++vistos > max) return null;
      if (e.isFile() && e.name.toLowerCase() === low) return path.join(dir, e.name);
      if (e.isDirectory() && d < prof && !SALTAR.has(e.name) && !e.name.startsWith(".")) pila.push([path.join(dir, e.name), d + 1]);
    }
  }
  return null;
}

export function buscarArchivo(sessionId, nombre) {
  const n = String(nombre ?? "").trim().replace(/^[`"'«]+|[`"'»]+$/g, "");
  if (!n || n.length > 600) return null;
  if (/^([A-Za-z]:[\\/]|\/[a-z]\/)/.test(n) && existe(winPath(n))) return winPath(n);
  const base = n.split(/[\\/]/).pop();
  if (!base) return null;
  const sufijo = n.includes("/") || n.includes("\\") ? winPath(n).toLowerCase() : null;
  const r = sessionRow(sessionId);
  const a = (r?.assets ?? []).find((x) => x.name.toLowerCase() === base.toLowerCase() && existe(x.path));
  if (a) return path.resolve(a.path);
  if (r?.transcript_path) {
    const t = rutasEnTranscripcion(r.transcript_path, base, sufijo);
    if (t) return path.resolve(t);
  }
  const cwd = r?.cwd ?? null;
  for (const raiz of [cwd].filter(Boolean)) {
    const f = buscarBajo(raiz, base);
    if (f) return f;
  }
  return null;
}

export function revelar(ruta) {
  const p = path.resolve(String(ruta ?? ""));
  if (!existe(p) && !fs.existsSync(p)) return { ok: false, reason: "no_existe" };
  if (SECRET_RE.test(p)) return { ok: false, reason: "protegido" };
  // explorer.exe /select,"ruta": abre la carpeta con el archivo marcado. No abre ni ejecuta el archivo.
  spawn("explorer.exe", [`/select,${p}`], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return { ok: true, path: p, dir: path.dirname(p) };
}
