/**
 * Actividad del dia por sesion: linea de tiempo (trabajando / esperandote) y tokens + costo estimado.
 *
 * Escanea cada transcript de forma incremental (recuerda hasta donde leyo) y guarda solo eventos
 * compactos: tus pedidos y cada respuesta de Claude con su uso de tokens. Las respuestas se
 * deduplican por id de mensaje (Claude Code escribe un registro por bloque con el mismo uso).
 *
 * El costo es el EQUIVALENTE a precios de la API (USD); con una suscripcion no es lo que se paga.
 */
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOME, collectSessions } from "./core.mjs";

// USD por millon de tokens. Fuente: skill claude-api (tabla cacheada 2026-11-03). Escritura de cache:
// 1,25x entrada (TTL 5 min) y 2x (TTL 1 h); lectura: indicada por modelo.
const PRICES = [
  [/fable-5-2|mythos-5-2/, { in: 8, out: 40, read: 0.2 }],
  [/fable-5-1|mythos-5-1/, { in: 10, out: 50, read: 0.25 }],
  [/fable-5|mythos-5/, { in: 10, out: 50, read: 1 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-5|opus-4-[5-9]/, { in: 5, out: 25, read: 0.5 }],
  [/opus-4|opus-3/, { in: 15, out: 75, read: 1.5 }],
  [/sonnet-5-5/, { in: 2, out: 10, read: 0.1 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3 }],
  [/haiku-5-5/, { in: 0.1, out: 0.5, read: 0.01 }],
  [/haiku/, { in: 1, out: 5, read: 0.1 }],
];
export function priceOf(model) {
  for (const [re, p] of PRICES) if (re.test(model ?? "")) return { ...p, known: true };
  return { in: 4, out: 20, read: 0.2, known: false }; // desconocido: se estima como Opus 5.5
}
export function costOf(model, u, speed) {
  const p = priceOf(model);
  const fast = speed === "fast" ? 2 : 1;
  return fast * ((u.in * p.in) + (u.out * p.out) + (u.cr * p.read) + (u.cw5 * p.in * 1.25) + (u.cw1 * p.in * 2)) / 1e6;
}

// ---------- Escaneo incremental ----------
const scans = new Map(); // archivo -> { offset, rest, prompts: [iso], msgs: Map(id -> evento) }
const RE_TS = /"timestamp":"([^"]+)"/;
const RE_MODEL = /"model":"([^"]+)"/;
const RE_MSGID = /"message":\{[^{}]*?"id":"(msg_[^"]+)"/;
const RE_SIDE = /"isSidechain":true/;

/** Objeto JSON que sigue a "clave": en la linea, contando llaves (el uso trae varios niveles anidados). */
function objectAfter(line, key) {
  const marker = '"' + key + '":{';
  const i = line.indexOf(marker);
  if (i < 0) return null;
  const from = i + marker.length - 1;
  let depth = 0;
  let inStr = false;
  for (let j = from; j < line.length; j++) {
    const c = line[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return line.slice(from, j + 1);
    }
  }
  return null;
}

function humanText(rec) {
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) return null;
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "";
  const clean = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, "").trim();
  if (!clean || /^<(task-notification|local-command|command-)/.test(clean) || clean.startsWith("[Request interrupted")) return null;
  return clean;
}

function handleLine(st, line) {
  if (line.length < 40) return;
  const isUser = line.includes('"type":"user"');
  const isAsst = !isUser && line.includes('"type":"assistant"');
  if (!isUser && !isAsst) return;
  if (isUser) {
    // Los resultados de herramientas pueden pesar megas: se descartan sin parsear.
    if (line.includes('"tool_use_id"') || RE_SIDE.test(line.slice(0, 200))) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (rec.isSidechain || rec.isMeta || !rec.timestamp || !humanText(rec)) return;
    st.prompts.push(rec.timestamp);
    return;
  }
  // Respuesta: solo metadatos (el texto y las entradas de herramientas pueden ser enormes).
  const head = line.slice(0, 1500);
  const id = RE_MSGID.exec(line)?.[1];
  const ts = RE_TS.exec(line)?.[1];
  if (!id || !ts) return;
  let u = null;
  const um = objectAfter(line, "usage");
  try { u = um ? JSON.parse(um) : null; } catch {}
  const usage = {
    in: u?.input_tokens ?? 0,
    out: u?.output_tokens ?? 0,
    cr: u?.cache_read_input_tokens ?? 0,
    cw5: u?.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u?.cache_creation_input_tokens ?? 0),
    cw1: u?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
  const prev = st.msgs.get(id);
  const ev = {
    t: prev?.t ?? ts, end: ts, model: RE_MODEL.exec(head)?.[1] ?? prev?.model ?? null,
    side: RE_SIDE.test(head), speed: u?.speed ?? prev?.speed ?? null, u: usage,
  };
  if (prev) for (const k of Object.keys(usage)) ev.u[k] = Math.max(prev.u[k], usage[k]);
  st.msgs.set(id, ev);
}

export function scanEvents(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  let st = scans.get(file);
  if (!st || size < st.offset) st = { offset: 0, rest: "", prompts: [], msgs: new Map() };
  if (size > st.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const CHUNK = 8 * 1048576;
      for (let pos = st.offset; pos < size; pos += CHUNK) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        const lines = (st.rest + buf.toString("utf8")).split("\n");
        st.rest = lines.pop() ?? "";            // linea incompleta: se completa en la proxima lectura
        if (st.rest.length > 64 * 1048576) st.rest = "";
        for (const l of lines) handleLine(st, l);
      }
    } finally { fs.closeSync(fd); }
    st.offset = size;
    scans.set(file, st);
  }
  return st;
}

// ---------- Dia ----------
const ms = (iso) => Date.parse(iso ?? 0) || 0;
const WORK_GAP = 10 * 60e3;       // respuestas separadas por menos de esto son un mismo tramo de trabajo
const TURN_MAX = 8 * 3600e3;       // un turno mas largo que esto es un dato raro (sesion reanudada) y se ignora
const MAX_WAIT = 12 * 3600e3;     // esperas mas largas (la noche) cuentan como inactividad

/** Linea de tiempo + tokens del dia `day` (YYYY-MM-DD, hora local). */
export function dayActivity(day) {
  const start = day ? new Date(`${day}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  const dayStart = start.getTime();
  const dayEnd = dayStart + 864e5;
  const now = Date.now();
  const hours = Math.max(24, Math.ceil((now - dayStart) / 3600e3) + 1);
  const { sessions } = collectSessions({ hours: Math.min(168, hours), includeArchived: true });

  const rows = [];
  for (const s of sessions) {
    const file = transcriptOf(s.session_id);
    if (!file) continue;
    const st = scanEvents(file);
    if (!st) continue;
    const msgs = [...st.msgs.values()];
    const main = msgs.filter((m) => !m.side).sort((a, b) => ms(a.t) - ms(b.t));
    const prompts = st.prompts.map(ms).sort((a, b) => a - b);

    // Trabajando: tramos de respuestas seguidas. Esperando: del fin de un tramo a tu siguiente pedido.
    const work = [];
    let cur = null;
    for (const m of main) {
      // Un mismo mensaje no dura mas de unos minutos: si su primer y ultimo registro estan muy separados es
      // una reescritura (sesion reanudada), y cuenta solo su primer registro.
      const t0 = ms(m.t);
      const t1 = ms(m.end) - t0 > 15 * 60e3 ? t0 : Math.max(ms(m.end), t0);
      if (cur && t0 - cur.b <= WORK_GAP) cur.b = Math.max(cur.b, t1);
      else { if (cur) work.push(cur); cur = { k: "trabajando", a: t0, b: t1 }; }
    }
    if (cur) work.push(cur);
    // Turnos: de tu pedido a la ultima respuesta antes del siguiente (cubre comandos largos sin mensajes).
    prompts.forEach((p, i) => {
      const next = prompts[i + 1] ?? Infinity;
      const last = main.filter((m) => ms(m.t) >= p && ms(m.t) < next).at(-1);
      const end = last ? ms(last.t) : null;
      if (end && end > p && end - p < TURN_MAX) work.push({ k: "trabajando", a: p, b: end });
    });
    // Unir tramos superpuestos.
    work.sort((x, y) => x.a - y.a);
    for (let i = 1; i < work.length; i++) {
      if (work[i].a <= work[i - 1].b + 1000) { work[i - 1].b = Math.max(work[i - 1].b, work[i].b); work.splice(i, 1); i--; }
    }
    // "Trabajando ahora" solo alarga el ultimo tramo si es reciente (un estado busy viejo no inventa horas).
    if (s.state === "trabajando" && work.length && now - work.at(-1).b < 30 * 60e3) work.at(-1).b = now;
    const waits = [];
    const waitingNow = ["esperando", "necesita_input", "en_pausa"].includes(s.state);
    work.forEach((w, i) => {
      const nextWork = work[i + 1];
      const nextPrompt = prompts.find((p) => p > w.b);
      let until = null;
      if (nextPrompt != null && (!nextWork || nextPrompt <= nextWork.a + WORK_GAP)) until = nextPrompt;
      else if (!nextWork && waitingNow) until = now;
      if (until != null && until > w.b && until - w.b <= MAX_WAIT) waits.push({ k: "esperando", a: w.b, b: until });
    });
    for (const w of work) if (w.b - w.a < 20e3) w.b = w.a + 20e3; // que se vea en la barra

    const clipped = [...work, ...waits]
      .map((x) => ({ ...x, a: Math.max(x.a, dayStart), b: Math.min(x.b, dayEnd, now) }))
      .filter((x) => x.b > x.a)
      .sort((x, y) => x.a - y.a);

    // Tokens del dia (incluye subagentes: tambien cuestan).
    const tok = { in: 0, out: 0, cr: 0, cw5: 0, cw1: 0 };
    let cost = 0;
    let unknownModel = false;
    const byModel = {};
    for (const m of msgs) {
      const t = ms(m.t);
      if (t < dayStart || t >= dayEnd) continue;
      for (const k of Object.keys(tok)) tok[k] += m.u[k];
      const c = costOf(m.model, m.u, m.speed);
      cost += c;
      if (!priceOf(m.model).known) unknownModel = true;
      const key = (m.model ?? "desconocido").replace("claude-", "");
      byModel[key] = (byModel[key] ?? 0) + c;
    }
    const sum = (k) => clipped.filter((x) => x.k === k).reduce((n, x) => n + (x.b - x.a), 0);
    const promptsToday = prompts.filter((p) => p >= dayStart && p < dayEnd).length;
    if (!clipped.length && !tok.in && !tok.out && !tok.cr && !promptsToday) continue;
    rows.push({
      session_id: s.session_id, title: s.title, repos: s.repos, workspace: s.workspace, state: s.state, open_url: s.open_url,
      segments: clipped.map((x) => ({ k: x.k, a: new Date(x.a).toISOString(), b: new Date(x.b).toISOString() })),
      working_ms: sum("trabajando"), waiting_ms: sum("esperando"), prompts: promptsToday,
      tokens: tok, cost_usd: Math.round(cost * 100) / 100, by_model: byModel, unknown_model: unknownModel,
    });
  }
  rows.sort((a, b) => (b.working_ms + b.waiting_ms) - (a.working_ms + a.waiting_ms));
  const total = { working_ms: 0, waiting_ms: 0, cost_usd: 0, prompts: 0, tokens: { in: 0, out: 0, cr: 0, cw5: 0, cw1: 0 } };
  for (const r of rows) {
    total.working_ms += r.working_ms; total.waiting_ms += r.waiting_ms; total.cost_usd += r.cost_usd; total.prompts += r.prompts;
    for (const k of Object.keys(r.tokens)) total.tokens[k] += r.tokens[k];
  }
  total.cost_usd = Math.round(total.cost_usd * 100) / 100;
  return { day: localDay(start), day_start: new Date(dayStart).toISOString(), now: new Date(now).toISOString(), sessions: rows, total };
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function transcriptOf(id) {
  const base = path.join(CLAUDE_HOME, "projects");
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, `${id}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}
