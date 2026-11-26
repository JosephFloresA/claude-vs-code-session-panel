// Abrir enlaces de Claude Code (vscode://anthropic.claude-code/open?...) en VS Code.
//   Sin envio: el navegador entrega el enlace directo (lo mas rapido y es lo que espera enviar.ps1 para pestanas
//   existentes), salvo con una instancia aparte de VS Code (links_via_server): el sistema lo mandaria a la normal.
//   Con envio (chat nuevo con prompt): siempre por el servidor (POST /api/abrir), que abre y pulsa Enter.
import { toast } from "./ui.js";
import { CFG } from "./config.js";

const VIA_SERVER = !!CFG.links_via_server;

const TOKEN = document.querySelector('meta[name="monitor-token"]')?.content ?? "";
const L = CFG.vscode_label;

export async function openVs(url, okMsg = `Abierto en ${L}`, { send = false } = {}) {
  if (!String(url ?? "").startsWith("vscode://")) { location.href = url; return; }
  if (!VIA_SERVER && !send) { location.href = url; return; }
  try {
    toast(`Abriendo en ${L}…`, "external");
    const r = await fetch("/api/abrir", { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN },
      body: JSON.stringify({ url, send }) });
    const j = await r.json();
    if (j.ok && send && !j.sent) toast(`Quedó cargado pero no se envió (${j.send_reason ?? "sin foco"}): envíalo con Enter en ${L}.`, "alert");
    else if (j.ok) toast(`${okMsg}${j.started ? ` (se abrió ${L})` : ""}`, "external");
    else toast(`No se pudo abrir en ${L}: ${j.reason ?? j.error ?? r.status}`, "alert");
  } catch (e) { toast(`No se pudo abrir en ${L}: ${e.message}`, "alert"); }
}

// Con una instancia aparte de VS Code, cualquier <a href="vscode://..."> del panel pasa por openVs.
if (VIA_SERVER) document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="vscode:"]');
  if (!a || e.defaultPrevented) return;
  // Los chats de Proyectos se abren en el panel (lo maneja su vista); Ctrl/Shift+clic sigue yendo a VS Code.
  if (a.closest("[data-chatpanel]") && !a.closest("[data-vsonly]") && !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
  e.preventDefault();
  openVs(a.getAttribute("href"));
}, true);
