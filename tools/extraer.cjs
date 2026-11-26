// Vuelca una transcripcion .jsonl a texto compacto para armar pseudoproyectos (ver BRIEF_MIGRACION.md).
// Uso: node extraer.cjs <id-sesion-8-o-completo> [salida.txt]   (crea la carpeta de salida si falta)
// Busca la sesion en CLAUDE_CONFIG_DIR (o ~/.claude) y en las carpetas extra de PANEL_EXTRA_CLAUDE_HOMES (separadas por ; o :).
// Incluye: mensajes del usuario, texto de Claude, herramientas en una linea y errores. Omite subagentes y meta.
const fs = require("fs"), path = require("path"), os = require("os");
const [id, outArg] = process.argv.slice(2);
if (!id) { console.error("uso: node extraer.cjs <id> [salida.txt]"); process.exit(1); }
const homes = [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ...(process.env.PANEL_EXTRA_CLAUDE_HOMES || "").split(path.delimiter).filter(Boolean)];
const roots = homes.map((h) => path.join(h, "projects"));
if (outArg) fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
let file = null;
for (const r of roots) {
  let dirs = []; try { dirs = fs.readdirSync(r); } catch { continue; }
  for (const d of dirs) {
    let fs2 = []; try { fs2 = fs.readdirSync(path.join(r, d)); } catch { continue; }
    const f = fs2.find((x) => x.startsWith(id) && x.endsWith(".jsonl"));
    if (f) { file = path.join(r, d, f); break; }
  }
  if (file) break;
}
if (!file) { console.error("no encontrada: " + id); process.exit(2); }
const strip = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<(ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, "").trim();
const out = [`# ${file}`];
for (const l of fs.readFileSync(file, "utf8").split("\n")) {
  if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.isSidechain || j.isMeta) continue;
  const ts = (j.timestamp ?? "").slice(0, 16).replace("T", " ");
  if (j.type === "summary" && j.summary) { out.push(`\n[RESUMEN COMPACTADO] ${j.summary}`); continue; }
  const c = j.message?.content;
  if (j.type === "user") {
    if (typeof c === "string") { const t = strip(c); if (t) out.push(`\n## ${ts} USUARIO\n${t}`); continue; }
    for (const b of c ?? []) {
      if (b.type === "text") { const t = strip(b.text); if (t) out.push(`\n## ${ts} USUARIO\n${t}`); }
      else if (b.type === "tool_result" && b.is_error) { const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content); out.push(`  [error herramienta] ${t.slice(0, 300)}`); }
    }
  } else if (j.type === "assistant") {
    for (const b of c ?? []) {
      if (b.type === "text" && b.text.trim()) out.push(`\n## ${ts} CLAUDE\n${b.text.trim()}`);
      else if (b.type === "tool_use") {
        const i = b.input ?? {};
        const what = i.command ?? i.file_path ?? i.pattern ?? i.description ?? i.prompt ?? JSON.stringify(i);
        out.push(`  [${b.name}] ${String(what).replace(/\s+/g, " ").slice(0, 220)}`);
      }
    }
  }
}
const text = out.join("\n");
if (outArg) { fs.writeFileSync(outArg, text, "utf8"); console.log(`${outArg} (${(text.length / 1024).toFixed(0)} KB)`); }
else process.stdout.write(text);
