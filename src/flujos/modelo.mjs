/**
 * Pseudoproyectos — lectura. flujos/<proyecto>/ficha.md + hilos/*.md, cruzados con las sesiones de Claude Code.
 * Las escrituras estan en cambios.mjs (todas pasan por el historial en git).
 * Formato de reserva: "- [AAAA-MM-DD HH:MM] hilo · repo/ruta · motivo". Vence a las RESERVA_VENCE_H horas.
 */
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOME, FLUJOS_DIR, LIMITS, RESERVA_VENCE_H as STALE_H } from "../config.mjs";
import { openUrl, summarizeTranscript } from "../core.mjs";

export { FLUJOS_DIR, LIMITS };
export const SLUG = /^[\w.-]+$/;

export const read = (p) => { try { return fs.readFileSync(p, "utf8").replace(/\r/g, ""); } catch { return null; } };

/** Secciones "## Titulo" -> lineas. La clave es el titulo en minuscula sin acentos. */
export function sections(md) {
  const out = {};
  let cur = "_";
  for (const l of md.split("\n")) {
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = norm(h[1]); out[cur] = []; continue; }
    (out[cur] ??= []).push(l);
  }
  return out;
}
export const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const find = (secs, prefix) => secs[Object.keys(secs).find((k) => k.startsWith(prefix))] ?? [];
const EMPTY = /^\(?(ningun[oa]s?|vac[ií]o|nada|—)\)?\.?$/i;   // "(ninguno)", "(vacío)": marcadores, no elementos
const bullets = (lines) => lines.filter((l) => /^\s*(-|\d+\.)\s+/.test(l)).map((l) => l.replace(/^\s*(-|\d+\.)\s+/, "").trim()).filter((b) => !EMPTY.test(b));
export const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function parseReservas(lines) {
  const now = Date.now();
  // "(vacío) Formato: …" y "Formato: …" son la linea de ejemplo de la plantilla, no reservas.
  return bullets(lines).filter((b) => !/^\(vac[ií]o\)/i.test(b) && !/^formato\s*:/i.test(b)).map((raw) => {
    const m = raw.match(/^\*{0,2}\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\]?\*{0,2}\s*[·|-]?\s*(.*)$/);
    const at = m ? new Date(`${m[1]}T${m[2]}:00`) : null;
    const parts = (m ? m[3] : raw).split("·").map((s) => s.trim()).filter(Boolean);
    const age_h = at && !isNaN(at) ? (now - at.getTime()) / 36e5 : null;
    return { raw, at: at && !isNaN(at) ? at.toISOString() : null, age_h, stale: age_h === null || age_h > STALE_H,
      hilo: parts[0] ?? "", target: parts[1] ?? "", motivo: parts.slice(2).join(" · ") };
  });
}

function parseHilosTable(lines) {
  const rows = lines.filter((l) => /^\s*\|/.test(l)).map(cells);
  return rows.slice(2).filter((r) => r.length >= 3).map((r) => ({
    name: r[0].replace(/[`*]/g, ""), session: (r[1].match(/[0-9a-f]{8}/i) ?? [""])[0].toLowerCase(), estado: r[2],
    file: (r[3]?.match(/\(([^)]+\.md)\)/) ?? [])[1] ?? null,
  }));
}

/** proyecto.json: metadatos estructurados que maneja el panel (no los reescribe la consolidacion de la ficha). */
export const META_FILE = "proyecto.json";
export function readMeta(slug) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(FLUJOS_DIR, slug, META_FILE), "utf8")); } catch {}
  const etiquetas = Array.isArray(m.etiquetas) ? m.etiquetas.filter((t) => typeof t === "string") : [];
  const historias = Array.isArray(m.historias) ? m.historias.filter((h) => Number.isInteger(h?.id)) : [];
  // Sesiones asignadas a mano desde el panel (una sesion pertenece a un solo proyecto).
  const chats = Array.isArray(m.chats) ? m.chats.filter((c) => SID_RE.test(String(c?.id ?? ""))) : [];
  return { etiquetas, historias, chats };
}
const SID_RE = /^[0-9a-f-]{36}$/i;
const AB = /\bAB#(\d{4,7})\b/g;
export const abIds = (text) => [...String(text ?? "").matchAll(AB)].map((x) => Number(x[1]));

// Sesiones origen viejas (fuera de la ventana de 7 dias): se buscan por su ID en las transcripciones.
// Indice prefijo -> archivo, refrescado cada 5 minutos (son ~40 carpetas).
let idx = { at: 0, map: new Map() };
function indiceTranscripciones() {
  if (Date.now() - idx.at < 5 * 60_000) return idx.map;
  const map = new Map();
  const root = path.join(CLAUDE_HOME, "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) if (/^[0-9a-f-]{36}\.jsonl$/i.test(f)) map.set(f.slice(0, 36).toLowerCase(), path.join(root, d.name, f));
  }
  idx = { at: Date.now(), map };
  return map;
}
function sesionArchivada(prefix) {
  for (const [id, file] of indiceTranscripciones()) {
    if (!id.startsWith(prefix)) continue;
    let st = null; try { st = fs.statSync(file); } catch { return null; }
    let title = null; try { title = summarizeTranscript(file)?.title ?? null; } catch {}
    return { session_id: id, title, state: "cerrada", alive: false, open_url: openUrl(id), last_activity: st.mtime.toISOString(), via: "archivo" };
  }
  return null;
}

/** sesion (minuscula) -> { project, hilo } de todas las asignaciones hechas en el panel. */
export function mapaAsignadas(slugs) {
  if (!slugs) { try { slugs = fs.readdirSync(FLUJOS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { slugs = []; } }
  const map = new Map();
  for (const slug of slugs) for (const c of readMeta(slug).chats) map.set(c.id.toLowerCase(), { project: slug, hilo: c.hilo ?? null, asignada: c.asignada ?? null });
  return map;
}

function sessionInfo(prefix, sessions) {
  if (!prefix) return null;
  const s = sessions.find((x) => x.session_id.toLowerCase().startsWith(prefix));
  if (!s) return sesionArchivada(prefix);
  return { session_id: s.session_id, title: s.title, state: s.state, alive: !!s.pid, open_url: s.open_url, last_activity: s.last_activity };
}

export function listFlujos(sessions = []) {
  let dirs = [];
  try { dirs = fs.readdirSync(FLUJOS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && SLUG.test(d.name) && !d.name.startsWith(".")); } catch {}
  const projects = [];
  const asignadas = mapaAsignadas(dirs.map((d) => d.name));
  for (const d of dirs) {
    const base = path.join(FLUJOS_DIR, d.name);
    const ficha = read(path.join(base, "ficha.md"));
    if (ficha === null) continue;
    const secs = sections(ficha);
    const title = (ficha.match(/^#\s+(.+)$/m)?.[1] ?? d.name).replace(/^Ficha\s*·\s*/i, "");
    const updated = ficha.match(/Actualizada:\s*([^\n]+)/)?.[1]?.trim() ?? null;
    const estadoLines = find(secs, "estado actual");
    const estado = (estadoLines.find((l) => l.trim() && !l.trim().startsWith("|")) ?? "").trim();
    const table = parseHilosTable(find(secs, "hilos"));
    // Hilos = los de la tabla + cualquier .md de hilos/ que no este en la tabla.
    let files = [];
    try { files = fs.readdirSync(path.join(base, "hilos")).filter((f) => f.endsWith(".md")); } catch {}
    const byFile = new Map(files.map((f) => [f, true]));
    const hilos = table.map((h) => ({ ...h, file: h.file ? path.basename(h.file) : `${h.name}.md` }));
    for (const f of files) if (!hilos.some((h) => h.file === f)) hilos.push({ name: f.replace(/\.md$/, ""), session: "", estado: "(fuera de la tabla)", file: f });
    for (const h of hilos) {
      const p = path.join(base, "hilos", h.file);
      const text = byFile.has(h.file) ? read(p) : null;
      let mtime = null; try { mtime = fs.statSync(p).mtime.toISOString(); } catch {}
      Object.assign(h, { exists: text !== null, chars: text?.length ?? 0, over: (text?.length ?? 0) > LIMITS.hilo, mtime, markdown: text ?? "",
        session_info: sessionInfo(h.session, sessions) });
    }
    // Chats del proyecto: sesiones cuyo primer mensaje nombra el proyecto (los prompts que copia el panel lo hacen).
    // Si ademas nombran un hilo, se cuelgan de ese hilo; asi un chat hijo nuevo aparece vivo en su hilo.
    const slugRe = new RegExp(`\\b${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    // Tambien cuentan las sesiones que citan una historia de usuario vinculada (AB#), aunque no nombren el slug.
    const meta = readMeta(d.name);
    const usIds = new Set(meta.historias.map((h) => h.id));
    // La asignacion hecha en el panel manda: una sesion asignada a otro proyecto no se cuenta aqui aunque lo nombre.
    // Y las sesiones que la tabla de hilos cita como «sesión origen» (columna Sesión): ya son del proyecto.
    // Si una sesion origina varios hilos, se cuelga del primero que no este cerrado.
    const origenDe = (sid) => {
      const hs = hilos.filter((h) => h.session && h.session.length >= 6 && sid.startsWith(h.session.toLowerCase()));
      return hs.find((h) => !/^cerrad/i.test(String(h.estado ?? "").trim())) ?? hs[0] ?? null;
    };
    const chats = [];
    for (const s of sessions) {
      const sid = s.session_id.toLowerCase();
      const asig = asignadas.get(sid);
      if (asig && asig.project !== d.name) continue;
      const fp = String(s.first_prompt ?? "");
      const porUs = (s.work_items ?? []).map((w) => w.id).find((id) => usIds.has(id));
      const origen = asig ? null : origenDe(sid);
      if (!asig && !origen && !slugRe.test(fp) && !porUs) continue;
      const hilo = asig ? hilos.find((h) => h.name === asig.hilo) : origen ?? hilos.find((h) => new RegExp(`\\b${h.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(fp));
      chats.push({ session_id: s.session_id, title: s.title ?? s.auto_title, state: s.state, alive: !!s.pid, open_url: s.open_url,
        last_activity: s.last_activity, hilo: hilo?.name ?? null, first_prompt: fp.slice(0, 160),
        note: s.note ?? null, note_kind: s.note_kind ?? null,
        via: asig ? "asignada" : origen ? "origen" : slugRe.test(fp) ? "nombre" : "us", via_us: asig || origen || slugRe.test(fp) ? null : porUs });
    }
    chats.sort((a, b) => (b.alive - a.alive) || Date.parse(b.last_activity ?? 0) - Date.parse(a.last_activity ?? 0));
    for (const h of hilos) {
      h.chats = chats.filter((c) => c.hilo === h.name);
      const live = h.chats.find((c) => c.alive);
      if (live && !h.session_info?.alive) h.session_info = { ...live, via: "chat" };
    }
    let fmtime = null; try { fmtime = fs.statSync(path.join(base, "ficha.md")).mtime.toISOString(); } catch {}
    projects.push({
      slug: d.name, title, updated, estado, path: base, ficha_path: path.join(base, "ficha.md"),
      ficha_chars: ficha.length, ficha_over: ficha.length > LIMITS.ficha, ficha_mtime: fmtime, markdown: ficha,
      bloqueos: bullets(find(secs, "bloqueos")), inconsistencias: bullets(find(secs, "inconsistencias")),
      proximos: bullets(find(secs, "proximos pasos")), reservas: parseReservas(find(secs, "en curso")), hilos, chats,
      etiquetas: meta.etiquetas, historias: meta.historias, asignadas: meta.chats,
      // AB# que la ficha o los hilos mencionan y aun no estan vinculados: sugerencias para «Vincular».
      us_detectadas: [...new Set([ficha, ...hilos.map((h) => h.markdown)].flatMap(abIds))].filter((id) => !usIds.has(id)).slice(0, 12),
    });
  }
  projects.sort((a, b) => (b.reservas.filter((r) => !r.stale).length - a.reservas.filter((r) => !r.stale).length)
    || Date.parse(b.ficha_mtime ?? 0) - Date.parse(a.ficha_mtime ?? 0));
  return { dir: FLUJOS_DIR, limits: LIMITS, stale_hours: STALE_H, projects, generated_at: new Date().toISOString() };
}
