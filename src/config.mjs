/**
 * Single source of configuration for the panel.
 *
 * Precedence (highest first):
 *   1. CLI flag --port N
 *   2. Environment variables PANEL_* (and the standard CLAUDE_CONFIG_DIR, ADO_ORG_URL, AZ_CLI_PATH)
 *   3. JSON config file: $PANEL_CONFIG, or %APPDATA%\claude-session-panel\config.json
 *      (~/.config/claude-session-panel/config.json outside Windows). See config.example.json.
 *   4. Defaults below.
 *
 * Every path or switch lives here (not in each module): a new install or a second profile (for example a
 * sandbox with its own CLAUDE_CONFIG_DIR and port) is just another config file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, "..");
export const APP_NAME = "claude-session-panel";
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version; } catch { return "0.0.0"; }
})();
const IS_WIN = process.platform === "win32";

const roaming = process.env.APPDATA ?? (IS_WIN ? path.join(os.homedir(), "AppData", "Roaming") : path.join(os.homedir(), ".config"));
const local = process.env.LOCALAPPDATA ?? (IS_WIN ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));

/** Env var lookup: PANEL_<name>, then the given alternative names (first defined wins). */
function env(name, ...alt) {
  for (const k of [`PANEL_${name}`, ...alt]) {
    const v = process.env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}
const envBool = (v) => (v === undefined ? undefined : !/^(0|false|no|off)$/i.test(v));
const envNum = (v) => (v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
const envList = (v) => (v === undefined ? undefined : v.split(path.delimiter).map((s) => s.trim()).filter(Boolean));
const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);

export const CONFIG_FILE = path.resolve(env("CONFIG") ?? path.join(roaming, APP_NAME, "config.json"));

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`[config] could not read ${CONFIG_FILE}: ${e.message}`);
    return {};
  }
}
const file = readConfigFile();
const sub = (k) => (file[k] && typeof file[k] === "object" ? file[k] : {});
/** Expands %VAR% and a leading ~ in paths coming from the config file. */
const expand = (p) => (typeof p !== "string" ? p
  : p.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m).replace(/^~(?=$|[\\/])/, os.homedir()));
const resolvePath = (p) => (p ? path.resolve(expand(p)) : null);

// ---------- identity ----------
export const PROFILE = String(pick(env("PROFILE"), file.profile, "default"));

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
export const PORT = Number(pick(portIdx >= 0 ? args[portIdx + 1] : undefined, envNum(env("PORT")), file.port, 7820));

// ---------- where Claude Code and your work live ----------
export const CLAUDE_HOME = path.resolve(pick(process.env.CLAUDE_CONFIG_DIR, resolvePath(file.claudeHome), path.join(os.homedir(), ".claude")));

/**
 * Folders that contain your repositories as direct children (e.g. C:\src, with C:\src\my-repo inside).
 * Used to name the repo a session touches, to detect clashes and to decide which generated files the panel
 * may preview. Empty = learned automatically from the working directories of your sessions (parent of each git root).
 */
export const WORKSPACE_ROOTS = (envList(env("WORKSPACE_ROOTS")) ?? file.workspaceRoots ?? [])
  .map(resolvePath).filter(Boolean);
/** Repos that almost every session touches (a control-plane repo): listed last and ignored for suggestions. */
export const DEPRIORITIZED_REPOS = new Set((file.deprioritizedRepos ?? []).map((s) => String(s).toLowerCase()));
/** Extra words ignored when suggesting a project for a session (besides the built-in generic ones). */
export const STOPWORDS = (file.stopwords ?? []).map((s) => String(s).toLowerCase());
/** Tag families shown in Projects: one "type" per project and "groups" (area, team, client...). */
const tags = sub("tags");
export const TAGS = {
  types: Array.isArray(tags.types) ? tags.types.map(String) : ["proyectos-de-mejora", "entregas", "soporte", "gestion"],
  groups: Array.isArray(tags.groups) ? tags.groups.map(String) : [],
  groupsLabel: typeof tags.groupsLabel === "string" ? tags.groupsLabel : "Grupo",
};

// ---------- panel data ----------
export const DATA_DIR = path.resolve(pick(resolvePath(env("DATA_DIR")), resolvePath(file.dataDir), path.join(local, APP_NAME)));
export const DB_PATH = path.resolve(pick(resolvePath(env("DB")), resolvePath(file.database), path.join(DATA_DIR, "panel.db")));

// ---------- projects (project card + threads, with git history) ----------
export const FLUJOS_DIR = path.resolve(pick(resolvePath(env("PROJECTS_DIR")), resolvePath(file.projectsDir), path.join(DATA_DIR, "projects")));
export const FLUJOS_TOOLS = path.resolve(pick(resolvePath(env("TOOLS_DIR")), path.join(APP_ROOT, "tools")));
export const HISTORIAL_ON = pick(envBool(env("PROJECTS_GIT")), file.projectsHistory, true);
export const LIMITS = { ficha: 4500, hilo: 5500, ...(file.limits ?? {}) };
export const RESERVA_VENCE_H = Number(pick(file.reservationHours, 24));

/** Attachments sent from the panel to a chat: kept out of synced folders and deleted after `dias` days. */
export const ADJUNTOS = {
  dir: path.resolve(pick(resolvePath(env("ATTACHMENTS_DIR")), resolvePath(file.attachmentsDir), path.join(DATA_DIR, "attachments"))),
  maxBytes: 25 * 1024 * 1024,
  dias: 30,
};

// ---------- scribe (keeps thread logs up to date with a cheap model) ----------
const scribe = sub("scribe");
const defaultClaude = (() => {
  const p = path.join(os.homedir(), ".local", "bin", IS_WIN ? "claude.exe" : "claude");
  return fs.existsSync(p) ? p : "claude";
})();
export const ESCRIBA = {
  on: pick(envBool(env("SCRIBE")), scribe.enabled, true),
  model: String(pick(env("SCRIBE_MODEL"), scribe.model, "haiku")),
  claude: pick(resolvePath(env("CLAUDE_EXE")), resolvePath(scribe.claudeExe), defaultClaude),
  // Empty folder: `claude -p` runs there without any project CLAUDE.md.
  cwd: path.resolve(pick(resolvePath(env("SCRIBE_CWD")), resolvePath(scribe.cwd), path.join(DATA_DIR, "scribe-cwd"))),
};

// ---------- VS Code ----------
const vs = sub("vscode");
export const VSCODE = {
  label: String(pick(vs.label, "VS Code")),
  exe: pick(resolvePath(env("VSCODE_EXE")), resolvePath(vs.exe),
    IS_WIN ? path.join(local, "Programs", "Microsoft VS Code", "Code.exe") : "code"),
  // Only set when the panel drives a separate VS Code instance (sandbox profile); null = the normal one.
  userDataDir: pick(resolvePath(env("VSCODE_USER_DIR")), resolvePath(vs.userDataDir)),
  // Folder or .code-workspace opened when no VS Code window is running.
  workspace: pick(resolvePath(env("VSCODE_WORKSPACE")), resolvePath(vs.workspace)),
  // Title of the window with a NEW chat focused (the tab is still called "Claude Code"). Enter is only pressed
  // when the window in front matches this.
  titleRe: String(pick(vs.titlePattern, "^Claude Code - .+ - Visual Studio Code$")),
};

// Keyboard / UI Automation on existing tabs (send text, approve permissions, auto-accept). Windows only.
export const TECLADO_ON = IS_WIN && pick(envBool(env("KEYBOARD")), file.keyboard, true);

// ---------- optional integrations ----------
const ado = sub("azureDevOps");
const adoOrg = String(pick(env("ADO_ORG", "ADO_ORG_URL"), ado.org, "")).replace(/\/+$/, "");
/** Azure DevOps organization URL (https://dev.azure.com/<org>) or null when the integration is off. */
export const ADO_ORG = /^https:\/\/dev\.azure\.com\/[\w-]+$/.test(adoOrg) ? adoOrg : null;
/** GitHub PR status through the `gh` CLI (only if it is installed and logged in). */
export const GITHUB_ON = pick(envBool(env("GITHUB")), sub("github").enabled, true);

// ---------- timings ----------
export const STALE_HOURS = Number(pick(envNum(env("STALE_HOURS")), file.staleHours, 3));
export const CONFLICT_HOURS = Number(pick(envNum(env("CONFLICT_HOURS")), file.conflictHours, 24));
export const PERMISSION_WAIT_S = Number(pick(envNum(env("PERMISSION_WAIT_S")), file.permissionWaitSeconds, 120));

/** What the front end needs (embedded in the HTML, no secrets). */
export function publicConfig() {
  return {
    perfil: PROFILE, vscode_label: VSCODE.label, flujos_dir: FLUJOS_DIR, limits: LIMITS,
    brief_migracion: path.join(FLUJOS_TOOLS, "BRIEF_MIGRACION.md"), extractor: path.join(FLUJOS_TOOLS, "extraer.cjs"),
    historial: HISTORIAL_ON, escriba: ESCRIBA.on, teclado: TECLADO_ON,
    // A separate VS Code instance cannot receive vscode:// links from the browser: route them through the server.
    links_via_server: !!VSCODE.userDataDir, ado: !!ADO_ORG, tags: TAGS,
  };
}

/** Summary printed at startup and served by /api/diagnostico. */
export function describeConfig() {
  return {
    config_file: CONFIG_FILE, config_file_found: fs.existsSync(CONFIG_FILE), profile: PROFILE, port: PORT,
    claude_home: CLAUDE_HOME, workspace_roots: WORKSPACE_ROOTS, data_dir: DATA_DIR, database: DB_PATH,
    projects_dir: FLUJOS_DIR, scribe: ESCRIBA.on ? ESCRIBA.model : false, keyboard: TECLADO_ON,
    azure_devops: ADO_ORG, github: GITHUB_ON, vscode: VSCODE.exe,
  };
}
