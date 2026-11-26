// Visor de archivos generados por las sesiones (.md, .html, imagenes, pdf, datos).
import { esc, ago, toast } from "./ui.js";
import { icon } from "./icons.js";
import { token } from "./token.js";
import { renderMarkdown as renderMd } from "./markdown.js";

export const TYPE_ICON = { markdown: "note", html: "grid", imagen: "sparkles", pdf: "file", office: "table", datos: "table", texto: "note" };
export const TYPE_LABEL = { markdown: "Markdown", html: "HTML", imagen: "Imagen", pdf: "PDF", office: "Office", datos: "Datos", texto: "Texto" };

/** URL del servidor para un archivo: /ver/C:/ruta/archivo.ext (cada segmento codificado). */
export const viewUrl = (p) => "/ver/" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
export const fmtSize = (n) => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- Markdown completo (tablas, citas, imagenes relativas): static/markdown.js ----------
export function renderMarkdown(src, baseDir) {
  return renderMd(src, { resolve: (u) => (u.startsWith("/") ? u : viewUrl(baseDir + "/" + u)) });
}

// ---------- Modal ----------
let state = { list: [], idx: 0 };

export function openViewer(asset, list = [asset]) {
  state = { list: list.filter((a) => a.servable || a.type === "office"), idx: 0 };
  state.idx = Math.max(0, state.list.findIndex((a) => a.path === asset.path));
  if (!state.list.length) state = { list: [asset], idx: 0 };
  let dlg = document.getElementById("viewer");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "viewer";
    dlg.className = "viewer";
    document.body.append(dlg);
    dlg.addEventListener("click", onClick);
    dlg.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input")) return;
      if (e.key === "ArrowRight" || e.key === "j") { step(1); e.preventDefault(); }
      if (e.key === "ArrowLeft" || e.key === "k") { step(-1); e.preventDefault(); }
    });
  }
  paint();
  if (!dlg.open) dlg.showModal();
}

function step(d) {
  if (state.list.length < 2) return;
  state.idx = (state.idx + d + state.list.length) % state.list.length;
  paint();
}

async function onClick(e) {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  const a = state.list[state.idx];
  const v = b.dataset.v;
  if (v === "close") document.getElementById("viewer").close();
  if (v === "prev") step(-1);
  if (v === "next") step(1);
  if (v === "folder") { await abrirCarpeta(a.path); return; }
  if (v === "copy") { await navigator.clipboard?.writeText(a.path); toast("Ruta copiada", "copy"); }
  if (v === "pick") { state.idx = Number(b.dataset.i); paint(); }
}

function paint() {
  const dlg = document.getElementById("viewer");
  const a = state.list[state.idx];
  const many = state.list.length > 1;
  dlg.innerHTML = `
    <div class="vh">
      <span class="vtype ${a.type}">${icon(TYPE_ICON[a.type] ?? "file", { size: 15 })}</span>
      <div class="vname"><b title="${esc(a.path)}">${esc(a.name)}</b><span class="mono muted">${esc(a.rel ?? a.path)}</span></div>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${a.op === "creado" ? "creado" : "editado"} hace ${ago(a.at)} · ${fmtSize(a.size)}</span>
      ${many ? `<button class="btn icon" data-v="prev" title="Anterior (←)">${icon("chevron", { size: 16, cls: "rot90" })}</button><span class="mono muted">${state.idx + 1}/${state.list.length}</span><button class="btn icon" data-v="next" title="Siguiente (→)">${icon("chevron", { size: 16, cls: "rot-90" })}</button>` : ""}
      <a class="btn" href="${esc(a.vscode_url)}" title="Abrir el archivo en VS Code">${icon("external")}VS Code</a>
      ${a.servable && a.type !== "office" ? `<a class="btn" href="${esc(viewUrl(a.path))}" target="_blank" title="Abrir en una pestaña">${icon("external")}Pestaña</a>` : ""}
      <button class="btn" data-v="folder" title="Abrir la carpeta en el Explorador, con el archivo seleccionado">${icon("file")}Carpeta</button>
      <button class="btn icon" data-v="copy" title="Copiar ruta">${icon("copy")}</button>
      <button class="btn ghost icon" data-v="close" title="Cerrar (Esc)">${icon("x")}</button>
    </div>
    <div class="vbody">
      ${many ? `<nav class="vside">${state.list.map((x, i) => `<button class="vitem ${i === state.idx ? "on" : ""}" data-v="pick" data-i="${i}" title="${esc(x.path)}">${icon(TYPE_ICON[x.type] ?? "file", { size: 14 })}<span>${esc(x.name)}</span></button>`).join("")}</nav>` : ""}
      <div class="vcontent" id="vcontent"><div style="padding:30px"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div></div>
    </div>`;
  previewInto(a, dlg.querySelector("#vcontent"));
}

export async function previewInto(a, el) {
  if (!a.exists) { el.innerHTML = `<div class="empty">${icon("alert", { size: 28 })}El archivo ya no existe en esa ruta.</div>`; return; }
  if (!a.servable) { el.innerHTML = `<div class="empty">${icon("file", { size: 28 })}Está fuera de tus carpetas de trabajo (workspaceRoots): ábrelo en VS Code.</div>`; return; }
  const url = viewUrl(a.path);
  const dir = a.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  switch (a.type) {
    case "html":
      // Origen opaco: el HTML generado corre aislado del panel.
      el.innerHTML = `<iframe class="vframe" sandbox="allow-scripts allow-popups allow-forms allow-modals" src="${esc(url)}" title="${esc(a.name)}"></iframe>`;
      break;
    case "pdf":
      el.innerHTML = `<iframe class="vframe" src="${esc(url)}" title="${esc(a.name)}"></iframe>`;
      break;
    case "imagen":
      el.innerHTML = `<div class="vimg"><img src="${esc(url)}" alt="${esc(a.name)}"></div>`;
      break;
    case "office":
      el.innerHTML = `<div class="empty">${icon("table", { size: 28 })}Los archivos de Office no se previsualizan aquí.<span><button class="btn primary" data-v="folder">${icon("file")}Abrir carpeta</button> <a class="btn" href="${esc(a.vscode_url)}">${icon("external")}VS Code</a></span></div>`;
      break;
    default: {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(await res.text());
        const text = await res.text();
        if (!el.isConnected) return;
        if (a.type === "markdown") el.innerHTML = `<article class="prose">${renderMarkdown(text, dir)}</article>`;
        else el.innerHTML = `<pre class="vraw">${esc(text.length > 400000 ? text.slice(0, 400000) + "\n…(recortado)" : text)}</pre>`;
      } catch (e) {
        el.innerHTML = `<div class="empty">${icon("alert", { size: 28 })}${esc(String(e.message ?? e))}</div>`;
      }
    }
  }
}

/** Lista compacta de archivos para el detalle de una sesion. */
export function assetList(assets) {
  return `<ul class="assets">${assets.map((a, i) => `<li>
    <button class="asset ${a.servable ? "" : "off"}" data-asset="${i}" title="${esc(a.path)}">
      <span class="vtype ${a.type}">${icon(TYPE_ICON[a.type] ?? "file", { size: 14 })}</span>
      <span class="aname">${esc(a.name)}<small class="mono">${esc((a.rel ?? "").split("/").slice(0, -1).join("/"))}</small></span>
      <span class="aop ${a.op}">${a.op}</span>
      <span class="muted mono" style="font-size:11px">${ago(a.at)}</span>
    </button>
    <a class="btn ghost icon" href="${esc(a.vscode_url)}" title="Abrir en VS Code">${icon("external", { size: 14 })}</a>
  </li>`).join("")}</ul>`;
}

/** Explorador de Windows en la carpeta del archivo, con el archivo seleccionado (no lo ejecuta). */
export async function abrirCarpeta(p) {
  try {
    const j = await (await fetch("/api/revelar", { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": token() }, body: JSON.stringify({ path: p }) })).json();
    toast(j.ok ? `Carpeta abierta: ${j.dir}` : `No se pudo abrir la carpeta (${j.reason ?? j.error})`, j.ok ? "external" : "alert");
  } catch (e) { toast(`No se pudo abrir la carpeta: ${e.message}`, "alert"); }
}
