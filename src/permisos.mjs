/**
 * Aprobacion remota de permisos desde el panel de sesiones.
 *
 * Flujo: el hook PermissionRequest (mcp/hooks/permission-request.mjs) consulta si el modo esta
 * encendido. Apagado -> sale al instante sin decidir (dialogo normal). Encendido -> registra el pedido
 * aqui, espera la decision de la persona en el panel (hasta WAIT_SECS) y la devuelve a Claude Code.
 * Si nadie decide, expira y se muestra el dialogo normal. Nada se aprueba sin un clic.
 */
import crypto from "node:crypto";
import { openSessionsDb, clip } from "./core.mjs";
import { PERMISSION_WAIT_S } from "./config.mjs";

export const WAIT_SECS = PERMISSION_WAIT_S;

export const PERMISOS_SQL = `
CREATE TABLE IF NOT EXISTS permission_requests (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  cwd           TEXT,
  agent         TEXT,
  tool_name     TEXT,
  tool_input    TEXT,             -- JSON recortado (para mostrar el detalle / diff)
  summary       TEXT,
  risky         INTEGER NOT NULL DEFAULT 0,
  risk_reason   TEXT,
  created_at    TEXT,
  expires_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | allow | deny | expired
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_perm_status ON permission_requests(status, created_at);
CREATE TABLE IF NOT EXISTS monitor_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);
`;

const now = () => new Date().toISOString();

function db(readOnly = false) {
  const d = openSessionsDb({ readOnly });
  if (!d) return null;
  if (!readOnly) d.exec(PERMISOS_SQL);
  return d;
}

// ---------- Modo ----------
/** { on, until } — se apaga solo al pasar `until`. */
export function getMode() {
  let d;
  try {
    d = db(true);
    if (!d) return { on: false, until: null };
    const row = d.prepare("SELECT value FROM monitor_flags WHERE key = 'aprobacion_remota'").get();
    const v = row ? JSON.parse(row.value) : null;
    const on = !!v?.on && Date.parse(v.until) > Date.now();
    return { on, until: on ? v.until : null };
  } catch {
    return { on: false, until: null };
  } finally {
    try { d?.close(); } catch {}
  }
}

export function setMode(on, hours = 4) {
  const until = new Date(Date.now() + Math.min(24, Math.max(0.25, hours)) * 3600e3).toISOString();
  const d = db();
  try {
    d.prepare(`INSERT INTO monitor_flags (key, value, updated_at) VALUES ('aprobacion_remota', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ on: !!on, until: on ? until : null }), now());
    if (!on) {
      // Al apagar, lo pendiente vuelve al dialogo normal de VS Code.
      d.prepare("UPDATE permission_requests SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(now());
    }
  } finally { d.close(); }
  return getMode();
}

// ---------- Registro de llamadas del hook ----------
/**
 * Anota que Claude Code llamo al hook PermissionRequest (aunque el modo este apagado), para saber si el hook
 * corre de verdad en la extension: { count, last_at, last_tool, last_session, last_mode_on }. Nunca lanza.
 */
export function noteHookCall(p, modeOn) {
  let d;
  try {
    d = db();
    if (!d) return;
    const row = d.prepare("SELECT value FROM monitor_flags WHERE key = 'hook_permisos'").get();
    const prev = row ? JSON.parse(row.value) : {};
    const value = {
      count: (prev.count ?? 0) + 1, first_at: prev.first_at ?? now(), last_at: now(),
      last_tool: p?.tool_name ?? null, last_session: p?.session_id ?? null, last_mode_on: !!modeOn,
    };
    d.prepare(`INSERT INTO monitor_flags (key, value, updated_at) VALUES ('hook_permisos', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(value), now());
  } catch { /* el registro es solo diagnostico */ } finally {
    try { d?.close(); } catch {}
  }
}

/** Ultimas llamadas del hook (ver noteHookCall), o null si nunca se llamo. */
export function getHookSeen() {
  let d;
  try {
    d = db(true);
    const row = d?.prepare("SELECT value FROM monitor_flags WHERE key = 'hook_permisos'").get();
    return row ? JSON.parse(row.value) : null;
  } catch { return null; } finally {
    try { d?.close(); } catch {}
  }
}

// ---------- Riesgo ----------
const RISK_RULES = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b|Remove-Item\b[^|;]*-Recurse|\brmdir\s+\/s|\bdel\s+\/[sq]/i, "borrado recursivo"],
  [/\bgit\s+push\b[^|;]*(--force\b|-f\b|--force-with-lease)/i, "git push forzado"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|push\b[^|;]*--delete)/i, "operación git destructiva"],
  [/\bdrop\s+(table|schema|catalog|database|view)\b|\btruncate\s+table\b|\bdelete\s+from\b/i, "SQL destructivo"],
  [/\bbundle\s+(deploy|destroy)\b[^|;]*(-t|--target)\s*=?\s*prod|\b(deploy|destroy)\b[^|;]*\bprod(uction)?\b/i, "despliegue o destrucción en prod"],
  [/\baz\s+(group|resource|keyvault|ad|role)\s+\S*\s*(delete|purge)|\bdatabricks\s+\S+\s+delete\b/i, "borrado en la nube"],
  [/--no-verify\b|--dangerously|bypassPermissions/i, "salta resguardos"],
];

export function assessRisk(tool, input) {
  const name = String(tool ?? "");
  if (/delete|remove|destroy|purge/i.test(name) && name.startsWith("mcp__")) return "herramienta MCP de borrado";
  const text = name === "Bash" || name === "PowerShell" ? String(input?.command ?? "") : "";
  for (const [re, why] of RISK_RULES) if (text && re.test(text)) return why;
  return null;
}

export function summarize(tool, input = {}) {
  const base = (p) => String(p ?? "").split(/[\\/]/).slice(-3).join("/");
  switch (tool) {
    case "Bash": case "PowerShell": return clip(input.command, 300) + (input.description ? `  — ${clip(input.description, 120)}` : "");
    case "Edit": case "MultiEdit": return `Editar ${base(input.file_path)}`;
    case "Write": return `Escribir ${base(input.file_path)} (${String(input.content ?? "").split("\n").length} líneas)`;
    case "NotebookEdit": return `Editar notebook ${base(input.notebook_path)}`;
    case "WebFetch": return `Leer ${clip(input.url, 200)}`;
    default: return clip(JSON.stringify(input), 300);
  }
}

// ---------- Pedidos ----------
export function createRequest(p) {
  const id = crypto.randomUUID();
  const input = p.tool_input ?? {};
  const risk = assessRisk(p.tool_name, input);
  const created = now();
  const d = db();
  try {
    d.prepare(`INSERT INTO permission_requests (id, session_id, cwd, agent, tool_name, tool_input, summary, risky, risk_reason, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, p.session_id ?? null, p.cwd ?? null, p.agent_type ?? null, p.tool_name ?? null,
        JSON.stringify(input).slice(0, 24000), summarize(p.tool_name, input), risk ? 1 : 0, risk,
        created, new Date(Date.now() + WAIT_SECS * 1000).toISOString());
  } finally { d.close(); }
  return id;
}

export function readDecision(id) {
  const d = db(true);
  try { return d.prepare("SELECT status FROM permission_requests WHERE id = ?").get(id)?.status ?? null; }
  finally { d.close(); }
}

export function expire(id) {
  const d = db();
  try { d.prepare("UPDATE permission_requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), id); }
  finally { d.close(); }
}

/** Decide uno o varios. Con `skipRisky`, los riesgosos quedan pendientes (solo uno por uno). */
export function decide(ids, decision, { skipRisky = false } = {}) {
  if (!["allow", "deny"].includes(decision)) throw new Error("decisión inválida");
  const d = db();
  let changed = 0;
  try {
    const stmt = d.prepare(`UPDATE permission_requests SET status = ?, decided_at = ?
                            WHERE id = ? AND status = 'pending' AND expires_at > ? ${skipRisky ? "AND risky = 0" : ""}`);
    for (const id of ids) changed += Number(stmt.run(decision, now(), id, now()).changes);
  } finally { d.close(); }
  return changed;
}

export function listRequests() {
  const d = db();
  try {
    d.prepare("UPDATE permission_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(now());
    const rows = d.prepare(`SELECT * FROM permission_requests
                            WHERE status = 'pending' OR decided_at >= ? ORDER BY created_at DESC LIMIT 60`)
      .all(new Date(Date.now() - 3600e3).toISOString());
    return rows.map((r) => {
      let input = {};
      try { input = JSON.parse(r.tool_input); } catch {}
      const preview = {};
      if (input.old_string != null) { preview.old = String(input.old_string).slice(0, 4000); preview.new = String(input.new_string ?? "").slice(0, 4000); }
      if (input.content != null) preview.content = String(input.content).slice(0, 4000);
      if (input.command != null) preview.command = String(input.command).slice(0, 4000);
      return { ...r, tool_input: undefined, risky: !!r.risky, file: input.file_path ?? input.notebook_path ?? null, preview };
    });
  } finally { d.close(); }
}
