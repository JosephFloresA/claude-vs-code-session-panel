/**
 * Abre un enlace vscode://anthropic.claude-code/open?... desde el servidor y, si se pide, envia el prompt.
 *
 * Por que desde el servidor: asi el panel sabe cuando termino de abrir y puede pulsar Enter (enviar-chat.ps1).
 *   normal              Code.exe --open-url <url>: VS Code lo entrega a su ventana activa.
 *   instancia aparte    Code.exe --user-data-dir <dir> --open-url <url> (config.vscode.userDataDir): el sistema
 *                       mandaria vscode:// al VS Code normal.
 * Si no hay ventana viva (segun los lock de la extension en <CLAUDE_HOME>/ide), primero abre el workspace y
 * espera a que la extension registre su lock (--open-url no admite ademas una ruta).
 */
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOME, VSCODE } from "../config.mjs";

const IDE_DIR = path.join(CLAUDE_HOME, "ide");
// Sin shell (spawn con argumentos), asi que ' es inofensivo; encodeURIComponent no lo codifica.
const ALLOWED = /^vscode:\/\/anthropic\.claude-code\/open(\?[^\s"<>]*)?$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Carpeta o .code-workspace que se abre si no hay ninguna ventana (config.vscode.workspace); sin el, ventana vacia.
const WORKSPACE = VSCODE.workspace;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Ventanas vivas de VS Code con la extension de Claude, segun sus lock. */
function windows() {
  let files = [];
  try { files = fs.readdirSync(IDE_DIR).filter((f) => f.endsWith(".lock")); } catch {}
  return files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), "utf8")); } catch { return null; } })
    .filter((l) => l?.pid && alive(l.pid) && (!l.ideName || /code/i.test(l.ideName)));
}

function launch(args) {
  // Si el panel se lanzo desde una terminal de VS Code hereda VSCODE_*/ELECTRON_*: con ellas Code.exe arranca
  // como proceso interno (o rechaza --user-data-dir) en vez de como la aplicacion. Se quitan todas.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_|CHROME_CRASHPAD)/i.test(k)));
  const pre = VSCODE.userDataDir ? ["--user-data-dir", VSCODE.userDataDir] : [];
  const child = spawn(VSCODE.exe, [...pre, ...args], { env, detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

/** Pulsa Enter en el chat nuevo (enviar-chat.ps1 verifica el titulo de la ventana antes). */
function pressSend() {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "enviar-chat.ps1"),
      "-TitlePattern", VSCODE.titleRe], { timeout: 45000, windowsHide: true }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1))); }
      catch { resolve({ ok: false, reason: "script_error", detail: String(err?.message ?? stdout).slice(0, 300) }); }
    });
  });
}

let queue = Promise.resolve();   // de a una: dos aperturas con envio pelearian por el foco
export function openInVsCode(url, { send = false } = {}) {
  const run = () => openNow(url, send);
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function openNow(url, send) {
  if (typeof url !== "string" || !ALLOWED.test(url)) return { ok: false, reason: "url_no_permitida" };
  if (!fs.existsSync(VSCODE.exe)) return { ok: false, reason: "code_no_encontrado", code: VSCODE.exe };
  try {
    let started = false;
    if (windows().length === 0) {
      launch(WORKSPACE && fs.existsSync(WORKSPACE) ? ["--new-window", WORKSPACE] : ["--new-window"]);
      started = true;
      const until = Date.now() + 45_000;
      while (windows().length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
      if (windows().length === 0) return { ok: false, reason: `${VSCODE.label} no terminó de abrir (45 s)` };
      await new Promise((r) => setTimeout(r, 2500));   // la extension registra el lock antes de aceptar URIs
    }
    launch(["--open-url", url]);
    if (send && /[?&]prompt=/.test(url) && !/[?&]session=/.test(url)) {
      const r = await pressSend();
      return { ok: true, started, sent: !!r.ok, send_reason: r.reason };
    }
    return { ok: true, started, sent: false };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}
