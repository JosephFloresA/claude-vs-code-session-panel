/**
 * «Terminar sesion»: cuando la persona da por terminada una conversacion, desde el panel:
 *   1. hilo   — el escribano resume en hilos/<hilo>.md todo lo que falte de la transcripcion (pasadas forzadas).
 *   2. ficha  — el escribano integra ese hilo en ficha.md (consolidarFicha: reservas intactas, sin perder hilos).
 *   3. cerrar — cierra la pestaña en VS Code (cerrar_pestana.ps1, UI Automation) y archiva la sesion en el panel.
 * Corre en el servidor (sigue aunque se recargue el panel). Si el paso 1 o 2 falla, NO se cierra nada.
 * Estado por sesion en memoria: GET /api/flujos/sesion/<id>/terminar.
 */
import { collectSessions, setSessionMeta } from "../core.mjs";
import { closeSession } from "../teclado.mjs";
import { listFlujos } from "./modelo.mjs";
import { asignaciones } from "./sugerir.mjs";
import { consolidarFicha, estadoSesion, forceSesion, refrescar } from "./escriba.mjs";

const jobs = new Map();          // sid -> estado
const HILO_MAX_MS = 8 * 60_000;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function resolver(sid) {
  const sessions = collectSessions({ hours: 168, includeArchived: true }).sessions;
  const s = sessions.find((x) => x.session_id === sid);
  if (!s) return { error: "not_found" };
  const flujos = listFlujos(sessions);
  const a = asignaciones(sessions, flujos)[sid];
  if (!a?.project) return { error: "sin_proyecto", s };
  if (!a.hilo) return { error: "sin_hilo", s, project: a.project };
  const p = flujos.projects.find((x) => x.slug === a.project);
  const h = p?.hilos.find((x) => x.name === a.hilo);
  if (!h?.file) return { error: "hilo_no_existe", s, project: a.project };
  return { s, project: a.project, hilo: a.hilo, hiloFile: h.file, live: !!s.pid && s.entrypoint === "claude-vscode" };
}

async function pasoHilo(job) {
  const t0 = Date.now();
  let pasadas = 0;
  while (Date.now() - t0 < HILO_MAX_MS) {
    await refrescar();                                   // relee el tamaño de la transcripcion
    const st = estadoSesion(job.sid);
    if (!st.on) throw new Error("el escribano está apagado (scribe.enabled = false)");
    if (st.conocida) {
      // Una pasada que forzamos termino en error (processOne deja status al final de cada pasada).
      if (st.status === "error" && !st.corriendo && !st.en_cola && pasadas > 0) throw new Error(st.error ?? "error del escribano");
      if (st.al_dia && !st.corriendo && !st.en_cola) { job.hilo_result = st.result; return; }
      if (!st.corriendo && !st.en_cola) { const f = forceSesion(job.sid); if (f.ok && !f.nada) pasadas++; }
      job.detalle = st.corriendo ? `resumiendo (${st.pendiente_kb} KB pendientes)` : `en cola (${st.pendiente_kb} KB pendientes)`;
    } else job.detalle = "esperando que el escribano registre la sesión";
    await sleep(3000);
  }
  throw new Error("el escribano tardó más de 8 min; no se cerró nada");
}

async function correr(job) {
  try {
    job.paso = "hilo"; await pasoHilo(job);
    job.paso = "ficha"; job.detalle = "actualizando la ficha";
    const f = await consolidarFicha(job.project, job.hiloFile, { sid: job.sid });
    job.ficha_result = f;
    if (!f.ok) throw new Error(`la ficha no se actualizó (${f.reason}${f.error ? `: ${f.error}` : ""}${f.falta ? `: ${f.falta.join(", ")}` : ""}); el hilo sí quedó guardado`);
    if (job.cerrar && job.live) {
      job.paso = "cerrar"; job.detalle = "cerrando la pestaña en VS Code";
      job.cerrar_result = await closeSession(job.sid);
    }
    if (job.cerrar) { try { setSessionMeta(job.sid, { archived: true }); job.archivada = true; } catch {} }
    job.paso = "listo"; job.detalle = null;
  } catch (e) {
    job.error = String(e?.message ?? e); job.paso = "error";
  } finally {
    job.fin = new Date().toISOString();
  }
}

/** Inicia (o devuelve el que ya corre) el cierre de una sesion. cerrar=false: solo guarda hilo y ficha. */
export function terminar(sid, { cerrar = true } = {}) {
  sid = String(sid ?? "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(sid)) return { ok: false, reason: "session_invalida" };
  const prev = jobs.get(sid);
  if (prev && !prev.fin) return { ok: true, ya: true, ...prev };
  const r = resolver(sid);
  if (r.error) return { ok: false, reason: r.error, project: r.project ?? null };
  const job = { sid, project: r.project, hilo: r.hilo, hiloFile: r.hiloFile, live: r.live, cerrar: !!cerrar,
    paso: "inicio", detalle: null, inicio: new Date().toISOString(), fin: null, error: null };
  jobs.set(sid, job);
  correr(job);
  return { ok: true, ...job };
}

export function estadoTerminar(sid) {
  const j = jobs.get(String(sid ?? "").toLowerCase());
  return j ? { ok: true, ...j } : { ok: false, reason: "sin_proceso" };
}
