/**
 * Escribano: mantiene hilos/<hilo>.md al dia sin gastar contexto en los chats.
 *
 * Cada TICK_MS mira los chats asociados a cada hilo (ver flujos.mjs). Cuando un chat termino su turno y lleva
 * IDLE_S sin actividad (o se cerro/archivo), lee SOLO lo nuevo de su transcripcion (desde el offset guardado),
 * lo resume con `claude -p --model haiku` (sin herramientas, sin MCP, sin CLAUDE.md, sin guardar sesion) y
 * reescribe el hilo. Uno a la vez. Si el chat se cerro, hace la ultima pasada y libera las reservas del hilo
 * cuando ya no queda ningun chat vivo en el.
 *
 * Estado: <flujos>/.escriba.json  ·  Copias previas: <flujos>/<proyecto>/.escriba/<hilo>/<fecha>.md (ultimas 10)
 * Cada escritura queda ademas en el historial git de flujos/ con actor "escriba" (cambios.writeHiloEscriba).
 * Configuracion: config.ESCRIBA (PANEL_SCRIBE=0 o scribe.enabled=false lo apaga; scribe.model, scribe.claudeExe, scribe.cwd).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ESCRIBA } from "../config.mjs";
import { collectSessions } from "../core.mjs";
import { FLUJOS_DIR, LIMITS, listFlujos } from "./modelo.mjs";
import { releaseReserva, writeFichaEscriba, writeHiloEscriba } from "./cambios.mjs";

export const ESCRIBA_ON = ESCRIBA.on;
const MODEL = ESCRIBA.model;
const CLAUDE = ESCRIBA.claude;
const CWD = ESCRIBA.cwd;      // carpeta vacia: no hay CLAUDE.md de proyecto
const STATE_FILE = path.join(FLUJOS_DIR, ".escriba.json");
const TICK_MS = 20_000, IDLE_S = 60, MIN_BYTES = 400, MAX_DELTA = 60_000, BACKOFF_MS = 5 * 60_000, KEEP = 10;
const BUSY_STATES = new Set(["trabajando", "necesita_input"]);

let state = loadState();
let running = null;            // { sid, project, hilo, since }
const forced = new Set();      // sesiones con "Guardar ahora" pendiente

function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); if (s?.items) return s; } catch {}
  return { created_at: new Date().toISOString(), items: {} };
}
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- transcripcion -> texto compacto ----------
const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const stripTags = (s) => String(s ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, "").trim();
const hhmm = (ts) => { const d = new Date(ts); return isNaN(d) ? "" : `${String(d.getDate()).padStart(2, "0")}-${d.toLocaleString("es", { month: "short" }).replace(".", "")} ${d.toTimeString().slice(0, 5)}`; };

function toolSummary(t) {
  const i = t.input ?? {};
  const main = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? "";
  return `[${t.name}] ${clip(main, 220)}`;
}
function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === "text" ? x.text : "")).join(" ");
  return "";
}

/** Una linea JSONL -> 0..n lineas de texto para el escribano. */
function renderLine(raw) {
  let o; try { o = JSON.parse(raw); } catch { return []; }
  if (o.isSidechain || o.isMeta) return [];
  const ts = o.timestamp ? hhmm(o.timestamp) : "";
  const c = o.message?.content;
  const out = [];
  if (o.type === "user") {
    if (typeof c === "string") { const t = stripTags(c); if (t && !t.startsWith("<command-")) out.push(`\n[${ts}] USUARIO: ${clip(t, 3000)}`); }
    else if (Array.isArray(c)) for (const x of c) {
      if (x.type === "text") { const t = stripTags(x.text); if (t) out.push(`\n[${ts}] USUARIO: ${clip(t, 3000)}`); }
      else if (x.type === "tool_result") { const t = clip(stripTags(resultText(x.content)), 350); if (t) out.push(`   ↳ ${x.is_error ? "ERROR " : ""}${t}`); }
    }
  } else if (o.type === "assistant" && Array.isArray(c)) {
    for (const x of c) {
      if (x.type === "text" && x.text?.trim()) out.push(`\n[${ts}] CLAUDE: ${clip(x.text, 2500)}`);
      else if (x.type === "tool_use") out.push(`   ${toolSummary(x)}`);
    }
  }
  return out;
}

/** Lee desde offset hasta el ultimo salto de linea completo. Corta en MAX_DELTA caracteres de texto. */
function readDelta(file, offset) {
  const size = fs.statSync(file).size;
  if (size <= offset) return { text: "", next: offset, size, first: null, last: null, more: false };
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size - offset, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    let pos = 0, next = offset, text = "", first = null, last = null, more = false;
    while (pos < len) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0) break;                                            // linea incompleta: se lee en la proxima pasada
      const line = buf.toString("utf8", pos, nl);
      const parts = renderLine(line);
      const add = parts.join("\n");
      if (text && text.length + add.length > MAX_DELTA) { more = true; break; }
      if (add) {
        text += (text ? "\n" : "") + add;
        try { const ts = JSON.parse(line).timestamp; if (ts) { first ??= ts; last = ts; } } catch {}
      }
      pos = nl + 1; next = offset + pos;
    }
    return { text: text.slice(0, MAX_DELTA + 4000), next, size, first, last, more };
  } finally { fs.closeSync(fd); }
}

// ---------- llamada a Haiku ----------
const SYSTEM = `Eres el escribano de un pseudoproyecto de trabajo. Mantienes al dia la bitacora de UN hilo a partir de lo nuevo de una conversacion entre el usuario y Claude Code. Escribes en espanol, conciso, con datos literales. Nunca inventas ni deduces.`;

function buildPrompt({ project, hilo, sid, transcript, current, delta }) {
  return `Proyecto: ${project} · Hilo: ${hilo} · Chat: ${sid.slice(0, 8)} · Transcripcion: ${transcript}

REGLAS
1. Responde SOLO con el markdown completo del hilo actualizado. Sin explicaciones ni bloque de codigo.
2. Si lo nuevo no cambia nada que valga la pena guardar (charla, pruebas sin resultado, pasos intermedios), responde exactamente: SIN_CAMBIOS
3. Reescribe, no agregues al final: integra lo nuevo en su seccion y quita lo que quedo superado. Maximo ${LIMITS.hilo} caracteres en total. Si te pasas, fusiona lo antiguo y deja la fecha y el tema en "Donde buscar detalle exacto".
4. Copia literal: IDs, commits, ramas, rutas, tablas, cifras, fechas, jobs, clusters, nombres de archivos. Solo lo que dice la conversacion; lo que quedo sin confirmar marcalo "(no confirmado)".
5. Decisiones: quien decidio (usuario o Claude) y por que. Hallazgos: solo verificados, con su dato.
6. Conserva este formato y estas secciones (crea las que falten):
# Hilo: ${hilo}
- **Sesiones:** <ids de 8 caracteres y titulo> · **Rango de fechas:** <inicio> → <ultima>
- **Estado del hilo:** <activo | en pausa | cerrado> (<una frase>)
## Objetivo del hilo
## Estado al cierre
## Decisiones tomadas
## Hallazgos y datos clave
## Pendientes y bloqueos
## Que toca este hilo
## Donde buscar detalle exacto
7. En "Donde buscar detalle exacto" anota fecha-hora y tema de lo importante de esta conversacion (chat ${sid.slice(0, 8)}).

<hilo_actual>
${current?.trim() || "(vacio: crealo)"}
</hilo_actual>

<conversacion_nueva>
${delta}
</conversacion_nueva>`;
}

function runClaude(prompt, system = SYSTEM, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_|CHROME_CRASHPAD|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)/i.test(k)));
    const args = ["-p", "--model", MODEL, "--tools", "", "--system-prompt", system, "--setting-sources", "",
      "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"];
    let out = "", err = "";
    const ch = spawn(CLAUDE, args, { cwd: CWD, env, windowsHide: true });
    const timer = setTimeout(() => ch.kill(), timeoutMs);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); });
    ch.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return resolve({ ok: false, error: clip(j.result ?? "error", 300) });
        resolve({ ok: true, text: String(j.result ?? ""), cost: j.total_cost_usd ?? 0, usage: j.usage ?? {} });
      } catch { resolve({ ok: false, error: clip(err || out || `salida ${code}`, 300) }); }
    });
    ch.stdin.end(prompt, "utf8");
  });
}

// ---------- escritura del hilo ----------
function backup(project, hiloFile, text) {
  const dir = path.join(FLUJOS_DIR, project, ".escriba", hiloFile.replace(/\.md$/, ""));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), text, "utf8");
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) fs.rmSync(path.join(dir, f), { force: true });
}

function cleanOutput(t) {
  let s = t.trim().replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
  const i = s.indexOf("# Hilo");
  if (i > 0) s = s.slice(i);
  return s;
}

async function processOne(job) {
  const { sid, project, hilo, hiloFile, transcript } = job;
  const it = state.items[sid];
  const hiloPath = path.join(FLUJOS_DIR, project, "hilos", hiloFile);
  running = { sid, project, hilo, since: new Date().toISOString() };
  try {
    const d = readDelta(transcript, it.offset);
    if (!d.text.trim()) { Object.assign(it, { offset: d.next, size: d.size }); return; }
    let current = ""; let mtime0 = 0;
    try { current = fs.readFileSync(hiloPath, "utf8").replace(/\r/g, ""); mtime0 = fs.statSync(hiloPath).mtimeMs; } catch {}
    const r = await runClaude(buildPrompt({ project, hilo, sid, transcript, current, delta: d.text }));
    it.last_try = new Date().toISOString();
    if (!r.ok) { Object.assign(it, { status: "error", error: r.error, retry_at: Date.now() + BACKOFF_MS }); return; }
    it.cost_usd = Math.round(((it.cost_usd ?? 0) + r.cost) * 1e6) / 1e6;
    it.passes = (it.passes ?? 0) + 1;
    it.last_tokens = (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
    const out = r.text.trim();
    if (out === "SIN_CAMBIOS") {
      Object.assign(it, { offset: d.next, size: d.size, status: "ok", result: "sin_cambios", error: null, last_run: new Date().toISOString() });
      return;
    }
    const md = cleanOutput(out);
    if (!md.startsWith("# Hilo") || md.length < 200) {
      Object.assign(it, { status: "error", error: `respuesta no valida: ${clip(out, 160)}`, retry_at: Date.now() + BACKOFF_MS });
      return;
    }
    let mtime1 = 0; try { mtime1 = fs.statSync(hiloPath).mtimeMs; } catch {}
    if (mtime1 !== mtime0) { it.status = "reintento"; it.error = "el hilo cambio mientras se resumia"; return; }   // otro escritor: se rehace
    if (current) backup(project, hiloFile, current);
    writeHiloEscriba(project, hiloFile, md + "\n", `chat ${sid.slice(0, 8)} · ${md.length} caracteres · US$ ${r.cost.toFixed(4)}`);
    Object.assign(it, { offset: d.next, size: d.size, status: "ok", result: md.length > LIMITS.hilo ? "escrito_largo" : "escrito",
      error: null, retry_at: null, last_run: new Date().toISOString(), chars: md.length });
  } finally {
    running = null;
    saveState();
  }
}

// ---------- ciclo ----------
function jobsFrom(flujos, sessions) {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const jobs = [];
  for (const p of flujos.projects) for (const h of p.hilos) {
    const ids = new Set((h.chats ?? []).map((c) => c.session_id));
    if (h.session_info?.session_id) ids.add(h.session_info.session_id);
    for (const sid of ids) {
      const s = byId.get(sid);
      if (!s?.transcript_path) continue;
      jobs.push({ sid, s, project: p.slug, hilo: h.name, hiloFile: h.file, transcript: s.transcript_path, reservas: p.reservas, hiloObj: h });
    }
  }
  return jobs;
}

let ticking = false;
export async function tick() {
  if (!ESCRIBA_ON || ticking || running) return;
  ticking = true;
  try {
    const sessions = collectSessions({ hours: 168, includeArchived: true }).sessions;
    const flujos = listFlujos(sessions);
    const jobs = jobsFrom(flujos, sessions);
    const createdMs = Date.parse(state.created_at);
    let changed = false, next = null;
    for (const j of jobs) {
      let size = 0; try { size = fs.statSync(j.transcript).size; } catch { continue; }
      let it = state.items[j.sid];
      if (!it) {
        // Sesiones que ya existian al encender el escribano: se parte desde el final (su historia ya esta en el hilo).
        const started = Date.parse(j.s.started_at ?? j.s.last_activity ?? 0);
        it = state.items[j.sid] = { project: j.project, hilo: j.hilo, offset: started && started >= createdMs ? 0 : size, size, status: "nuevo" };
        changed = true;
      }
      Object.assign(it, { project: j.project, hilo: j.hilo, size, alive: !!j.s.pid, title: j.s.title ?? null });
      const pending = size - it.offset;
      const idle = (Date.now() - Date.parse(j.s.last_activity ?? 0)) / 1000;
      const ready = pending >= MIN_BYTES && (!it.retry_at || Date.now() > it.retry_at || forced.has(j.sid)) &&
        (forced.has(j.sid) || !j.s.pid || (!BUSY_STATES.has(j.s.state) && idle >= IDLE_S));
      if (ready && (!next || Date.parse(j.s.last_activity ?? 0) < Date.parse(next.s.last_activity ?? 0))) next = j;
      // Cierre: el chat estaba vivo, ya no, y no queda nada por leer -> liberar reservas del hilo si nadie mas sigue en el.
      if (it.was_alive && !j.s.pid && pending < MIN_BYTES) {
        const otherAlive = jobs.some((o) => o.project === j.project && o.hilo === j.hilo && o.sid !== j.sid && o.s.pid);
        if (!otherAlive) {
          const mine = j.reservas.filter((r) => r.hilo === j.hilo);
          for (const r of mine) releaseReserva(j.project, r.raw, { actor: "escriba" });
          it.released = mine.length; it.closed_at = new Date().toISOString();
        }
        it.was_alive = false; changed = true;
      } else if (j.s.pid && !it.was_alive) { it.was_alive = true; changed = true; }
    }
    if (changed) saveState();
    if (next) { forced.delete(next.sid); await processOne(next); }
  } catch (e) {
    state.last_error = String(e?.message ?? e); saveState();
  } finally { ticking = false; }
}

export function startEscriba() {
  if (!ESCRIBA_ON) return;
  fs.mkdirSync(CWD, { recursive: true });
  setInterval(() => { tick(); }, TICK_MS).unref?.();
  setTimeout(() => tick(), 3000);
}

/** "Guardar ahora": fuerza la pasada de todas las sesiones de un hilo (sin esperar los 60 s). */
export function forceHilo(project, hilo) {
  let n = 0;
  for (const [sid, it] of Object.entries(state.items)) if (it.project === project && it.hilo === hilo) { forced.add(sid); n++; }
  setTimeout(() => tick(), 200);
  return { ok: true, sessions: n };
}

/** Bytes de transcripcion que se resumen al asignar una sesion con «incluir lo reciente» (~2 a 4 pasadas). */
export const TRAMO_RECIENTE = 1_500_000;

/**
 * Prepara una sesion recien asignada a un hilo. reciente=false: solo lo que venga desde ahora.
 * reciente=true: tambien el ultimo tramo de lo ya conversado (TRAMO_RECIENTE bytes). Si ya estaba en el estado,
 * se conserva lo avanzado (no se resume dos veces).
 */
export function sembrar(sid, { project, hilo, transcript, reciente = false } = {}) {
  if (!sid || !transcript || state.items[sid]) return { ok: true, ya: !!state.items[sid] };
  let size = 0; try { size = fs.statSync(transcript).size; } catch { return { ok: false, reason: "sin_transcripcion" }; }
  state.items[sid] = { project, hilo, offset: reciente ? Math.max(0, size - TRAMO_RECIENTE) : size, size, status: "nuevo", seeded: reciente ? "reciente" : "desde_ahora" };
  saveState();
  return { ok: true, pendiente_kb: Math.round((size - state.items[sid].offset) / 1024) };
}

/** Fuerza la pasada de una sola sesion (boton «Guardar y cerrar» / «Terminar»). */
export function forceSesion(sid) {
  const it = state.items[sid];
  if (!it) return { ok: false, reason: "sin_hilo" };
  // Con menos de MIN_BYTES pendientes el tick nunca la procesa: no dejarla «en cola» para siempre.
  if (Math.max(0, (it.size ?? 0) - (it.offset ?? 0)) < MIN_BYTES) return { ok: true, nada: true };
  forced.add(sid);
  setTimeout(() => tick(), 200);
  return { ok: true };
}

/** Estado del escribano para una sesion: cuanto falta y si esta corriendo. */
export function estadoSesion(sid) {
  const it = state.items[sid];
  if (!it) return { on: ESCRIBA_ON, conocida: false };
  const pend = Math.max(0, (it.size ?? 0) - (it.offset ?? 0));
  return { on: ESCRIBA_ON, conocida: true, project: it.project, hilo: it.hilo, pendiente_kb: Math.round(pend / 1024),
    al_dia: pend < MIN_BYTES, corriendo: running?.sid === sid, en_cola: forced.has(sid), status: it.status, error: it.error ?? null,
    last_run: it.last_run ?? null, result: it.result ?? null };
}

/** Relee los tamaños de las transcripciones (para «Terminar»: lo ultimo que se dijo debe entrar en la pasada). */
export async function refrescar() { await tick(); }

// ---------- consolidacion de la ficha («Terminar sesion») ----------
const FICHA_SYSTEM = `Eres el escribano de un pseudoproyecto de trabajo. Mantienes al dia la FICHA del proyecto (su estado vivo) a partir de la bitacora de un hilo recien actualizada. Escribes en espanol, conciso, con datos literales. Nunca inventas ni deduces.`;

function buildFichaPrompt({ project, hilo, ficha, hiloMd, fecha }) {
  return `Proyecto: ${project} · Hilo recien actualizado: ${hilo} · Fecha: ${fecha}

REGLAS
1. Responde SOLO con el markdown completo de la ficha actualizada. Sin explicaciones ni bloque de codigo.
2. Si el hilo no aporta nada que cambie la ficha, responde exactamente: SIN_CAMBIOS
3. Reescribe, no agregues al final. LIMITE DURO: ${LIMITS.ficha - 300} caracteres en total (la ficha actual tiene ${ficha.length}). La ficha es el ESTADO del proyecto, no la bitacora: no copies el relato, causas raiz ni listas de archivos del hilo (eso vive en el hilo); deja una linea por tema con el dato clave. Si te pasas, condensa lo mas antiguo.
4. Conserva el titulo, las secciones y su orden. No borres lo que se refiere a OTROS hilos ni a otros temas que el hilo no menciona: solo integra lo nuevo de "${hilo}" y quita lo que ese hilo deja superado (bloqueos resueltos, pasos ya hechos).
5. Actualiza: la linea "Actualizada:" (fecha ${fecha}, "consolidada por el escribano desde el hilo ${hilo}"), el estado actual, decisiones, bloqueos, proximos pasos y la fila de "${hilo}" en la tabla de Hilos (columna Estado, una frase).
6. La seccion "En curso / reservas" se copia EXACTA, linea por linea.
7. Copia literal IDs, commits, ramas, rutas, tablas, cifras y fechas. Lo no confirmado, marcalo "(no confirmado)".

<ficha_actual>
${ficha.trim()}
</ficha_actual>

<hilo_actualizado nombre="${hilo}">
${hiloMd.trim()}
</hilo_actualizado>`;
}

/** Texto de una seccion "## <empieza por nombre>" hasta la siguiente "## " (o null). */
function seccion(md, nombre) {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").startsWith(nombre));
  if (i < 0) return null;
  let j = i + 1; while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
  return { i, j, text: lines.slice(i, j).join("\n") };
}
function reponerSeccion(md, nombre, original) {
  const a = seccion(md, nombre);
  if (!a || original == null) return md;
  const lines = md.split("\n");
  lines.splice(a.i, a.j - a.i, ...original.split("\n"));
  return lines.join("\n");
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Reescribe la ficha integrando el hilo indicado (Haiku, misma llamada aislada que los hilos). Salvaguardas: la
 * seccion de reservas se repone tal cual, la tabla de Hilos debe seguir teniendo todos sus hilos, no se pisa la
 * ficha si alguien la cambio mientras se resumia y se guarda copia en <proyecto>/.escriba/_ficha/.
 * Devuelve { ok, result: "escrita" | "sin_cambios", chars?, cost? } o { ok:false, reason }.
 */
export async function consolidarFicha(project, hiloFile, { sid = "" } = {}) {
  if (!ESCRIBA_ON) return { ok: false, reason: "escriba_apagado" };
  const fichaPath = path.join(FLUJOS_DIR, project, "ficha.md");
  const hiloPath = path.join(FLUJOS_DIR, project, "hilos", hiloFile);
  const t0 = Date.now();
  while ((running || ticking) && Date.now() - t0 < 240_000) await sleep(500);
  if (running || ticking) return { ok: false, reason: "escriba_ocupado" };
  const hilo = hiloFile.replace(/\.md$/, "");
  running = { sid: sid || "ficha", project, hilo: `${hilo} → ficha`, since: new Date().toISOString() };
  try {
    let ficha, hiloMd, mtime0;
    try { ficha = fs.readFileSync(fichaPath, "utf8").replace(/\r/g, ""); mtime0 = fs.statSync(fichaPath).mtimeMs; } catch { return { ok: false, reason: "sin_ficha" }; }
    try { hiloMd = fs.readFileSync(hiloPath, "utf8").replace(/\r/g, ""); } catch { return { ok: false, reason: "sin_hilo" }; }
    const fecha = new Date().toLocaleString("sv-SE", { timeZone: "America/Santiago" }).slice(0, 16);
    const limpiar = (t) => { let s = t.trim().replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim(); const k = s.indexOf("# Ficha"); return k > 0 ? s.slice(k) : s; };
    const r = await runClaude(buildFichaPrompt({ project, hilo, ficha, hiloMd, fecha }), FICHA_SYSTEM, 300_000);
    if (!r.ok) return { ok: false, reason: "modelo", error: r.error };
    const out = r.text.trim();
    if (out === "SIN_CAMBIOS") return { ok: true, result: "sin_cambios", cost: r.cost };
    let md = limpiar(out);
    // Se paso del limite: una pasada de condensacion sobre su propia salida.
    if (md.length > LIMITS.ficha && md.startsWith("# ")) {
      const r2 = await runClaude(`La ficha siguiente tiene ${md.length} caracteres y el limite es ${LIMITS.ficha - 300}. Condensala sin perder datos clave (IDs, rutas, cifras, fechas, pendientes). Conserva titulo, secciones, su orden, la tabla de Hilos completa y la seccion "En curso / reservas" exacta. Responde SOLO con el markdown.\n\n${md}`, FICHA_SYSTEM, 300_000);
      if (r2.ok) { const md2 = limpiar(r2.text); if (md2.startsWith("# ") && md2.length >= 400 && md2.length < md.length) md = md2; r.cost += r2.cost; }
    }
    if (!md.startsWith("# ") || md.length < 400) return { ok: false, reason: "respuesta_no_valida", error: clip(out, 160) };
    if (md.length > LIMITS.ficha * 1.25) return { ok: false, reason: "demasiado_larga", chars: md.length };
    // Reservas: siempre las originales (las libera releaseReserva, no el modelo).
    const res0 = seccion(ficha, "en curso");
    if (res0) md = reponerSeccion(md, "en curso", res0.text);
    // Tabla de hilos: no puede perder filas.
    const tabla0 = seccion(ficha, "hilos"), tabla1 = seccion(md, "hilos");
    if (tabla0) {
      if (!tabla1) return { ok: false, reason: "perdio_tabla_hilos" };
      const nombres = [...tabla0.text.matchAll(/hilos\/([\w.-]+\.md)/g)].map((m) => m[1]);
      const falta = nombres.filter((n) => !tabla1.text.includes(n));
      if (falta.length) return { ok: false, reason: "perdio_hilos", falta };
    }
    let mtime1 = 0; try { mtime1 = fs.statSync(fichaPath).mtimeMs; } catch {}
    if (mtime1 !== mtime0) return { ok: false, reason: "ficha_cambio" };
    backup(project, "_ficha.md", ficha);
    writeFichaEscriba(project, md + "\n", `desde hilo ${hilo}${sid ? ` · chat ${sid.slice(0, 8)}` : ""} · ${md.length} caracteres · US$ ${r.cost.toFixed(4)}`);
    return { ok: true, result: "escrita", chars: md.length, over: md.length > LIMITS.ficha, cost: r.cost };
  } finally {
    running = null;
  }
}

/** Agrega a cada hilo el estado del escribano (para la vista Proyectos). */
export function annotate(flujos) {
  for (const p of flujos.projects) for (const h of p.hilos) {
    const items = Object.entries(state.items).filter(([, it]) => it.project === p.slug && it.hilo === h.name).map(([sid, it]) => ({ sid, ...it }));
    const pending = items.reduce((a, it) => a + Math.max(0, (it.size ?? 0) - (it.offset ?? 0)), 0);
    const last = items.map((it) => it.last_run).filter(Boolean).sort().at(-1) ?? null;
    const err = items.find((it) => it.status === "error");
    h.escriba = {
      on: ESCRIBA_ON, last_run: last, pending_kb: Math.round(pending / 1024), sessions: items.length,
      running: running?.project === p.slug && running?.hilo === h.name,
      error: err?.error ?? null, cost_usd: Math.round(items.reduce((a, it) => a + (it.cost_usd ?? 0), 0) * 1e4) / 1e4,
      passes: items.reduce((a, it) => a + (it.passes ?? 0), 0), forced: items.some((it) => forced.has(it.sid)),
    };
  }
  flujos.escriba = { on: ESCRIBA_ON, model: MODEL, running };
  return flujos;
}
