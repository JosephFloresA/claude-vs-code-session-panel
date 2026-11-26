// Workspace roots, config precedence and integration switches. Runs on temp folders, never on the real config.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "panel-cfg-"));
const ROOT = path.join(TMP, "src");
fs.mkdirSync(path.join(ROOT, "api", ".git"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "control"), { recursive: true });       // no .git: still a repo under a configured root
const CFG = path.join(TMP, "config.json");
fs.writeFileSync(CFG, "﻿" + JSON.stringify({
  port: 7999, workspaceRoots: [ROOT], deprioritizedRepos: ["control"], stopwords: ["acme"],
  projectsDir: path.join(TMP, "projects"), database: path.join(TMP, "p.db"),
}));
process.env.PANEL_CONFIG = CFG;
process.env.PANEL_PORT = "7998";                    // env beats file
delete process.env.PANEL_ADO_ORG; delete process.env.ADO_ORG_URL;

const C = await import("../src/config.mjs");
const W = await import("../src/workspace.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("config: file (with BOM) is read, env overrides it, integrations off by default", () => {
  assert.equal(C.CONFIG_FILE, path.resolve(CFG));
  assert.equal(C.PORT, 7998);
  assert.deepEqual(C.WORKSPACE_ROOTS, [path.resolve(ROOT)]);
  assert.equal(C.DB_PATH, path.resolve(TMP, "p.db"));
  assert.equal(C.ADO_ORG, null);
  assert.equal(C.DEPRIORITIZED_REPOS.has("control"), true);
  assert.equal(C.publicConfig().ado, false);
  assert.equal(C.publicConfig().links_via_server, false);
});

test("workspace: locate, shortPath and repo names inside text in any slash style", () => {
  const f = path.join(ROOT, "api", "src", "app.py");
  assert.deepEqual(W.locate(f), { root: path.resolve(ROOT), repo: "api", rel: "src/app.py" });
  assert.equal(W.shortPath(f), "api/src/app.py");
  assert.equal(W.locate(path.join(TMP, "other", "x.py")), null);
  const fwd = path.join(ROOT, "api", "x").replace(/\\/g, "/");
  const jsonEsc = JSON.stringify({ file_path: path.join(ROOT, "control", "y") });
  assert.deepEqual(W.reposIn(`cd ${fwd} && ls`), ["api"]);
  assert.deepEqual(W.reposIn(jsonEsc), ["control"]);
  assert.deepEqual(W.reposIn(path.join(ROOT, "missing", "z")), [], "a folder that does not exist is not a repo");
  assert.equal(W.repoDir("api"), path.join(path.resolve(ROOT), "api"));
  assert.equal(W.repoDir("control"), null, "git status only for real git repos");
  assert.equal(W.repoDir("../etc"), null);
});

test("workspace: gitRootOf walks up to the nearest .git", () => {
  const deep = path.join(ROOT, "api", "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(W.gitRootOf(deep), path.join(ROOT, "api"));
  assert.equal(W.gitRootOf(path.join(ROOT, "control")), null);
});
