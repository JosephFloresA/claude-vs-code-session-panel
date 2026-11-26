#!/usr/bin/env node
/**
 * Resumen de sesiones de Claude Code en la terminal o en Markdown.
 *
 *   node src/cli.mjs                 tabla legible (sesiones vivas + cerradas en 12 h)
 *   node src/cli.mjs --md            Markdown (lo usa el comando /sesiones)
 *   node src/cli.mjs --json          JSON crudo
 *   node src/cli.mjs --hours 48      amplia la ventana de sesiones cerradas
 *   node src/cli.mjs --vivas         solo sesiones con proceso vivo
 *   node src/cli.mjs --activas       solo las que importan ahora (sin pausadas, vacias ni cerradas)
 *   node src/cli.mjs --excluir <id>  marca esa sesion como "(esta sesion)"
 *   node src/cli.mjs --hoy           resumen del dia por proyecto (PRs, AB#, archivos)
 */
import { collectSessions, ago, clip } from "./core.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};
const hours = Number(val("--hours")) || 12;
const exclude = val("--excluir") ?? process.env.CLAUDE_SESSION_ID ?? null;

if (flag("--hoy")) {
  const { dailyMarkdown } = await import("./hoy.mjs");
  process.stdout.write(dailyMarkdown());
  process.exit(0);
}

const data = collectSessions({ hours });
let rows = data.sessions;
if (flag("--vivas")) rows = rows.filter((r) => r.state !== "cerrada");
if (flag("--activas")) rows = rows.filter((r) => !["cerrada", "vacia", "en_pausa"].includes(r.state));

const ICON = {
  necesita_input: "🔴 necesita tu input",
  esperando: "🟡 esperando tu respuesta",
  trabajando: "🔵 trabajando",
  en_pausa: "💤 en pausa",
  vacia: "⚪ abierta sin uso",
  cerrada: "⚫ cerrada",
};

if (flag("--json")) {
  process.stdout.write(JSON.stringify({ ...data, sessions: rows }, null, 2) + "\n");
  process.exit(0);
}

const counts = rows.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
const resumen = Object.entries(ICON)
  .filter(([k]) => counts[k])
  .map(([k, v]) => `${counts[k]} ${v.split(" ").slice(1).join(" ")}`)
  .join(" · ");

const proyecto = (r) => (r.repos.length ? r.repos.join(", ") : r.workspace ?? "—");
const yo = (r) => (exclude && r.session_id.startsWith(exclude) ? " (esta sesión)" : "");
const q = (r) => (r.unseen ? " 🔵 sin ver" : "") + (r.asks_question ? " ❓" : "");
const unseenCount = rows.filter((r) => r.unseen).length;
const tick = "`";

if (flag("--md")) {
  const out = [];
  out.push(`**${rows.length} sesiones** — ${resumen || "ninguna"}${unseenCount ? ` · **${unseenCount} terminaron y no las has visto**` : ""}  `);
  out.push(`_Generado ${new Date(data.generated_at).toLocaleString("es-CL")}. ❓ = terminó con una pregunta para ti. El título abre la conversación en VS Code._`);
  out.push("");
  out.push("| Estado | Tema | Proyecto | Último pedido | Actividad |");
  out.push("|---|---|---|---|---|");
  for (const r of rows) {
    const extra = r.state === "trabajando" && r.turn_started_at ? ` (turno ${ago(r.turn_started_at)})` : "";
    out.push(`| ${ICON[r.state]}${extra}${q(r)} | **[${esc(r.title)}](${r.open_url})**${yo(r)} ${tick}${r.short_id}${tick} | ${esc(proyecto(r))} | ${esc(clip(r.last_prompt, 110) ?? "—")} | hace ${ago(r.last_activity)} |`);
  }
  const urgentes = rows.filter((r) => r.state === "necesita_input" || r.state === "esperando" || r.unseen)
    .sort((a, b) => Number(b.state === "necesita_input") - Number(a.state === "necesita_input") || Number(b.unseen) - Number(a.unseen));
  if (urgentes.length) {
    out.push("");
    out.push("### Pendientes de ti");
    for (const r of urgentes) {
      const tag = r.state === "necesita_input" ? "🔴" : r.unseen ? "🔵 sin ver" : r.asks_question ? "❓" : "🟡";
      out.push(`- ${tag} **[${esc(r.title)}](${r.open_url})** ${tick}${r.short_id}${tick}: ${esc(r.needs_input_detail ?? clip(r.last_response, 220) ?? "—")}`);
    }
  }
  const conflicted = rows.filter((r) => r.conflicts.length && r.state !== "cerrada");
  if (conflicted.length) {
    out.push("");
    out.push("### ⚠ Sesiones que editaron los mismos archivos");
    for (const r of conflicted) {
      for (const c of r.conflicts) out.push(`- **${esc(r.title)}** y ${c.with.map((w) => `**${esc(w.title)}**`).join(", ")}: ${tick}${c.file}${tick}`);
    }
  }
  const llenas = rows.filter((r) => r.state !== "cerrada" && (r.context_pct ?? 0) >= 85);
  if (llenas.length) {
    out.push("");
    out.push(`_Contexto casi lleno (≥85 %, pronto se compacta): ${llenas.map((r) => `${esc(r.title)} ${r.context_pct} %`).join(" · ")}_`);
  }
  if (data.archived_count) out.push(`\n_${data.archived_count} archivadas ocultas._`);
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}

console.log(`${rows.length} sesiones — ${resumen || "ninguna"}\n`);
for (const r of rows) {
  console.log(`${ICON[r.state]}${q(r)}  ${r.title}${yo(r)}  [${r.short_id}]`);
  console.log(`   proyecto: ${proyecto(r)}   actividad: hace ${ago(r.last_activity)}${r.pid ? `   pid ${r.pid}` : ""}`);
  if (r.last_prompt) console.log(`   tú:      ${clip(r.last_prompt, 140)}`);
  const resp = r.needs_input_detail ?? r.last_response;
  if (resp) console.log(`   claude:  ${clip(resp, 140)}`);
  console.log(`   abrir:   ${r.open_url}`);
  console.log("");
}

function esc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
