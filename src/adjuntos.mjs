/**
 * Adjuntos del panel: el archivo se guarda en ADJUNTOS.dir/<sesion>/ y su ruta se agrega al mensaje,
 * para que Claude lo abra con Read (que tambien lee imagenes y PDF). Nada se sube a otro servicio.
 * Los archivos de mas de ADJUNTOS.dias se borran al guardar uno nuevo.
 */
import fs from "node:fs";
import path from "node:path";
import { ADJUNTOS } from "./config.mjs";

const SID_RE = /^[0-9a-f-]{36}$/i;

export function nombreSeguro(name) {
  const base = path.basename(String(name ?? "")).replace(/[^\w.\- ]+/g, "_").replace(/^[.\s]+/, "").trim();
  if (!base) return "archivo";
  const ext = path.extname(base).slice(0, 12);
  return base.length <= 80 ? base : base.slice(0, 80 - ext.length) + ext;
}

function limpiar(dir = ADJUNTOS.dir, dias = ADJUNTOS.dias) {
  const corte = Date.now() - dias * 86400000;
  let sesiones = [];
  try { sesiones = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const s of sesiones) {
    const sd = path.join(dir, s.name);
    try {
      for (const f of fs.readdirSync(sd)) {
        const fp = path.join(sd, f);
        if (fs.statSync(fp).mtimeMs < corte) fs.rmSync(fp, { force: true });
      }
      if (!fs.readdirSync(sd).length) fs.rmdirSync(sd);
    } catch {}
  }
}

/** Guarda un adjunto y devuelve { ok, path, name, size } o { ok:false, reason }. */
export function guardarAdjunto(sessionId, name, buf, { dir = ADJUNTOS.dir } = {}) {
  if (!SID_RE.test(String(sessionId))) return { ok: false, reason: "sesion_invalida" };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: "vacio" };
  if (buf.length > ADJUNTOS.maxBytes) return { ok: false, reason: "demasiado_grande" };
  limpiar(dir);
  const sd = path.join(dir, sessionId.toLowerCase());
  fs.mkdirSync(sd, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const safe = nombreSeguro(name);
  let fp = path.join(sd, `${stamp}_${safe}`);
  for (let i = 2; fs.existsSync(fp); i++) fp = path.join(sd, `${stamp}_${i}_${safe}`);
  fs.writeFileSync(fp, buf);
  return { ok: true, path: fp, name: safe, size: buf.length };
}
