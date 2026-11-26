// Busqueda en todas las conversaciones (Enter en el buscador).
import { esc, fmtTime } from "./ui.js";
import { icon } from "./icons.js";
import { projectColor } from "./store.js";

let last = { q: "", days: 14 };
let onPick = null; // (session_id) => boolean: true si la sesion esta en el panel y se mostro ahi

export function initSearch(pick) { onPick = pick; }

export async function openSearch(q) {
  let dlg = document.getElementById("dlg-buscar");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-buscar";
    dlg.className = "buscar";
    document.body.append(dlg);
    dlg.addEventListener("submit", (e) => { e.preventDefault(); run(dlg.querySelector("[data-sq]").value, Number(dlg.querySelector("[data-sd]").value)); });
    dlg.addEventListener("click", (e) => {
      if (e.target.closest("[data-sclose]")) dlg.close();
      const pick = e.target.closest("[data-spick]");
      if (pick && onPick?.(pick.dataset.spick)) { e.preventDefault(); dlg.close(); }
    });
  }
  dlg.innerHTML = `<form class="dh sform">${icon("search")}<input class="input" data-sq value="${esc(q)}" placeholder="Buscar en todas las conversaciones…" autofocus>
      <select class="input" data-sd>${[[3, "3 días"], [7, "7 días"], [14, "14 días"], [30, "30 días"], [90, "90 días"]].map(([v, l]) => `<option value="${v}" ${v === last.days ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn primary" type="submit">Buscar</button><button class="btn ghost icon" type="button" data-sclose aria-label="Cerrar">${icon("x")}</button></form>
    <div class="sres" data-sres></div>`;
  if (!dlg.open) dlg.showModal();
  if (q.trim().length >= 2) run(q, last.days);
}

function highlight(text, terms) {
  let h = esc(text);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[aeiou]/g, (c) => ({ a: "[aáàä]", e: "[eéèë]", i: "[iíìï]", o: "[oóòö]", u: "[uúùü]" })[c])})`, "gi");
    h = h.replace(re, "<mark>$1</mark>");
  }
  return h;
}

async function run(q, days) {
  last = { q, days };
  const box = document.querySelector("#dlg-buscar [data-sres]");
  if (!q.trim() || q.trim().length < 2) { box.innerHTML = `<div class="empty">Escribe al menos 2 letras.</div>`; return; }
  box.innerHTML = `<div style="padding:24px"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div><div class="muted">Revisando las conversaciones de los últimos ${days} días…</div></div>`;
  let r;
  try { r = await (await fetch(`/api/buscar?q=${encodeURIComponent(q)}&dias=${days}`, { cache: "no-store" })).json(); }
  catch { box.innerHTML = `<div class="empty">No se pudo buscar.</div>`; return; }
  if (!r.results.length) { box.innerHTML = `<div class="empty">${icon("search", { size: 30 })}Nada con «${esc(q)}» en ${r.scanned} conversaciones de los últimos ${days} días.</div>`; return; }
  box.innerHTML = `<div class="smeta muted">${r.results.length} conversaciones · ${r.scanned} revisadas en ${(r.ms / 1000).toFixed(1)} s · todas las palabras en el mismo mensaje, sin importar tildes</div>` +
    r.results.map((s) => `<div class="sgroup">
      <div class="shead"><span class="proj" style="--c:${projectColor(s.repos?.[0])}"><i></i></span><b>${esc(s.title)}</b>
        <span class="muted">${s.total} coincidencia${s.total === 1 ? "" : "s"} · ${fmtTime(s.last_activity)}</span><span class="spacer"></span>
        <a class="btn" href="${esc(s.open_url)}" data-spick="${esc(s.session_id)}" title="Mostrarla en el panel si está abierta; si no, abrirla en VS Code">${icon("external")}Abrir</a></div>
      ${s.hits.map((h) => `<div class="shit"><span class="srole ${h.role === "tú" ? "me" : ""}">${esc(h.role)}</span><span class="muted mono">${fmtTime(h.at)}</span><div>${highlight(h.snippet, r.terms)}</div></div>`).join("")}
    </div>`).join("");
}
