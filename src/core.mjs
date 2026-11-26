/**
 * Monitor de sesiones de Claude Code — nucleo compartido.
 *
 * Junta tres fuentes y devuelve una fila por sesion:
 *   1. Registro vivo de Claude Code (~/.claude/sessions/<pid>.json): pid, cwd, busy/idle.
 *   2. Transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl): titulo IA, primer y
 *      ultimo pedido, ultima respuesta, repos tocados. Solo se lee la cabeza y la cola.
 *   3. Tabla agent_sessions de la base del panel, si algun hook la escribe (opcional):
 *      eventos exactos (pidio permiso, termino turno, duracion del turno).
 *
 * Solo lectura. Nunca abre los archivos *.key del registro (tokens de mensajeria).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ADO_ORG, CLAUDE_HOME, CONFLICT_HOURS, DB_PATH, DEPRIORITIZED_REPOS, STALE_HOURS } from "./config.mjs";
import { learnFromCwd, reposIn, rootOf, roots, shortPath } from "./workspace.mjs";

export { CLAUDE_HOME, DB_PATH, STALE_HOURS, CONFLICT_HOURS };

export const AGENT_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id      TEXT PRIMARY KEY,
  cwd             TEXT,
  transcript_path TEXT,
  state           TEXT,          -- iniciada | trabajando | necesita_input | esperando | cerrada
  state_detail    TEXT,          -- mensaje de la notificacion o motivo de cierre
  first_prompt    TEXT,
  last_prompt     TEXT,
  last_summary    TEXT,          -- ultima respuesta (recortada) al terminar el turno
  turn_started_at TEXT,
  last_turn_secs  INTEGER,
  started_at      TEXT,
  ended_at        TEXT,
  last_event      TEXT,
  last_event_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_event ON agent_sessions(last_event_at DESC);

-- Lo que decide la persona desde el panel: no lo tocan los hooks.
CREATE TABLE IF NOT EXISTS agent_session_meta (
  session_id   TEXT PRIMARY KEY,
  pinned       INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,             -- se vuelve a mostrar sola si hay actividad posterior
  note         TEXT,
  note_kind    TEXT,             -- estado del proyecto: bloqueo | validacion | listo | info
  auto_accept  INTEGER NOT NULL DEFAULT 0,  -- aprobar solos los permisos de esta sesion (menos las preguntas)
  custom_title TEXT,
  seen_at      TEXT,             -- "visto" marcado desde el panel (o al abrirla desde ahi)
  updated_at   TEXT
);
`;

/** Columnas agregadas despues de la primera version: ALTER idempotente. */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(agent_session_meta)").all().map((c) => c.name);
  if (!cols.includes("seen_at")) db.exec("ALTER TABLE agent_session_meta ADD COLUMN seen_at TEXT");
  if (!cols.includes("note_kind")) db.exec("ALTER TABLE agent_session_meta ADD COLUMN note_kind TEXT");
  if (!cols.includes("auto_accept")) db.exec("ALTER TABLE agent_session_meta ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0");
}

/** Estados de nota admitidos (el resto se guarda como null = nota sin estado). */
export const NOTE_KINDS = ["bloqueo", "validacion", "listo", "info"];

/** Guarda fijar / archivar / nota / titulo propio de una sesion. `patch` solo trae lo que cambia. */
export function setSessionMeta(sessionId, patch) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("session_id inválido");
  const db = openSessionsDb();
  try {
    db.prepare("INSERT INTO agent_session_meta (session_id, updated_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING")
      .run(sessionId, nowIso());
    const cols = { pinned: (v) => (v ? 1 : 0), archived: null, note: (v) => clip(v, 500) || null, custom_title: (v) => clip(v, 120) || null, note_kind: (v) => (NOTE_KINDS.includes(v) ? v : null), auto_accept: (v) => (v ? 1 : 0) };
    if ("seen" in patch) {
      db.prepare("UPDATE agent_session_meta SET seen_at = ?, updated_at = ? WHERE session_id = ?")
        .run(patch.seen ? nowIso() : null, nowIso(), sessionId);
    }
    for (const [k, fn] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      if (k === "archived") {
        db.prepare("UPDATE agent_session_meta SET archived_at = ?, updated_at = ? WHERE session_id = ?")
          .run(patch.archived ? nowIso() : null, nowIso(), sessionId);
      } else {
        db.prepare(`UPDATE agent_session_meta SET ${k} = ?, updated_at = ? WHERE session_id = ?`)
          .run(fn(patch[k]), nowIso(), sessionId);
      }
    }
    return db.prepare("SELECT * FROM agent_session_meta WHERE session_id = ?").get(sessionId);
  } finally {
    db.close();
  }
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 768 * 1024;

const nowIso = () => new Date().toISOString();

export function openSessionsDb({ readOnly = false } = {}) {
  if (!fs.existsSync(DB_PATH) && readOnly) return null;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 3000;");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(AGENT_SESSIONS_SQL);
    migrate(db);
  }
  return db;
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split("\n");
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* linea cortada */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

/** Pedido escrito por la persona (descarta notificaciones, resultados de tools y avisos del sistema). */
function humanPrompt(rec) {
  if (rec.type !== "user" || rec.isSidechain || rec.isMeta) return null;
  const content = rec.message?.content;
  if (Array.isArray(content) && content.some((c) => c?.type === "tool_result")) return null;
  let t = textOf(content);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
  if (!t || t.startsWith("<task-notification") || t.startsWith("<local-command") ||
      t.startsWith("<command-") || t.startsWith("[Request interrupted")) return null;
  return t;
}

export function clip(s, n = 280) {
  if (!s) return s ?? null;
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

const AB_RE = /\bAB#(\d{4,7})\b/g;
// Pull requests citados en la conversacion: Azure DevOps (con su organizacion) y GitHub.
const PR_RE = /https:\/\/dev\.azure\.com\/([\w-]+)\/[^\s)"'`]+?\/_git\/([^\s/)"'`]+)\/pullrequest\/(\d+)/g;
const GH_PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Enlace markdown a un archivo local, o ruta entre backticks, con extension de documento.
const MENTION_RE = /\]\((?!https?:|vscode:|#)([^)\s]+\.(?:html?|md|pdf|pptx|xlsx|docx|svg|png))\)|`([^`\s]+\.(?:html?|md|pdf|pptx|xlsx|docx|svg|png))`/gi;

/** Descripcion corta de una llamada a herramienta: "Edit core.mjs", "Bash: Run tests"... */
function actionLabel(c) {
  const i = c.input ?? {};
  const base = (p) => String(p).split(/[\\/]/).pop();
  if (i.description) return clip(i.description, 90);
  if (i.file_path) return base(i.file_path);
  if (i.notebook_path) return base(i.notebook_path);
  if (i.pattern) return clip(`"${i.pattern}"`, 60);
  if (i.skill) return `/${i.skill}`;
  if (i.command) return clip(i.command, 70);
  if (i.prompt) return clip(i.prompt, 70);
  return "";
}
const normPath = (p) => path.resolve(p.replace(/^\/([a-z])\//i, "$1:/")).toLowerCase();

const trCache = new Map();

/** Igual que readTranscript, pero reutiliza el resultado si el archivo no cambio (el panel consulta cada pocos segundos). */
export function summarizeTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  // Las raices aprendidas cambian que repos se reconocen: la cache se invalida si aparece una nueva.
  const key = `${st.size}:${st.mtimeMs}:${roots().length}`;
  const hit = trCache.get(file);
  if (hit && hit.key === key) return hit.info;
  const info = readTranscript(file, st);
  trCache.set(file, { key, info });
  return info;
}

/** Lee cabeza y cola de un transcript y extrae lo necesario para el monitor. */
function readTranscript(file, st) {
  const size = st.size;
  const head = parseLines(readSlice(file, 0, Math.min(size, HEAD_BYTES)), { dropLast: size > HEAD_BYTES });
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = size <= HEAD_BYTES ? head
    : parseLines(readSlice(file, tailStart, size - tailStart), { dropFirst: tailStart > 0 });

  const info = {
    transcript_path: file,
    transcript_mtime: st.mtime.toISOString(),
    size_mb: Math.round((size / 1048576) * 10) / 10,
    title: null, first_prompt: null, last_prompt: null, last_response: null,
    last_activity: null, cwd: null, git_branch: null, repos: [], model: null,
  };

  for (const r of head) {
    const p = humanPrompt(r);
    if (p) { info.first_prompt = p; break; }
  }
  const repoCount = new Map();
  const edited = new Map();        // archivo -> ultima vez que esta sesion lo edito
  const written = new Map();       // archivo (normalizado) -> { path, op, at }: base de "archivos generados"
  const workItems = new Set();
  const prs = new Map();           // url -> { repo, id }
  for (const r of tail) {
    if (r.type === "user" || r.type === "assistant") {
      const raw = textOf(r.message?.content);
      for (const m of raw.matchAll(AB_RE)) workItems.add(Number(m[1]));
      for (const m of raw.matchAll(PR_RE)) prs.set(m[0], { provider: "ado", org: `https://dev.azure.com/${m[1]}`, repo: decodeURIComponent(m[2]), id: Number(m[3]) });
      for (const m of raw.matchAll(GH_PR_RE)) prs.set(m[0], { provider: "github", repo: m[1], id: Number(m[2]) });
    }
    if (r.type === "ai-title" && r.aiTitle) info.title = r.aiTitle;
    else if (r.type === "custom-title" && r.customTitle) info.custom_title = r.customTitle;
    else if (r.type === "last-prompt" && r.lastPrompt) info.last_prompt = r.lastPrompt;
    if (r.timestamp && (r.type === "user" || r.type === "assistant")) info.last_activity = r.timestamp;
    if (r.cwd) info.cwd = r.cwd;
    if (r.gitBranch) info.git_branch = r.gitBranch;
    if (r.type === "user" && !r.isSidechain) {
      info.pending_question = null;
      info.ends_with_tool = false;
      const p = humanPrompt(r);
      if (p) info.last_prompt_live = p;
    }
    if (r.type === "assistant" && !r.isSidechain) {
      const content = r.message?.content ?? [];
      if (r.timestamp) info.last_assistant_at = r.timestamp;
      if (r.message?.model) info.model = r.message.model;
      const u = r.message?.usage;
      if (u) {
        // Lo que ocupa la conversacion en la ventana de contexto en la ultima llamada.
        info.context_tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      const t = textOf(content).trim();
      if (t) info.last_response = t;
      // Archivos que Claude menciona al responder ([x](ruta.html) o `ruta.md`): asi entran tambien los
      // generados por scripts (archify, pptx...) y no solo los escritos con Write. Se validan en assetsOf.
      for (const m of t.matchAll(MENTION_RE)) {
        const raw = (m[1] ?? m[2]).replace(/#.*$/, "");
        const abs = path.isAbsolute(raw) ? raw : path.resolve(r.cwd ?? info.cwd ?? os.homedir(), raw);
        const key = normPath(abs);
        if (!written.has(key)) written.set(key, { path: abs, op: "mencionado", at: r.timestamp ?? null, mention: true });
      }
      info.ends_with_tool = Array.isArray(content) && content.some((c) => c?.type === "tool_use");
      if (Array.isArray(content) && content.some((c) => c?.type === "tool_use" && c.name === "AskUserQuestion")) {
        const q = content.find((c) => c?.name === "AskUserQuestion")?.input?.questions?.[0]?.question;
        info.pending_question = q ?? "Te hizo una pregunta con opciones";
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type !== "tool_use") continue;
        info.last_action = { tool: c.name, label: actionLabel(c), at: r.timestamp ?? null };
        if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
          info.todos = c.input.todos.map((t) => ({ text: clip(t.content ?? t.activeForm, 160), status: t.status }));
        }
        const fp = c.input?.file_path ?? c.input?.notebook_path;
        // Los archivos temporales (scratchpad, %TEMP%) no son del proyecto: ni se listan ni generan conflictos.
        if (EDIT_TOOLS.has(c.name) && typeof fp === "string" && !/[\\/](temp|tmp|scratchpad)[\\/]/i.test(fp)) {
          const key = normPath(fp);
          edited.set(key, r.timestamp ?? null);
          // "creado" si la sesion lo escribio con Write antes que nada; si no, "editado".
          const op = written.get(key)?.op ?? (c.name === "Write" ? "creado" : "editado");
          written.set(key, { path: fp.replace(/^\/([a-z])\//i, "$1:/"), op, at: r.timestamp ?? null });
        }
        for (const name of reposIn(JSON.stringify(c.input ?? {}))) repoCount.set(name, (repoCount.get(name) ?? 0) + 1);
      }
    }
  }
  if (info.custom_title) info.title = info.custom_title;
  // "¿...?" al final de la ultima respuesta: Claude te pregunto algo, no solo termino.
  const tailText = (info.last_response ?? "").replace(/[\s*_`>)\]]+$/g, "");
  // Mira solo el ultimo parrafo: "¿Lo subo?" al cierre, no una pregunta citada al medio.
  const lastPara = tailText.split(/\n\s*\n/).pop() ?? "";
  info.asks_question = !!info.pending_question || /[?？]$/.test(tailText) || /¿[^?]{3,200}\?/.test(lastPara);
  info.last_prompt = info.last_prompt_live ?? info.last_prompt;
  delete info.last_prompt_live;
  // Repos de control (config.deprioritizedRepos): casi todo pasa por ahi, asi que van al final.
  const peso = ([n, c]) => (DEPRIORITIZED_REPOS.has(n.toLowerCase()) ? c / 1000 : c);
  info.repos = [...repoCount.entries()].sort((a, b) => peso(b) - peso(a)).slice(0, 3).map(([n]) => n);
  info.todos = info.todos ?? [];
  info.edited_files = [...edited.entries()].map(([file, at]) => ({ file, at }));
  info.written = [...written.values()];
  info.work_items = [...workItems].filter((n) => n > 1000).slice(-6);
  info.prs = [...prs.entries()].map(([url, p]) => ({ url, ...p })).slice(-4);
  if (info.context_tokens) {
    // Sin dato del modelo: si ya paso de 200k, la sesion corre con ventana de 1M.
    const windowTokens = /\[1m\]/i.test(info.model ?? "") || info.context_tokens > 200_000 ? 1_000_000 : 200_000;
    info.context_pct = Math.min(100, Math.round((info.context_tokens / windowTokens) * 100));
  }
  return info;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Registro vivo de Claude Code. Solo lee <pid>.json, nunca los *.key. */
export function readLiveRegistry() {
  const dir = path.join(CLAUDE_HOME, "sessions");
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!o.sessionId) continue;
      const alive = pidAlive(o.pid);
      const prev = out.get(o.sessionId);
      if (prev && prev.alive && !alive) continue;
      out.set(o.sessionId, {
        pid: o.pid, alive, cwd: o.cwd, status: o.status ?? null,
        waiting_for: typeof o.waitingFor === "string" && o.waitingFor ? o.waitingFor : null,
        status_at: o.statusUpdatedAt ? new Date(o.statusUpdatedAt).toISOString() : null,
        started_at: o.startedAt ? new Date(o.startedAt).toISOString() : null,
        entrypoint: o.entrypoint ?? null, name: o.name ?? null, version: o.version ?? null,
      });
    } catch { /* archivo a medio escribir */ }
  }
  return out;
}

function projectSlug(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Ubica el transcript de una sesion (por cwd y, si no, buscando en todos los proyectos). */
function findTranscript(sessionId, cwd, hint) {
  if (hint && fs.existsSync(hint)) return hint;
  const base = path.join(CLAUDE_HOME, "projects");
  if (cwd) {
    for (const slug of [projectSlug(cwd), projectSlug(cwd).toLowerCase()]) {
      const p = path.join(base, slug, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* sin proyectos */ }
  return null;
}

function recentTranscripts(hours) {
  const base = path.join(CLAUDE_HOME, "projects");
  const limit = Date.now() - hours * 3600e3;
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return out; }
  for (const d of dirs) {
    if (d.includes("AppData-Local-Temp") || d.includes("scratch")) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(base, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(base, d, f);
      try { if (fs.statSync(p).mtimeMs >= limit) out.push({ sessionId: f.slice(0, -6), path: p }); } catch {}
    }
  }
  return out;
}

function readTable(table) {
  const db = (() => { try { return openSessionsDb({ readOnly: true }); } catch { return null; } })();
  const out = new Map();
  if (!db) return out;
  try {
    for (const r of db.prepare(`SELECT * FROM ${table}`).all()) out.set(r.session_id, r);
  } catch { /* tabla aun no creada */ }
  finally { db.close(); }
  return out;
}
const readHookRows = () => readTable("agent_sessions");

/**
 * Sesiones "no leidas" segun la extension de VS Code: la marca pone una sesion cuando
 * termina (busy -> idle) con su pestaña fuera de la vista, y la quita al mirarla. Vive en
 * el globalState de VS Code (state.vscdb, clave Anthropic.claude-code -> sessionUnread:<carpeta>).
 * VS Code escribe ese archivo con unos segundos de retraso. Solo lectura y en cache por mtime.
 */
const VSCODE_STATE_DBS = ["Code", "Code - Insiders"].map((p) =>
  path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), p, "User", "globalStorage", "state.vscdb"));
let unreadCache = { key: "", ids: new Set(), available: false };

export function readVscodeUnread() {
  const files = VSCODE_STATE_DBS.filter((f) => fs.existsSync(f));
  const key = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join("|");
  if (key && key === unreadCache.key) return unreadCache;
  const ids = new Set();
  let available = false;
  for (const f of files) {
    let db;
    try {
      db = new DatabaseSync(f, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 500;");
      const row = db.prepare("SELECT value FROM ItemTable WHERE lower(key) = 'anthropic.claude-code'").get();
      if (!row) continue;
      const state = JSON.parse(String(row.value));
      for (const [k, v] of Object.entries(state)) {
        if (!k.startsWith("sessionUnread:") || !Array.isArray(v)) continue;
        available = true;
        for (const id of v) if (typeof id === "string") ids.add(id);
      }
    } catch { /* VS Code escribiendo: se usa lo ultimo leido */
      return unreadCache;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  unreadCache = { key, ids, available };
  return unreadCache;
}
const readMetaRows = () => readTable("agent_session_meta");

function repoFromCwd(cwd) {
  if (!cwd) return null;
  const root = rootOf(cwd);
  if (!root) return path.basename(cwd);
  const rel = path.relative(root, path.resolve(cwd));
  return rel ? rel.split(path.sep)[0] : path.basename(cwd);
}

const ms = (iso) => (iso ? Date.parse(iso) : 0);

/**
 * Estado final de una sesion:
 *   necesita_input  pidio permiso o una respuesta (hook Notification) y nada pasó despues
 *   trabajando      el registro vivo dice busy
 *   esperando       viva, idle y ya respondio: es tu turno
 *   vacia           viva pero sin ningun pedido todavia
 *   cerrada         el proceso ya no existe
 */
function deriveState(live, hook, tr, lastActivity, staleHours = STALE_HOURS) {
  if (!live?.alive) return "cerrada";
  if (live.status === "waiting" || live.waiting_for) return "necesita_input";
  const hookAt = ms(hook?.last_event_at);
  if (hook?.state === "necesita_input" && hookAt >= ms(live.status_at) - 2000) return "necesita_input";
  if (live.status === "busy") return "trabajando";
  if (!tr?.first_prompt && !tr?.last_prompt && !hook?.first_prompt) return "vacia";
  // Nadie le contesta hace horas: probablemente quedo abierta por olvido.
  if (Date.now() - ms(lastActivity) > staleHours * 3600e3) return "en_pausa";
  return "esperando";
}

const ORDER = { necesita_input: 0, trabajando: 2, esperando: 3, en_pausa: 4, vacia: 5, cerrada: 6 };
// Igual que el panel: sin ver (terminadas) → trabajando → tu turno; dentro, la que termino mas reciente primero.
const rank = (r) => (r.state === "necesita_input" ? 0 : r.unseen && r.state !== "trabajando" ? 1 : ORDER[r.state]);

function waitingText(live, hook, tr) {
  if (tr?.pending_question) return `Pregunta: ${tr.pending_question}`;
  const w = live?.waiting_for ?? "";
  if (/permission|tool|approv/i.test(w)) return "Pide permiso para ejecutar una herramienta";
  if (w) return `Esperando: ${w}`;
  return hook?.state_detail ?? "Pidió permiso o una respuesta";
}

/** Enlace que abre la conversacion en la extension de VS Code (handler /open de anthropic.claude-code). */
export const openUrl = (id) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`;

/** Lista unificada de sesiones. `hours`: ventana para incluir sesiones cerradas recientes. */
export function collectSessions({ hours = 12, includeArchived = false, staleHours = STALE_HOURS, conflictHours = CONFLICT_HOURS, only = null } = {}) {
  const live = readLiveRegistry();
  const hooks = readHookRows();
  const metas = readMetaRows();
  const unread = readVscodeUnread();
  // only: solo esas sesiones, sin importar su antiguedad (abrir un chat viejo en el panel).
  const ids = new Set(only ?? [...live.keys()]);
  const hint = new Map();
  if (!only) {
    for (const t of recentTranscripts(hours)) { ids.add(t.sessionId); hint.set(t.sessionId, t.path); }
    const recentLimit = Date.now() - hours * 3600e3;
    for (const [id, h] of hooks) if (ms(h.last_event_at) >= recentLimit) ids.add(id);
  }

  // Sin raices configuradas, se aprenden de los cwd (padre de cada raiz git) antes de nombrar repos.
  for (const l of live.values()) learnFromCwd(l.cwd);
  for (const h of hooks.values()) learnFromCwd(h.cwd);

  const rows = [];
  for (const id of ids) {
    const l = live.get(id) ?? null;
    const h = hooks.get(id) ?? null;
    const cwd = l?.cwd ?? h?.cwd ?? null;
    const tp = findTranscript(id, cwd, hint.get(id) ?? h?.transcript_path);
    const tr = tp ? summarizeTranscript(tp) : null;
    if (!l?.alive && !tr?.first_prompt && !tr?.last_prompt && !h?.first_prompt) continue; // ruido: sesiones vacias ya cerradas
    const lastActivity = [tr?.last_activity, h?.last_event_at, l?.status_at]
      .filter(Boolean).sort((a, b) => ms(b) - ms(a))[0] ?? tr?.transcript_mtime ?? null;
    const state = deriveState(l, h, tr, lastActivity, staleHours);
    const realCwd = tr?.cwd ?? cwd;
    const m = metas.get(id) ?? null;
    // Archivar es "no me la muestres hasta que pase algo nuevo".
    const archived = !!m?.archived_at && ms(lastActivity) <= ms(m.archived_at) + 5000;
    rows.push({
      session_id: id,
      short_id: id.slice(0, 8),
      state,
      title: m?.custom_title ?? tr?.title ?? clip(tr?.first_prompt ?? h?.first_prompt, 70) ?? "(sin título)",
      auto_title: tr?.title ?? null,
      pinned: !!m?.pinned,
      archived,
      // Terminó y no la viste: marca de la extension, salvo que la marcaras vista en el panel
      // despues de su ultima respuesta (el panel no puede borrar la marca de VS Code).
      unseen: unread.ids.has(id) && state !== "trabajando" && state !== "cerrada" &&
        ms(tr?.last_assistant_at ?? lastActivity) > ms(m?.seen_at),
      finished_at: tr?.last_assistant_at ?? null,
      note: m?.note ?? null,
      note_kind: m?.note_kind ?? null,
      auto_accept: !!m?.auto_accept,
      edited_files: tr?.edited_files ?? [],
      assets: assetsOf(mergeWrites(tr?.written ?? [], tp ? scanWrites(tp) : [])),
      work_items: ADO_ORG ? (tr?.work_items ?? []).map((n) => ({ id: n, url: `${ADO_ORG}/_workitems/edit/${n}` })) : [],
      prs: tr?.prs ?? [],
      context_pct: tr?.context_pct ?? null,
      todos: tr?.todos ?? [],
      last_action: tr?.last_action ?? null,
      conflicts: [],
      workspace: repoFromCwd(realCwd),
      cwd: realCwd ?? null,
      repos: tr?.repos ?? [],
      git_branch: tr?.git_branch ?? null,
      first_prompt: clip(tr?.first_prompt ?? h?.first_prompt ?? tr?.last_prompt, 400),
      last_prompt: clip(tr?.last_prompt ?? h?.last_prompt, 400),
      last_response: clip(h?.last_summary && ms(h.last_event_at) >= ms(tr?.last_activity) ? h.last_summary : tr?.last_response, 600),
      needs_input_detail: state === "necesita_input" ? waitingText(l, h, tr) : null,
      asks_question: state === "esperando" || state === "en_pausa" ? !!tr?.asks_question : false,
      open_url: openUrl(id),
      turn_started_at: state === "trabajando" ? h?.turn_started_at ?? l?.status_at ?? null : null,
      last_turn_secs: h?.last_turn_secs ?? null,
      last_activity: lastActivity,
      started_at: l?.started_at ?? h?.started_at ?? null,
      pid: l?.alive ? l.pid : null,
      entrypoint: l?.entrypoint ?? null,
      model: tr?.model ?? null,
      transcript_mb: tr?.size_mb ?? null,
      transcript_path: tp ?? null,
      hooks_active: !!h,
    });
  }
  markConflicts(rows, conflictHours);
  const visible = includeArchived ? rows : rows.filter((r) => !r.archived);
  visible.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (rank(a) - rank(b)) ||
    (ms(b.finished_at ?? b.last_activity) - ms(a.finished_at ?? a.last_activity)));
  return {
    generated_at: nowIso(), hours, archived_count: rows.length - visible.length,
    unread_source: unread.available, unseen_count: visible.filter((r) => r.unseen).length, sessions: visible,
  };
}

/** Fila de una sesion cualquiera (aunque sea vieja o este archivada), con el mismo formato que /api/sesiones. */
export function sessionRow(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("session_id inválido");
  return collectSessions({ only: [sessionId.toLowerCase()], includeArchived: true }).sessions[0] ?? null;
}


/**
 * Dos sesiones vivas que editaron el mismo archivo en las ultimas CONFLICT_HOURS horas:
 * riesgo de pisarse cambios (o de que una trabaje sobre una version vieja).
 */
function markConflicts(rows, conflictHours = CONFLICT_HOURS) {
  const limit = Date.now() - conflictHours * 3600e3;
  const byFile = new Map();
  for (const r of rows) {
    if (r.state === "cerrada") continue;
    for (const f of r.edited_files) {
      if (f.at && ms(f.at) < limit) continue;
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(r);
    }
  }
  for (const [file, rs] of byFile) {
    if (rs.length < 2) continue;
    for (const r of rs) {
      r.conflicts.push({
        file: shortPath(file),
        with: rs.filter((o) => o !== r).map((o) => ({ short_id: o.short_id, title: o.title, open_url: o.open_url })),
      });
    }
  }
}

/** Sesiones con actividad hoy, agrupadas por repo: base del resumen del dia. */
export function dailySummary() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { sessions } = collectSessions({ hours: 24, includeArchived: true });
  const today = sessions.filter((s) => ms(s.last_activity) >= start.getTime());
  const groups = new Map();
  for (const s of today) {
    const key = s.repos[0] ?? s.workspace ?? "otros";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return { date: start.toISOString().slice(0, 10), total: today.length, groups: [...groups.entries()] };
}

export function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} d`;
}

// ---------- Archivos generados ----------
/**
 * Escrituras de archivos en TODO el transcript (no solo en la cola), por regex sobre el texto crudo.
 * Incremental: recuerda hasta donde leyo y la proxima vez solo procesa lo agregado.
 */
const WRITE_RE = /"name":"(Write|Edit|MultiEdit|NotebookEdit)","input":\{"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)+)"/g;
const writeScan = new Map(); // transcript -> { offset, map: Map(norm -> { path, op }) }

function scanWrites(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  let st = writeScan.get(file);
  if (!st || size < st.offset) st = { offset: 0, map: new Map() };
  if (size > st.offset) {
    const start = Math.max(0, st.offset - 4096); // solape por si un registro quedo cortado
    const fd = fs.openSync(file, "r");
    try {
      const CHUNK = 8 * 1048576;
      for (let pos = start; pos < size; pos += CHUNK - 4096) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        for (const m of buf.toString("utf8").matchAll(WRITE_RE)) {
          let fp;
          try { fp = JSON.parse(`"${m[2]}"`); } catch { continue; }
          if (/[\\/](temp|tmp|scratchpad)[\\/]/i.test(fp)) continue;
          const key = normPath(fp);
          if (!st.map.has(key)) st.map.set(key, { path: fp.replace(/^\/([a-z])\//i, "$1:/"), op: m[1] === "Write" ? "creado" : "editado" });
        }
        if (pos + len >= size) break;
      }
    } finally { fs.closeSync(fd); }
    st.offset = size;
    writeScan.set(file, st);
  }
  return [...st.map.values()];
}
/** Tipos que el panel sabe mostrar (o al menos abrir en VS Code). */
export const ASSET_TYPES = {
  md: "markdown", markdown: "markdown", html: "html", htm: "html", svg: "imagen", png: "imagen", jpg: "imagen",
  jpeg: "imagen", gif: "imagen", webp: "imagen", pdf: "pdf", pptx: "office", xlsx: "office", docx: "office",
  csv: "datos", json: "datos", yml: "datos", yaml: "datos", txt: "texto",
};
// Nunca se ofrecen ni se sirven archivos con pinta de secreto, aunque esten en la lista.
export const SECRET_RE = /(^|[\\/])(\.env[^\\/]*|[^\\/]*(secret|token|credential|password|\.pem|\.key|\.pfx)[^\\/]*)$/i;

/** La cola trae hora y menciones; el escaneo completo, lo que quedo atras. Gana la cola. */
function mergeWrites(tail, full) {
  const m = new Map(full.map((w) => [normPath(w.path), w]));
  for (const w of tail) m.set(normPath(w.path), w);
  return [...m.values()];
}

function assetsOf(written) {
  const out = [];
  for (const w of written) {
    const ext = w.path.split(".").pop().toLowerCase();
    const type = ASSET_TYPES[ext];
    if (!type || SECRET_RE.test(w.path)) continue;
    let st = null;
    try { st = fs.statSync(w.path); } catch { /* borrado o movido */ }
    if (w.mention && (!st || !st.isFile())) continue; // una mencion solo cuenta si el archivo existe
    out.push({
      path: w.path, name: path.basename(w.path), ext, type, op: w.op, at: w.at ?? st?.mtime.toISOString() ?? null,
      exists: !!st, size: st?.size ?? null, mtime: st?.mtime.toISOString() ?? null, rel: shortPath(normPath(w.path)),
      // Solo lo que vive bajo una raiz de trabajo se previsualiza en el panel; lo demas, solo en VS Code.
      servable: !!st && !!rootOf(w.path),
      vscode_url: "vscode://file/" + path.resolve(w.path).replace(/\\/g, "/"),
    });
  }
  addSiblings(out);
  return out.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}

/**
 * Entregables vecinos: si la sesion creo/edito un documento dentro de una carpeta de entregables
 * (p. ej. explicaciones/<fecha>_<tema>/), se agregan los .html/.pdf/.pptx de esa carpeta y de su
 * diagramas/ que cambiaron cerca de esa fecha (los HTML de archify salen de scripts, no de Write).
 * No se recorren raices de repos ni las raices de trabajo.
 */
function addSiblings(out) {
  const seen = new Set(out.map((a) => normPath(a.path)));
  const dirs = new Map();
  for (const a of out) {
    if (!a.exists || !a.servable || a.op === "mencionado") continue;
    const dir = path.dirname(path.resolve(a.path));
    const root = rootOf(dir);
    if (!root || path.resolve(root).toLowerCase() === dir.toLowerCase() || fs.existsSync(path.join(dir, ".git"))) continue;
    if (!dirs.has(dir)) dirs.set(dir, a.at);
  }
  for (const [dir, at] of dirs) {
    const ref = Date.parse(at ?? 0) || Date.now();
    for (const sub of ["", "diagramas", "exports"]) {
      let names = [];
      try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
      for (const n of names.slice(0, 200)) {
        const ext = n.split(".").pop().toLowerCase();
        if (!["html", "htm", "pdf", "pptx"].includes(ext)) continue;
        const p = path.join(dir, sub, n);
        if (seen.has(normPath(p)) || SECRET_RE.test(p)) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile() || Math.abs(st.mtimeMs - ref) > 3 * 864e5) continue;
        seen.add(normPath(p));
        out.push({
          path: p, name: n, ext, type: ASSET_TYPES[ext], op: "en carpeta", at: st.mtime.toISOString(),
          exists: true, size: st.size, mtime: st.mtime.toISOString(), rel: shortPath(normPath(p)),
          servable: true, vscode_url: "vscode://file/" + p.replace(/\\/g, "/"),
        });
      }
    }
  }
}

/**
 * ¿Se puede servir este archivo? Solo si alguna sesion lo genero o edito (o, para los recursos de un
 * HTML generado, si esta en su carpeta o debajo), vive bajo una raiz de trabajo, tiene una extension
 * conocida y no parece secreto. Devuelve la ruta real o null.
 */
export function resolveServable(requested, sessions) {
  let real;
  try { real = fs.realpathSync(path.resolve(requested)); } catch { return null; }
  const low = real.toLowerCase();
  if (!rootOf(real) || SECRET_RE.test(real)) return null;
  const ext = path.extname(real).slice(1).toLowerCase();
  if (!SERVABLE_EXT.has(ext)) return null;
  for (const s of sessions) {
    for (const a of s.assets ?? []) {
      let ar;
      try { ar = fs.realpathSync(a.path).toLowerCase(); } catch { continue; }
      if (ar === low) return real;
      if (a.type === "html" && low.startsWith(path.dirname(ar) + path.sep)) return real;
    }
  }
  return null;
}
const SERVABLE_EXT = new Set([...Object.keys(ASSET_TYPES), "css", "js", "mjs", "woff", "woff2", "ttf", "ico"]);

// Tope por respuesta en la conversación. Antes era 4.000 caracteres y cortaba sin aviso las respuestas largas
// (tablas a medio dibujar, 2026-11-25). 60.000 cubre cualquier respuesta normal; si se pasa, se avisa.
const MAX_REPLY = 60000;
const clipReply = (t) => (t.length > MAX_REPLY ? `${t.slice(0, MAX_REPLY)}\n\n*… (respuesta recortada en el panel: ${t.length.toLocaleString("es-CL")} caracteres; ábrela completa en VS Code)*` : t);

/**
 * Detalle de una sesion para la vista bandeja: los ultimos intercambios (tu pedido,
 * texto de Claude y herramientas usadas en medio), sacados de la cola del transcript.
 */
export function sessionDetail(sessionId, { maxTurns = 8 } = {}) {
  maxTurns = Math.max(1, Math.min(400, Number(maxTurns) || 8));
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("session_id inválido");
  const live = readLiveRegistry().get(sessionId);
  const file = findTranscript(sessionId, live?.cwd ?? null, null);
  if (!file) return { session_id: sessionId, turns: [] };
  const size = fs.statSync(file).size;
  // Las salidas de herramientas pueden ocupar megas: se amplia la ventana (hasta 16 MB)
  // hasta encontrar al menos 3 pedidos tuyos.
  let recs = [], recsStart = 0;
  for (let win = TAIL_BYTES; ; win *= 2) {
    const start = Math.max(0, size - win);
    recsStart = start;
    recs = parseLines(readSlice(file, start, size - start), { dropFirst: start > 0 });
    const prompts = recs.filter((r) => r.type === "user" && !r.isSidechain && humanPrompt(r)).length;
    if (prompts >= Math.max(3, maxTurns) || start === 0 || win >= (maxTurns > 8 ? 64 : 16) * 1048576) break;
  }
  const turns = [];
  let cur = null;
  for (const r of recs) {
    if (r.isSidechain) continue;
    if (r.type === "user") {
      const p = humanPrompt(r);
      if (!p) continue;
      cur = { prompt: clip(p, 1500), at: r.timestamp ?? null, replies: [], tools: [] };
      turns.push(cur);
    } else if (r.type === "assistant" && cur) {
      for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (c?.type === "text" && c.text?.trim()) cur.replies.push(clipReply(c.text.trim()));
        if (c?.type === "tool_use") cur.tools.push({ tool: c.name, label: actionLabel(c) });
      }
      cur.end_at = r.timestamp ?? cur.end_at;
    }
  }
  return {
    session_id: sessionId,
    // hay_mas: quedan intercambios anteriores sin mostrar (en el archivo o fuera de la ventana leida).
    hay_mas: turns.length > maxTurns || recs.length > 0 && recsStart > 0,
    turns: turns.slice(-maxTurns).map((t) => ({
      ...t,
      reply: t.replies.at(-1) ?? null,
      tools: t.tools.slice(-25),
      tool_count: t.tools.length,
      replies: undefined,
    })),
  };
}

// ---------- Pedido de permiso/decisión pendiente ----------
// Los hooks pueden estar bloqueados por política (allowManagedHooksOnly), así que NO sabemos del permiso
// por un hook: lo deducimos del transcript. El último mensaje del asistente trae uno o más `tool_use`;
// si ninguno tiene su `tool_result` todavía, la sesión está esperando que apruebes esa(s) herramienta(s).
const EDIT_DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function diffOf(c) {
  const i = c.input ?? {};
  if (c.name === "Write") return { file_path: i.file_path, old: "", new: clip(i.content, 1200) };
  if (c.name === "NotebookEdit") return { file_path: i.notebook_path, old: "", new: clip(i.new_source, 1200) };
  if (c.name === "MultiEdit" && Array.isArray(i.edits)) {
    return {
      file_path: i.file_path,
      old: clip(i.edits.map((e) => e.old_string).join("\n⋯\n"), 1200),
      new: clip(i.edits.map((e) => e.new_string).join("\n⋯\n"), 1200),
    };
  }
  return { file_path: i.file_path, old: clip(i.old_string, 1200), new: clip(i.new_string, 1200) };
}

/**
 * Qué está esperando aprobar una sesión, con su clasificación. Devuelve null si no hay nada pendiente.
 *  - kind "command"|"edit"|"plan"|"tool": binario (Aprobar = tecla "1", Rechazar = Esc).
 *  - kind "choice": pregunta de preferencias; la decide la persona. Si es una sola pregunta de
 *    selección única, cada opción trae la tecla que la elige; si es múltiple, manual: true.
 */
export function pendingRequest(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("session_id inválido");
  const live = readLiveRegistry().get(sessionId);
  const file = findTranscript(sessionId, live?.cwd ?? null, null);
  if (!file) return null;
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const start = Math.max(0, size - TAIL_BYTES);
  const recs = parseLines(readSlice(file, start, size - start), { dropFirst: start > 0 });

  // Último mensaje del asistente con tool_use, y todos los tool_result que vinieron después.
  let lastUse = null;
  const resolved = new Set();
  for (const r of recs) {
    if (r.isSidechain) continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    if (r.type === "assistant") {
      const uses = content.filter((c) => c?.type === "tool_use");
      if (uses.length) { lastUse = { uses, at: r.timestamp ?? null }; resolved.clear(); }
    } else if (r.type === "user") {
      for (const c of content) if (c?.type === "tool_result" && c.tool_use_id) resolved.add(c.tool_use_id);
    }
  }
  if (!lastUse) return null;
  const pend = lastUse.uses.filter((c) => !resolved.has(c.id));
  if (!pend.length) return null;                 // ya respondidas: no hay permiso en espera

  const c = pend[0];                              // el diálogo pregunta de a una herramienta
  const base = { id: c.id, tool: c.name, at: lastUse.at, label: actionLabel(c) };

  if (c.name === "AskUserQuestion") {
    const questions = (c.input?.questions ?? []).map((q) => ({
      question: clip(q.question, 400),
      header: clip(q.header, 40),
      multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({ label: clip(o.label, 120), description: clip(o.description, 240) })),
    }));
    // Las preferencias (AskUserQuestion) se responden en VS Code: elegir una opción no es una sola tecla
    // (son radios/checkboxes que luego se confirman), así que no se automatiza. La persona decide.
    return {
      ...base, kind: "choice", manual: true,
      summary: questions[0]?.question ?? "Elige una opción",
      questions,
    };
  }
  if (c.name === "ExitPlanMode") {
    return { ...base, kind: "plan", manual: false, summary: "Aprobar el plan para empezar a ejecutarlo", detail: { plan: clip(c.input?.plan, 1500) } };
  }
  if (c.name === "Bash") {
    return { ...base, kind: "command", manual: false, summary: c.input?.description ? clip(c.input.description, 120) : "Ejecutar un comando", detail: { command: clip(c.input?.command, 1500), description: clip(c.input?.description, 200) } };
  }
  if (EDIT_DIFF_TOOLS.has(c.name)) {
    const d = diffOf(c);
    return { ...base, kind: "edit", manual: false, summary: `Editar ${String(d.file_path ?? "").split(/[\/]/).pop() || "un archivo"}`, detail: d };
  }
  return { ...base, kind: "tool", manual: false, summary: `Permitir ${c.name}${base.label ? " · " + base.label : ""}`, detail: { input: clip(JSON.stringify(c.input ?? {}), 800) } };
}
