/**
 * Asignacion de sesiones a proyectos: a que proyecto/hilo pertenece cada sesion y, si no tiene, cual se sugiere.
 *
 * Puntaje de un proyecto para una sesion sin asignar (se muestran los 3 mejores con sus motivos):
 *   +6  el primer mensaje nombra el slug        +3  ademas nombra uno de sus hilos
 *   +5  cita un AB# vinculado al proyecto       +2  cita un AB# que la ficha o los hilos mencionan
 *   +2  toca un repo que la ficha menciona (por repo, maximo 2; los repos de config.deprioritizedRepos no cuentan)
 *   +4  edita una carpeta (repo/a/b -> "a/b") que la ficha o los hilos citan
 *   +1  palabra del titulo del proyecto en el titulo o primer mensaje de la sesion (maximo 3)
 */
import path from "node:path";
import { DEPRIORITIZED_REPOS, FLUJOS_DIR, STOPWORDS } from "../config.mjs";
import { locate } from "../workspace.mjs";
import { abIds, norm } from "./modelo.mjs";

const PALABRA = /[\p{L}\p{N}_]{5,}/gu;
// Palabras demasiado comunes para distinguir proyectos (+ config.stopwords).
const VACIAS = new Set(["proyecto", "sesion", "sesiones", "datos", "claude", "validacion", "analisis", "project", "session", ...STOPWORDS]);
const palabras = (s) => new Set([...norm(String(s ?? "")).matchAll(PALABRA)].map((m) => m[0]).filter((w) => !VACIAS.has(w)));
// Repos de control (config.deprioritizedRepos): los citan casi todas las fichas, no distinguen proyectos.
const GENERICOS = DEPRIORITIZED_REPOS;
const FLUJOS_LOW = path.resolve(FLUJOS_DIR).toLowerCase() + path.sep;
/** Carpetas de 2 niveles que la sesion edito dentro de un repo ("src/server", "databricks/pipeline"). */
function carpetasEditadas(s) {
  const out = new Set();
  for (const e of s.edited_files ?? []) {
    if (!e.file || path.resolve(String(e.file)).toLowerCase().startsWith(FLUJOS_LOW)) continue;
    const parts = (locate(String(e.file))?.rel ?? "").toLowerCase().split("/");
    if (parts.length >= 3) out.add(`${parts[0]}/${parts[1]}`);
  }
  return [...out];
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Prepara lo que se compara de cada proyecto (una vez por consulta). */
function perfil(p) {
  const texto = [p.markdown, ...p.hilos.map((h) => h.markdown)].join("\n");
  return {
    p,
    slugRe: new RegExp(`\\b${reEsc(p.slug)}\\b`, "i"),
    hilosRe: p.hilos.map((h) => ({ name: h.name, re: new RegExp(`\\b${reEsc(h.name)}\\b`, "i") })),
    us: new Set(p.historias.map((h) => h.id)),
    citadas: new Set(abIds(texto)),
    texto: texto.toLowerCase(),
    palabras: palabras(p.title),
  };
}

function puntuar(s, f) {
  const fp = String(s.first_prompt ?? "");
  const motivos = [];
  let score = 0, hilo = null;
  if (f.slugRe.test(fp)) {
    score += 6; motivos.push("lo nombra");
    const h = f.hilosRe.find((x) => x.re.test(fp));
    if (h) { score += 3; hilo = h.name; motivos.push(`hilo ${h.name}`); }
  }
  const wi = (s.work_items ?? []).map((w) => w.id);
  const usV = wi.filter((id) => f.us.has(id)), usC = wi.filter((id) => !f.us.has(id) && f.citadas.has(id));
  if (usV.length) { score += 5; motivos.push(`AB#${usV[0]} vinculada`); }
  if (usC.length) { score += 2; motivos.push(`AB#${usC[0]} citada en la ficha`); }
  const repos = (s.repos ?? []).map((r) => String(r.name ?? r).toLowerCase()).filter((r) => r.length > 3 && !GENERICOS.has(r) && f.texto.includes(r));
  if (repos.length) { score += 2 * Math.min(2, repos.length); motivos.push(`repo ${repos.slice(0, 2).join(", ")}`); }
  const carpetas = carpetasEditadas(s).filter((c) => f.texto.includes(c));
  if (carpetas.length) { score += 4; motivos.push(`edita ${carpetas[0]}`); }
  const comunes = [...palabras(`${s.title ?? ""} ${fp}`)].filter((w) => f.palabras.has(w));
  if (comunes.length) { score += Math.min(3, comunes.length); motivos.push(`«${comunes.slice(0, 2).join("», «")}»`); }
  return { project: f.p.slug, title: f.p.title, score, hilo, motivos };
}

/**
 * Para cada sesion: { project, hilo, via } si ya pertenece a un proyecto (asignada, lo nombra o cita su US),
 * o { sugerencias: [...] } si no. `flujos` = listFlujos(sessions).
 */
export function asignaciones(sessions, flujos) {
  const out = {};
  const dueno = new Map();
  for (const p of flujos.projects) for (const c of p.chats ?? []) {
    if (!dueno.has(c.session_id) || c.via === "asignada") dueno.set(c.session_id, { project: p.slug, title: p.title, hilo: c.hilo, via: c.via });
  }
  const perfiles = flujos.projects.map(perfil);
  for (const s of sessions) {
    const d = dueno.get(s.session_id);
    if (d) { out[s.session_id] = d; continue; }
    const sug = perfiles.map((f) => puntuar(s, f)).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 3);
    out[s.session_id] = { project: null, sugerencias: sug };
  }
  return out;
}
