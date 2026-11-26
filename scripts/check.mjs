#!/usr/bin/env node
/**
 * Pre-push check: syntax of every module + no personal or organization data in the tracked files.
 *
 *   npm run check
 *
 * Extra forbidden words (your company, your user name...) go in a local, untracked file:
 *   .check-forbidden.txt   one word or regex per line (# comments allowed)
 * CI runs the same script, so a leak fails the build.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
let files;
try { files = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean); }
catch { console.error("check: needs a git checkout"); process.exit(2); }

const problems = [];

// 1. Syntax of every JS module (node --check).
for (const f of files.filter((x) => /\.(mjs|cjs|js)$/.test(x))) {
  try { execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" }); }
  catch (e) { problems.push(`${f}: syntax error\n${String(e.stderr).split("\n").slice(0, 4).join("\n")}`); }
}

// 2. Secrets and personal data.
const BUILTIN = [
  /\b[\w.+-]+@(?!example\.|users\.noreply\.github\.com|[\w-]+\.local\b)[\w-]+\.[\w.-]+\b/,   // e-mail addresses
  /[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$|\{)[^\\/\s"'`]+/i,                         // C:\Users\<real name>
  /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,                                      // GitHub tokens
  /\bdapi[0-9a-f]{32}\b/,                                                          // Databricks tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,             // GUIDs (tenant/client ids)
];
// Test fixtures and public well-known ids (Windows PowerShell AppUserModelID used by toast.ps1).
const ALLOW_GUID = /^(cccccccc|aaaaaaaa|bbbbbbbb|00000000|0123abcd)-|^1AC14E77-02E7-4E5D-B744-2EB1AE5198B7$/i;
const extra = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, ".check-forbidden.txt"), "utf8").split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));
  } catch { return []; }
})();
const SKIP = new Set(["scripts/check.mjs", "package-lock.json"]);
for (const f of files) {
  if (SKIP.has(f) || /\.(png|jpg|ico|woff2?)$/i.test(f)) continue;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const re of [...BUILTIN, ...extra]) {
      const m = line.match(re);
      if (!m || (re === BUILTIN[5] && ALLOW_GUID.test(m[0]))) continue;
      problems.push(`${f}:${i + 1}: "${m[0]}" (${re.source.slice(0, 40)})`);
    }
  });
}

if (problems.length) {
  console.error(`check: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`check: ok (${files.length} files, ${extra.length} local forbidden patterns)`);
