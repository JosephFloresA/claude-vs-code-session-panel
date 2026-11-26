/**
 * Titulo, tipo y estado de los work items (historias de usuario) vinculados a los proyectos. SOLO LECTURA.
 *
 * Integracion opcional (config.azureDevOps.org). Usa el CLI az (la sesion de `az login`, sin PAT propio) y guarda
 * lo leido en <proyectos>/.ado.json (fuera de git). El panel responde siempre desde la cache; lo vencido (mas de
 * TTL) se refresca en segundo plano, de a uno, para no lanzar decenas de procesos az.
 */
import fs from "node:fs";
import path from "node:path";
import { ADO_ORG, FLUJOS_DIR } from "../config.mjs";
import { azJson } from "../integrations/cli.mjs";

export { ADO_ORG };
const CACHE = path.join(FLUJOS_DIR, ".ado.json");
const TTL_MS = 6 * 3600 * 1000;
const ERR_RETRY_MS = 10 * 60 * 1000;

let cache = null;
const cola = new Set();
let corriendo = false;
let lector = null;   // inyectable en pruebas: async (id) => { type, title, state, assigned }

export const urlDe = (id) => (ADO_ORG ? `${ADO_ORG}/_workitems/edit/${id}` : null);

function cargar() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { cache = {}; }
  return cache;
}
function guardar() {
  try { fs.writeFileSync(`${CACHE}.tmp`, JSON.stringify(cache, null, 1), "utf8"); fs.renameSync(`${CACHE}.tmp`, CACHE); } catch {}
}

/** Cambia el lector de ADO (pruebas). */
export function setLector(fn) { lector = fn; cache = {}; }

async function leerAdo(id) {
  if (lector) return lector(id);
  if (!ADO_ORG) throw new Error("Azure DevOps no está configurado (azureDevOps.org en config.json)");
  const f = (await azJson(["boards", "work-item", "show", "--id", String(Number(id)), "--org", ADO_ORG]))?.fields ?? {};
  return {
    type: f["System.WorkItemType"] ?? null,
    title: f["System.Title"] ?? null,
    state: f["System.State"] ?? null,
    assigned: f["System.AssignedTo"]?.displayName ?? null,
  };
}

/** Lee un work item ahora (al vincularlo) y actualiza la cache. Nunca lanza: devuelve { error } si falla. */
export async function consultar(id) {
  cargar();
  try {
    const info = { id, ...(await leerAdo(id)), url: urlDe(id), at: new Date().toISOString() };
    cache[id] = info;
    guardar();
    return info;
  } catch (e) {
    const prev = cache[id] ?? { id, url: urlDe(id) };
    cache[id] = { ...prev, error: String(e.message ?? e).slice(0, 300), error_at: new Date().toISOString() };
    guardar();
    return cache[id];
  }
}

const vencido = (x) => {
  if (!x) return true;
  if (x.error_at && !x.at) return Date.now() - Date.parse(x.error_at) > ERR_RETRY_MS;
  return Date.now() - Date.parse(x.at ?? 0) > TTL_MS;
};

async function bombear() {
  if (corriendo) return;
  corriendo = true;
  try {
    while (cola.size) {
      const id = cola.values().next().value;
      cola.delete(id);
      await consultar(id);
    }
  } finally { corriendo = false; }
}

/** Info conocida de cada id (desde la cache) y encola el refresco de lo vencido. */
export function infoDe(ids) {
  cargar();
  const out = ids.map((id) => cache[id] ?? { id, url: urlDe(id) });
  if (!ADO_ORG && !lector) return out;   // integracion apagada: nada que refrescar
  for (const id of ids) if (vencido(cache[id])) cola.add(id);
  if (cola.size) bombear();
  return out;
}
