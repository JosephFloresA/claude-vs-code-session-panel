#!/usr/bin/env node
/**
 * Resumen del dia: en que se trabajo hoy con Claude, agrupado por repo, con PRs,
 * work items (AB#) y archivos editados. Sirve de base para un daily o un reporte.
 *
 *   node src/hoy.mjs          Markdown en la salida estandar
 *   GET  http://127.0.0.1:7820/api/hoy  lo mismo, desde el panel
 *
 * Los PR, AB# y archivos salen de la parte reciente de cada transcript (los ultimos
 * ~768 KB), no de la conversacion completa.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dailySummary } from "./core.mjs";

const STATE = {
  necesita_input: "🔴 te necesita",
  esperando: "🟡 tu turno",
  trabajando: "🔵 trabajando",
  en_pausa: "💤 en pausa",
  vacia: "⚪ sin uso",
  cerrada: "⚫ cerrada",
};

const esc = (s) => String(s ?? "").replace(/\n/g, " ");

export function dailyMarkdown() {
  const d = dailySummary();
  const out = [];
  out.push(`# Trabajo con Claude — ${d.date}`);
  out.push("");
  out.push(`${d.total} sesiones con actividad hoy, en ${d.groups.length} proyectos.`);
  for (const [repo, sessions] of d.groups.sort((a, b) => b[1].length - a[1].length)) {
    out.push("");
    out.push(`## ${repo}`);
    for (const s of sessions) {
      out.push(`- **[${esc(s.title)}](${s.open_url})** — ${STATE[s.state] ?? s.state}${s.note ? ` · _${esc(s.note)}_` : ""}`);
      const extras = [];
      if (s.prs.length) extras.push("PR " + s.prs.map((p) => `[${p.repo} !${p.id}](${p.url})`).join(", "));
      if (s.work_items.length) extras.push(s.work_items.map((w) => `[AB#${w.id}](${w.url})`).join(", "));
      if (s.edited_files.length) extras.push(`${s.edited_files.length} archivos editados`);
      if (extras.length) out.push(`  - ${extras.join(" · ")}`);
      if (s.last_prompt) out.push(`  - Último pedido: ${esc(s.last_prompt).slice(0, 160)}`);
    }
  }
  return out.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(dailyMarkdown());
}
