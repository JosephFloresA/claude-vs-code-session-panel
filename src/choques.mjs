/**
 * Choques entre sesiones abiertas, detectados solos (reemplaza a la reserva manual como primera defensa).
 *
 *   archivo  dos o mas sesiones no cerradas editaron el mismo archivo en las ultimas `horas` (core.markConflicts ya
 *            lo marca en cada sesion; aqui se agrupa).
 *   repo     dos o mas sesiones VIVAS editaron archivos del mismo repo en las ultimas `horas`. Comparten el mismo
 *            arbol de trabajo y la misma rama: un commit de una puede llevarse los cambios de la otra.
 *
 * Solo lectura: usa edited_files de cada sesion (lo que Claude escribio con Edit/Write segun su transcripcion).
 */
import path from "node:path";
import { FLUJOS_DIR } from "./config.mjs";
import { locate } from "./workspace.mjs";

export const CHOQUE_HORAS = 12;

/** Ruta absoluta -> { repo, rel } si esta bajo alguna raiz de trabajo (config.workspaceRoots o aprendidas). */
export function repoDe(file) {
  if (!file) return null;
  const r = locate(String(file));
  return r ? { repo: r.repo, rel: r.rel } : null;
}

const FLUJOS_LOW = path.resolve(FLUJOS_DIR).toLowerCase() + path.sep;
/** La carpeta de proyectos la escriben todas las sesiones a proposito (reservas, hilos): no genera choques. */
const enFlujos = (file) => path.resolve(String(file)).toLowerCase().startsWith(FLUJOS_LOW);

const resumen = (s, archivos) => ({ session_id: s.session_id, title: s.title, state: s.state, alive: !!s.pid, open_url: s.open_url,
  git_branch: s.git_branch ?? null, archivos: archivos.slice(0, 6) });

/**
 * Lista de choques. `ruta` (opcional) filtra los que tocan ese repo o archivo (para el chequeo previo de un chat).
 * La carpeta de proyectos (config.projectsDir) no cuenta: la escriben todos a proposito (reservas, hilos).
 */
export function detectarChoques(sessions, { horas = CHOQUE_HORAS, ruta = null } = {}) {
  const limite = Date.now() - horas * 3600e3;
  const porRepo = new Map(), porArchivo = new Map();
  for (const s of sessions) {
    if (s.state === "cerrada") continue;
    for (const e of s.edited_files ?? []) {
      if (e.at && Date.parse(e.at) < limite) continue;
      if (!e.file || enFlujos(e.file)) continue;
      // Same file = clash even outside the workspace roots (sessions started in the home folder teach no root:
      // found on a clean VM). Outside the roots it is named "<folder>/<file>" and there is no repo-level clash.
      const located = repoDe(e.file);
      const r = located ?? { repo: path.basename(path.dirname(e.file)), rel: path.basename(e.file) };
      const k = e.file.toLowerCase().replace(/\\/g, "/");
      if (!porArchivo.has(k)) porArchivo.set(k, { file: `${r.repo}/${r.rel}`, sesiones: new Map() });
      porArchivo.get(k).sesiones.set(s.session_id, s);
      if (!s.pid || !located) continue;
      if (!porRepo.has(r.repo)) porRepo.set(r.repo, new Map());
      const m = porRepo.get(r.repo);
      if (!m.has(s.session_id)) m.set(s.session_id, { s, archivos: [] });
      m.get(s.session_id).archivos.push(r.rel);
    }
  }
  const out = [];
  for (const { file, sesiones } of porArchivo.values()) {
    if (sesiones.size < 2) continue;
    out.push({ nivel: "archivo", repo: file.split("/")[0], file, sesiones: [...sesiones.values()].map((s) => resumen(s, [file.split("/").slice(1).join("/")])) });
  }
  for (const [repo, m] of porRepo) {
    if (m.size < 2) continue;
    out.push({ nivel: "repo", repo, file: null, sesiones: [...m.values()].map(({ s, archivos }) => resumen(s, [...new Set(archivos)])) });
  }
  return out.filter((c) => tocaRuta(c, ruta)).sort((a, b) => (a.nivel === "archivo" ? 0 : 1) - (b.nivel === "archivo" ? 0 : 1));
}

/** ¿El choque toca la ruta pedida? Acepta un repo ("my-api"), una ruta absoluta o "repo/ruta/archivo". */
function tocaRuta(c, ruta) {
  if (!ruta) return true;
  const f = String(ruta).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const repo = c.repo.toLowerCase();
  const enRepo = f === repo || f.startsWith(`${repo}/`) || f.includes(`/${repo}/`) || f.endsWith(`/${repo}`);
  if (!enRepo) return false;
  if (c.nivel === "repo") return true;
  const rel = c.file.toLowerCase().split("/").slice(1).join("/");
  return f.endsWith(rel) || f === repo || f.endsWith(`/${repo}`);
}

/** Agrega a cada sesion sus choques de repo (los de archivo ya vienen en s.conflicts desde core). */
export function marcarRepos(sessions, choques) {
  for (const s of sessions) s.repo_choques = [];
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  for (const c of choques) {
    if (c.nivel !== "repo") continue;
    for (const x of c.sesiones) {
      byId.get(x.session_id)?.repo_choques.push({ repo: c.repo, with: c.sesiones.filter((o) => o.session_id !== x.session_id)
        .map((o) => ({ session_id: o.session_id, title: o.title, open_url: o.open_url, archivos: o.archivos })) });
    }
  }
  return sessions;
}
