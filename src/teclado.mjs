/**
 * Teclado sobre pestanas de VS Code ya abiertas: enviar texto (enviar.ps1), responder dialogos de permiso
 * (aprobar.ps1) y la aceptacion automatica por sesion. Todo pasa por una sola cola: dos acciones simultaneas
 * pelearian por el foco y el portapapeles. Desactivado fuera de Windows o con config.keyboard = false (config.TECLADO_ON).
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { TECLADO_ON } from "./config.mjs";
import { collectSessions, pendingRequest } from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);
const LOG = path.join(os.tmpdir(), "monitor-aprobar.log");
const log = (line) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} };

let queue = Promise.resolve();
const serial = (run) => { const p = queue.then(run, run); queue = p.catch(() => {}); return p; };

function liveVsSession(id) {
  const s = collectSessions({ hours: 72 }).sessions.find((x) => x.session_id === id);
  if (!s) return { error: "not_found" };
  if (!s.pid || s.entrypoint !== "claude-vscode") return { error: "not_open" };
  return { s };
}

async function runPs(script, payload, timeout = 20000) {
  const file = path.join(os.tmpdir(), `monitor-${path.basename(script, ".ps1")}-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  try {
    const { stdout } = await execFileP("powershell.exe",
      ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, script), "-InputFile", file],
      { timeout, windowsHide: true });
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  } catch (e) {
    return { ok: false, reason: "script_error", detail: String(e?.message ?? e).slice(0, 300) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Pega y envia texto en la pestana abierta de una sesion (la extension ignora ?prompt= si la pestana existe). */
export function sendToSession(id, text) {
  return serial(async () => {
    if (!TECLADO_ON) return { ok: false, reason: "keyboard_disabled" };
    const t = String(text ?? "").trim();
    if (!t) return { ok: false, reason: "no_text" };
    if (t.length > 20000) return { ok: false, reason: "too_long" };
    const { s, error } = liveVsSession(id);
    if (error) return { ok: false, reason: error };
    // transcript: enviar.ps1 confirma alli que el mensaje llego (y reintenta si el pegado o el Enter se perdieron).
    const out = await runPs("enviar.ps1", { text: t, titles: [s.title, s.auto_title].filter(Boolean), session: id, no_open: true, transcript: s.transcript_path }, 35000);
    log(`enviar title="${s.title}" -> ${JSON.stringify(out)}`);
    return out;
  });
}

/**
 * Cierra la pestaña de una sesion con UI Automation (cerrar_pestana.ps1): la activa por su URI, exige una sola
 * pestaña activa con ese titulo y pulsa su X. Sin teclado ni foco (antes: enviar.ps1 -Accion cerrar con Ctrl+F4).
 */
export function closeSession(id) {
  return serial(async () => {
    if (!TECLADO_ON) return { ok: false, reason: "keyboard_disabled" };
    const { s, error } = liveVsSession(id);
    if (error) return { ok: false, reason: error };
    const out = await runPs("cerrar_pestana.ps1", { titles: [s.title, s.auto_title].filter(Boolean), session: id, open_url: s.open_url }, 25000);
    log(`cerrar title="${s.title}" -> ${JSON.stringify(out)}`);
    return out;
  });
}

const VALID_KEY = /^([1-9]|esc|enter|tab|down|up|space|[a-z])$/;
/** Responde el dialogo de permiso/pregunta: enfoca la pestana, verifica el titulo y pulsa (no salta politicas). */
export function pressKeys(id, { keys, options } = {}) {
  return serial(async () => {
    if (!TECLADO_ON) return { ok: false, reason: "keyboard_disabled" };
    const opts = Array.isArray(options) ? options.map((o) => String(o)).filter((o) => o.trim()).slice(0, 8) : [];
    const ks = (Array.isArray(keys) ? keys : []).map((k) => String(k).toLowerCase()).filter((k) => VALID_KEY.test(k)).slice(0, 4);
    if (!ks.length && !opts.length) return { ok: false, reason: "no_keys" };
    const { s, error } = liveVsSession(id);
    if (error) return { ok: false, reason: error };
    const payload = { titles: [s.title, s.auto_title].filter(Boolean), session: id, no_open: true };
    if (opts.length) payload.options = opts; else payload.keys = ks;
    const out = await runPs("aprobar.ps1", payload);
    log(`${opts.length ? "options=" + opts.join("|") : "keys=" + ks.join("+")} title="${s.title}" -> ${JSON.stringify(out)}`);
    return out;
  });
}

// ---------- aceptacion automatica por sesion ----------
// Aprueba sola el permiso pendiente de las sesiones marcadas auto_accept (nunca las preguntas de opciones).
const autoDone = new Map();     // session_id -> id del tool_use ya aprobado
const autoBusy = new Set();
async function autoAcceptTick() {
  let sessions;
  try { sessions = collectSessions({ hours: 24 }).sessions; } catch { return; }
  const vivos = new Set();
  for (const s of sessions) {
    vivos.add(s.session_id);
    if (!s.auto_accept || !s.pid || s.entrypoint !== "claude-vscode" || s.state !== "necesita_input") continue;
    if (autoBusy.has(s.session_id)) continue;
    let p = null;
    try { p = pendingRequest(s.session_id); } catch {}
    if (!p || p.pending === false || p.manual || p.kind === "choice") continue;
    if (autoDone.get(s.session_id) === p.id) continue;
    autoBusy.add(s.session_id);
    pressKeys(s.session_id, { keys: ["1"] })
      .then((r) => {
        if (r?.ok) autoDone.set(s.session_id, p.id);
        log(`AUTO ${s.session_id.slice(0, 8)} (${p.kind}:${(p.summary ?? p.tool ?? "").slice(0, 60)}) -> ${JSON.stringify(r)}`);
      })
      .catch(() => {})
      .finally(() => autoBusy.delete(s.session_id));
  }
  for (const id of [...autoDone.keys()]) if (!vivos.has(id)) autoDone.delete(id);
}

export function startAutoAccept() {
  if (!TECLADO_ON) return;
  setInterval(() => { autoAcceptTick().catch(() => {}); }, 3500);
}
