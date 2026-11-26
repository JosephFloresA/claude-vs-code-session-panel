/**
 * Estado git de los repos que toca cada sesion y estado de sus PR (Azure DevOps con `az`, GitHub con `gh`).
 *
 * Todo se cachea y se refresca en segundo plano: el panel nunca espera a git ni a los CLI.
 *   - git status: cache de 30 s por repo (local, rapido).
 *   - PR: cache de 5 min por PR, maximo 2 consultas a la vez (cada una tarda ~4 s).
 * Solo lectura: no hace fetch, pull, commit ni nada que cambie un repo o un PR.
 * Sin el CLI correspondiente, el PR queda con estado "sin datos" (el enlace sigue funcionando).
 */
import { execFile } from "node:child_process";
import { GITHUB_ON } from "./config.mjs";
import { azJson, ghJson } from "./integrations/cli.mjs";
import { repoDir } from "./workspace.mjs";

const GIT_TTL = 30e3;
const PR_TTL = 5 * 60e3;
const repos = new Map(); // nombre -> { at, data, busy }
const prs = new Map();   // "repo#id" -> { at, data, busy, pr: { provider, org, repo, id } }
let prRunning = 0;
const prQueue = [];

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20e3, windowsHide: true, maxBuffer: 4 * 1048576, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") }));
});

async function refreshRepo(name) {
  const e = repos.get(name) ?? {};
  if (e.busy) return;
  e.busy = true;
  repos.set(name, e);
  const dir = repoDir(name);
  if (!dir) { Object.assign(e, { busy: false, at: Date.now(), data: null }); return; }
  const st = await run("git", ["-C", dir, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  const log = await run("git", ["-C", dir, "log", "-1", "--format=%h%x1f%cr%x1f%s"]);
  const d = { branch: null, upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0, last: null, error: st.ok ? null : st.stderr.slice(0, 200) };
  for (const l of st.stdout.split("\n")) {
    if (l.startsWith("# branch.head ")) d.branch = l.slice(14).trim();
    else if (l.startsWith("# branch.upstream ")) d.upstream = l.slice(18).trim();
    else if (l.startsWith("# branch.ab ")) { const m = l.match(/\+(\d+) -(\d+)/); if (m) { d.ahead = +m[1]; d.behind = +m[2]; } }
    else if (/^[12u] /.test(l)) d.changed++;
    else if (l.startsWith("? ")) d.untracked++;
  }
  if (log.ok && log.stdout.trim()) { const [hash, when, subject] = log.stdout.trim().split("\x1f"); d.last = { hash, when, subject }; }
  Object.assign(e, { busy: false, at: Date.now(), data: d });
}

function pumpPrs() {
  while (prRunning < 2 && prQueue.length) {
    const key = prQueue.shift();
    const e = prs.get(key);
    prRunning++;
    fetchPr(e.pr)
      .then((data) => data, (err) => ({ error: String(err?.message ?? err).slice(0, 200) }))
      .then((data) => Object.assign(e, { busy: false, at: Date.now(), data }))
      .finally(() => { prRunning--; pumpPrs(); });
  }
}

const ADO_QUERY = "{status:status,isDraft:isDraft,title:title,votes:reviewers[].vote,merge:mergeStatus,target:targetRefName,source:sourceRefName}";

/** Lee un PR con el CLI de su proveedor y lo normaliza al formato de az (status, isDraft, votes, merge). */
async function fetchPr(pr) {
  if (pr.provider === "github") {
    if (!GITHUB_ON) return { error: "integración GitHub apagada" };
    const d = await ghJson(["pr", "view", String(pr.id), "--repo", pr.repo, "--json", "state,isDraft,title,reviewDecision,mergeable,baseRefName,headRefName"]);
    const votes = d.reviewDecision === "APPROVED" ? [10] : d.reviewDecision === "CHANGES_REQUESTED" ? [-5] : [];
    const status = d.state === "MERGED" ? "completed" : d.state === "CLOSED" ? "abandoned" : "active";
    return { status, isDraft: !!d.isDraft, title: d.title, votes, merge: d.mergeable === "CONFLICTING" ? "conflicts" : "succeeded",
      target: d.baseRefName, source: d.headRefName };
  }
  return azJson(["repos", "pr", "show", "--id", String(pr.id), "--org", pr.org, "--query", ADO_QUERY]);
}

/** Estado legible de un PR (formato de az; los de GitHub se normalizan en fetchPr). */
export function prState(d) {
  if (!d) return { key: "cargando", label: "consultando…" };
  if (d.error) return { key: "error", label: "sin datos", detail: d.error };
  const votes = d.votes ?? [];
  if (d.status === "completed") return { key: "completado", label: "completado" };
  if (d.status === "abandoned") return { key: "abandonado", label: "abandonado" };
  if (d.isDraft) return { key: "borrador", label: "borrador" };
  if (votes.some((v) => v === -10)) return { key: "rechazado", label: "rechazado" };
  if (votes.some((v) => v === -5)) return { key: "esperando", label: "esperando al autor" };
  if (votes.some((v) => v >= 5)) return { key: "aprobado", label: d.merge === "conflicts" ? "aprobado · conflictos" : "aprobado" };
  return { key: "revision", label: d.merge === "conflicts" ? "en revisión · conflictos" : "en revisión" };
}

/**
 * Estado conocido ahora (lo que haya en cache) para las sesiones dadas, y encola refrescos vencidos.
 * Devuelve { repos: {nombre: estado}, prs: {"repo#id": {..., state}} }.
 */
export function gitInfo(sessions) {
  const now = Date.now();
  const repoNames = new Set();
  const prKeys = new Map();   // key -> pr
  for (const s of sessions) {
    for (const r of [...(s.repos ?? []), s.workspace].filter(Boolean)) repoNames.add(r);
    for (const p of s.prs ?? []) {
      if (!/^\d+$/.test(String(p.id))) continue;
      const ok = p.provider === "github" ? /^[\w.-]+\/[\w.-]+$/.test(p.repo)
        : /^[\w.-]+$/.test(p.repo) && /^https:\/\/dev\.azure\.com\/[\w-]+$/.test(p.org ?? "");
      if (ok) prKeys.set(`${p.repo}#${p.id}`, p);
    }
  }
  const outRepos = {};
  for (const name of repoNames) {
    const e = repos.get(name);
    if (!e || (!e.busy && now - e.at > GIT_TTL)) refreshRepo(name);
    if (e?.data) outRepos[name] = e.data;
  }
  const outPrs = {};
  for (const [key, pr] of prKeys) {
    let e = prs.get(key);
    if (!e) { e = { at: 0, data: null, busy: false, pr }; prs.set(key, e); }
    if (!e.busy && now - e.at > PR_TTL) { e.busy = true; prQueue.push(key); }
    outPrs[key] = { ...(e.data ?? {}), state: prState(e.data) };
  }
  pumpPrs();
  return { repos: outRepos, prs: outPrs };
}
