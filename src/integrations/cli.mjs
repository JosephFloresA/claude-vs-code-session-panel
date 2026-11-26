/**
 * Runs the optional external CLIs (Azure CLI `az`, GitHub CLI `gh`) without a shell: arguments always go
 * through argv, so titles or ids can never be interpreted as shell syntax.
 *
 * On Windows `az` is an az.cmd, and since Node 20.15 / 22 spawn() rejects .cmd files unless shell:true.
 * az.cmd only runs `python.exe -IBm azure.cli %*`, so we call that interpreter directly.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const cache = new Map();

function findOnPath(names, extraDirs = []) {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) for (const n of names) {
    const full = path.join(dir, n);
    try { if (fs.statSync(full).isFile()) return full; } catch {}
  }
  return null;
}

/** { bin, prefix } to launch az, or null if it is not installed. */
export function azLauncher() {
  if (cache.has("az")) return cache.get("az");
  let l = null;
  const custom = process.env.AZ_CLI_PATH;
  if (custom && fs.existsSync(custom)) {
    l = /python(\.exe)?$/i.test(custom) ? { bin: custom, prefix: ["-IBm", "azure.cli"] } : { bin: custom, prefix: [] };
  } else if (!IS_WIN) {
    const p = findOnPath(["az"]);
    l = p ? { bin: p, prefix: [] } : null;
  } else {
    const p = findOnPath(["az.cmd", "az.exe"], [
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin",
      "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin",
    ]);
    if (p) {
      const python = path.resolve(path.dirname(p), "..", "python.exe");
      l = fs.existsSync(python) ? { bin: python, prefix: ["-IBm", "azure.cli"] }
        : p.toLowerCase().endsWith(".exe") ? { bin: p, prefix: [] } : null;
    }
  }
  cache.set("az", l);
  return l;
}

/** Path to gh, or null. */
export function ghPath() {
  if (!cache.has("gh")) cache.set("gh", findOnPath(IS_WIN ? ["gh.exe"] : ["gh"], IS_WIN ? ["C:\\Program Files\\GitHub CLI"] : []));
  return cache.get("gh");
}

function runJson(bin, argv, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout, windowsHide: true, maxBuffer: 8 * 1048576 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(String(stderr || err.message).split("\n").find((x) => x.trim())?.slice(0, 300) ?? "error")); return; }
      const t = String(stdout ?? "").trim();
      try { resolve(t ? JSON.parse(t) : null); } catch { reject(new Error("invalid JSON from CLI")); }
    });
  });
}

/** az <args> -o json. Throws if az is missing or fails. */
export function azJson(args, { timeout = 40e3 } = {}) {
  const l = azLauncher();
  if (!l) return Promise.reject(new Error("Azure CLI (az) not found; set AZ_CLI_PATH or install it"));
  const devops = ["boards", "repos", "pipelines", "artifacts", "devops"].includes(args[0]);
  const out = devops ? ["-o", "json", "--only-show-errors", "--detect", "false"] : ["-o", "json", "--only-show-errors"];
  return runJson(l.bin, [...l.prefix, ...args, ...out], timeout);
}

/** gh <args> (must already ask for --json). Throws if gh is missing or fails. */
export function ghJson(args, { timeout = 30e3 } = {}) {
  const p = ghPath();
  if (!p) return Promise.reject(new Error("GitHub CLI (gh) not found"));
  return runJson(p, args, timeout);
}
