// Vista Proyectos — pestaña «Historial»: commits del repo git de flujos/ (quién cambió qué y cuándo), su diff y
// «Restaurar esta versión» para fichas e hilos. Se monta en su propio contenedor y carga en segundo plano.
import { esc, ago, toast } from "./ui.js";
import { icon } from "./icons.js";
import { api } from "./proyectos-dialogos.js";

const ACTOR = {
  panel: { label: "tú (panel)", cls: "trabajando", ico: "hand" },
  escriba: { label: "escribano", cls: "esperando", ico: "rotate" },
  chat: { label: "chat / editor", cls: "q", ico: "message" },
  sistema: { label: "sistema", cls: "cerrada", ico: "settings" },
};
const ACCION = {
  inicial: "estado inicial", crear_proyecto: "creó el proyecto", crear_hilo: "creó el hilo", editar_hilo: "editó el hilo",
  mover_hilo: "movió el hilo", sacar_hilo: "sacó el hilo", liberar_reserva: "liberó una reserva", resumen_escriba: "resumió en el hilo",
  edicion_externa: "editó fuera del panel", restaurar: "restauró una versión",
};

const cache = new Map();      // clave -> { items, at, error }
const diffs = new Map();      // hash|file -> texto
let sel = null;               // hash elegido

const key = (project, file) => `${project}|${file ?? ""}`;
async function fetchHist(project, file) {
  const q = new URLSearchParams(file ? { file } : { project });
  const r = await fetch(`/api/flujos/historial?${q}`, { cache: "no-store" }).then((x) => x.json()).catch((e) => ({ items: [], error: String(e) }));
  cache.set(key(project, file), { items: r.items ?? [], at: Date.now(), error: r.error ?? (r.on === false ? "El historial en git está apagado o aún no se inicia." : null) });
}
async function fetchDiff(hash, file) {
  const k = `${hash}|${file ?? ""}`;
  if (!diffs.has(k)) {
    const q = new URLSearchParams({ hash, ...(file ? { file } : {}) });
    const r = await fetch(`/api/flujos/historial/diff?${q}`, { cache: "no-store" }).then((x) => x.json()).catch(() => ({ ok: false }));
    diffs.set(k, r.ok ? r.text : `No se pudo leer el diff (${r.reason ?? "error"}).`);
  }
  return diffs.get(k);
}

const restorable = (f) => f.estado !== "D" && /^[\w.-]+\/(ficha\.md|hilos\/[\w.-]+\.md)$/.test(f.path);
const diffHtml = (t) => t.split("\n").map((l) => {
  const c = l.startsWith("+++") || l.startsWith("---") ? "h" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : l.startsWith("diff --git") ? "h" : "";
  return `<span class="${c}">${esc(l) || " "}</span>`;
}).join("\n");

function listHtml(h, file) {
  if (!h) return `<div class="muted">Cargando historial…</div>`;
  if (h.error && !h.items.length) return `<div class="muted">${esc(h.error)}</div>`;
  if (!h.items.length) return `<div class="muted">Sin cambios registrados${file ? " para este hilo" : ""}.</div>`;
  return h.items.map((c) => {
    const a = ACTOR[c.actor] ?? { label: c.actor, cls: "cerrada", ico: "note" };
    const que = ACCION[c.accion] ?? c.accion ?? c.asunto;
    const files = c.archivos.filter((f) => !f.path.startsWith(".") && !f.path.includes("/.escriba/"));
    return `<div class="pjh-item ${sel === c.hash ? "on" : ""}" data-hhash="${esc(c.hash)}">
      <div class="pjh-l1"><span class="pill ${a.cls}">${icon(a.ico, { size: 12 })}${esc(a.label)}</span>
        <b>${esc(que)}</b>${c.hilo ? ` <span class="mono">${esc(c.hilo)}</span>` : ""}
        <span class="spacer"></span><span class="muted small" title="${esc(c.fecha)}">${esc(ago(c.fecha))}</span><span class="mono muted small">${esc(c.hash)}</span></div>
      <div class="muted small pjh-asunto">${esc(c.asunto)}</div>
      ${sel === c.hash ? `<div class="pjh-files">${files.map((f) => `<span class="pjh-f"><span class="mono small">${esc(f.estado)} ${esc(f.de ? `${f.de} → ${f.path}` : f.path)}</span>
          ${restorable(f) ? `<button class="btn ghost" data-hrestore="${esc(f.path)}" data-hh="${esc(c.hash)}" title="Dejar este archivo como quedó en este cambio (se registra como un cambio nuevo)">${icon("rotate", { size: 12 })}Restaurar esta versión</button>` : ""}</span>`).join("")}</div>
        <pre class="pjh-diff" data-hdiff>Cargando diff…</pre>` : ""}
    </div>`;
  }).join("");
}

/**
 * Monta el historial en el contenedor. file = "proyecto/hilos/x.md" para filtrar por un hilo (lo sigue aunque
 * se haya movido), o null para todo el proyecto. onRestored se llama tras restaurar.
 */
export function mountHistorial(el, project, file, onRestored) {
  const k = key(project, file);
  const paint = async () => {
    const h = cache.get(k);
    el.innerHTML = `<div class="pjh-head">${icon("clock", { size: 13 })}<b>Historial</b> ${file ? `de <span class="mono">${esc(file.split("/").pop())}</span>` : "del proyecto"}
        <span class="muted small">· cada cambio a la ficha o a un hilo, con quién lo hizo</span><span class="spacer"></span>
        ${file ? `<button class="btn ghost" data-hall>Ver todo el proyecto</button>` : ""}
        <button class="btn ghost icon" data-hreload title="Recargar">${icon("rotate")}</button></div>
      <div class="pjh-list">${listHtml(h, file)}</div>`;
    const pre = el.querySelector("[data-hdiff]");
    if (pre && sel) { const t = await fetchDiff(sel, null); if (pre.isConnected) pre.innerHTML = diffHtml(t); }
  };
  el.onclick = async (e) => {
    const rs = e.target.closest("[data-hrestore]");
    if (rs) {
      e.stopPropagation();
      if (!window.confirm(`¿Restaurar ${rs.dataset.hrestore} a como quedó en ${rs.dataset.hh}?\n\nLa versión actual no se pierde: queda en el historial y el restaurar se registra como un cambio nuevo.`)) return;
      const r = await api("/api/flujos/restaurar", { hash: rs.dataset.hh, file: rs.dataset.hrestore });
      toast(r.ok ? `Restaurado ${rs.dataset.hrestore.split("/").pop()}` : `No se pudo restaurar (${r.reason ?? "error"})`, r.ok ? "check" : "alert");
      if (r.ok) { cache.clear(); setTimeout(async () => { await fetchHist(project, file); paint(); onRestored?.(); }, 800); }
      return;
    }
    if (e.target.closest("[data-hreload]")) { await fetchHist(project, file); paint(); return; }
    if (e.target.closest("[data-hall]")) { el.dispatchEvent(new CustomEvent("historial-todo", { bubbles: true })); return; }
    const it = e.target.closest("[data-hhash]");
    if (it && !e.target.closest(".pjh-files, .pjh-diff")) { sel = sel === it.dataset.hhash ? null : it.dataset.hhash; paint(); }
  };
  paint();
  const h = cache.get(k);
  if (!h || Date.now() - h.at > 15_000) fetchHist(project, file).then(() => { if (el.isConnected) paint(); });
}
