/**
 * Workspace roots: folders whose direct children are your repositories.
 *
 * Configured roots (config.workspaceRoots) win. With none configured, roots are learned from the working
 * directories of your sessions: the parent of each git root (C:\src\app\sub -> git root C:\src\app -> root C:\src).
 * A child of a configured root counts as a repo even without .git (a plain control folder is still a "repo"
 * for naming and clash detection); a child of a learned root needs .git.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOTS } from "./config.mjs";

const norm = (p) => path.resolve(p).toLowerCase();
const configured = WORKSPACE_ROOTS.map((p) => path.resolve(p));
const learned = new Map();            // norm(root) -> root
const gitRootCache = new Map();       // norm(dir) -> git root | null

/** All roots, configured first. */
export function roots() {
  return configured.length ? configured : [...learned.values()];
}
export const hasConfiguredRoots = () => configured.length > 0;

/** Nearest folder at or above `dir` that contains .git (cached). */
export function gitRootOf(dir) {
  if (!dir) return null;
  const key = norm(dir);
  if (gitRootCache.has(key)) return gitRootCache.get(key);
  let cur = path.resolve(dir), found = null;
  for (let i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(cur, ".git"))) { found = cur; break; } } catch { break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  gitRootCache.set(key, found);
  return found;
}

const seenCwd = new Set();
const gitChildren = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 300)
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(dir, d.name, ".git"))).length;
  } catch { return 0; }
};
const usable = (dir) => dir && norm(dir) !== norm(os.homedir()) && path.parse(dir).root !== path.resolve(dir);

/**
 * Learns a root from a session working directory (only when no roots are configured):
 *   inside a git repo            -> the folder that holds that repo (C:\src\app\sub -> C:\src)
 *   not inside a git repo        -> whichever of the folder or its parent holds more git repos (the multi-repo
 *                                   folder itself, or a plain control folder that sits among repos)
 */
export function learnFromCwd(cwd) {
  if (configured.length || !cwd || seenCwd.has(norm(cwd))) return;
  seenCwd.add(norm(cwd));
  const g = gitRootOf(cwd);
  const here = path.resolve(cwd);
  let root = g ? path.dirname(g) : null;
  if (!root) {
    const nHere = gitChildren(here), nUp = gitChildren(path.dirname(here));
    root = nUp > nHere ? path.dirname(here) : nHere > 0 ? here : null;
  }
  if (!usable(root)) return;
  if (!learned.has(norm(root))) { learned.set(norm(root), root); rootPatterns = null; }
}

/** Root that contains `p`, or null. */
export function rootOf(p) {
  if (!p) return null;
  const low = norm(fixDrive(p));
  return roots().find((r) => low === norm(r) || low.startsWith(norm(r) + path.sep)) ?? null;
}

/** "/c/src/..." (Git Bash) -> "c:/src/...". */
export const fixDrive = (p) => String(p).replace(/^\/([a-z])\//i, "$1:/");

const repoCache = new Map();
/** Is `name` a repo directly under `root`? */
export function isRepo(root, name) {
  if (!name || name.startsWith(".")) return false;
  const key = `${norm(root)}|${name.toLowerCase()}`;
  if (!repoCache.has(key)) {
    let ok = false;
    try {
      const dir = path.join(root, name);
      ok = fs.statSync(dir).isDirectory() && (configured.length > 0 || fs.existsSync(path.join(dir, ".git")));
    } catch {}
    repoCache.set(key, ok);
  }
  return repoCache.get(key);
}

/** Absolute path -> { root, repo, rel } (rel with forward slashes) or null if it is outside every root. */
export function locate(file) {
  const f = path.resolve(fixDrive(file));
  const root = rootOf(f);
  if (!root) return null;
  const parts = path.relative(root, f).split(path.sep).filter(Boolean);
  if (!parts.length) return null;
  const [repo, ...rest] = parts;
  return { root, repo, rel: rest.join("/") };
}

/** Folder of a repo by name (first root that has it with .git), or null. */
export function repoDir(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  for (const r of roots()) {
    const dir = path.join(r, name);
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
  }
  return null;
}

/** Path relative to its root ("repo/dir/file") or the original path when outside every root. */
export function shortPath(p) {
  const root = rootOf(p);
  if (!root) return p;
  const rel = path.relative(root, path.resolve(fixDrive(p)));
  return rel ? rel.replace(/\\/g, "/") : p;
}

// Regexes that find "<root>/<repo>" inside any text (JSON-escaped backslashes, forward slashes, /c/ drive form).
let rootPatterns = null;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function patterns() {
  if (rootPatterns) return rootPatterns;
  rootPatterns = roots().map((r) => {
    const segs = path.resolve(r).split(/[\\/]+/).filter(Boolean).filter((s) => !/^[a-z]:$/i.test(s));
    return { root: r, re: new RegExp(`${segs.map(esc).join("[\\\\/]+")}[\\\\/]+([A-Za-z0-9_.-]+)`, "gi") };
  });
  return rootPatterns;
}

/** Repo names mentioned in a text (tool inputs, commands). */
export function reposIn(text) {
  const out = [];
  for (const { root, re } of patterns()) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) if (isRepo(root, m[1])) out.push(m[1]);
  }
  return out;
}
