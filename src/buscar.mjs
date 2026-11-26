/**
 * Busqueda de texto en todas las conversaciones (transcripts completos, no solo la cola).
 *
 * Busca en tus pedidos y en las respuestas de Claude (no en salidas de herramientas). Todas las
 * palabras deben aparecer en el mismo mensaje, sin importar mayusculas ni tildes.
 */
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOME, summarizeTranscript, openUrl } from "./core.mjs";

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Regex tolerante a tildes: "umbral" tambien encuentra "úmbral"; "accion" encuentra "acción".
const ACCENTS = { a: "[aáàä]", e: "[eéèë]", i: "[iíìï]", o: "[oóòö]", u: "[uúùü]", n: "[nñ]" };
const termRe = (t) => new RegExp(escRe(t).replace(/[aeioun]/g, (c) => ACCENTS[c]), "i");

function textOf(rec) {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  if (rec.type === "user" && c.some((x) => x?.type === "tool_result")) return "";
  return c.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
}
const cleanUser = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, "").replace(/<\/?pasted_content[^>]*>/g, "").trim();

function snippet(text, re) {
  const one = text.replace(/\s+/g, " ");
  const m = re.exec(one);
  const at = m ? m.index : 0;
  const from = Math.max(0, at - 110);
  return (from > 0 ? "…" : "") + one.slice(from, at + 190) + (at + 190 < one.length ? "…" : "");
}

export function searchTranscripts(q, { days = 14, limit = 80, perSession = 6 } = {}) {
  const terms = fold(String(q ?? "")).split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  if (!terms.length) return { q, terms, results: [], scanned: 0 };
  const res = terms.map(termRe);
  const since = Date.now() - days * 864e5;
  const base = path.join(CLAUDE_HOME, "projects");
  const files = [];
  for (const d of fs.readdirSync(base)) {
    if (/AppData-Local-Temp|scratch/i.test(d)) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(base, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = path.join(base, d, n);
      try { const st = fs.statSync(p); if (st.mtimeMs >= since) files.push({ p, mtime: st.mtimeMs }); } catch {}
    }
  }
  const started = Date.now();
  const results = [];
  for (const f of files.sort((a, b) => b.mtime - a.mtime)) {
    let raw;
    try { raw = fs.readFileSync(f.p, "utf8"); } catch { continue; }
    if (!res.every((re) => re.test(raw))) continue;          // descarte rapido del archivo completo
    const sessionId = path.basename(f.p, ".jsonl");
    const hits = [];
    for (const line of raw.split("\n")) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      if (!res.every((re) => re.test(line))) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.isSidechain || (rec.type !== "user" && rec.type !== "assistant")) continue;
      let text = textOf(rec);
      if (rec.type === "user") text = cleanUser(text);
      if (!text || !res.every((re) => re.test(text))) continue;
      hits.push({ role: rec.type === "user" ? "tú" : "claude", at: rec.timestamp ?? null, snippet: snippet(text, res[0]) });
    }
    if (!hits.length) continue;
    const tr = summarizeTranscript(f.p);
    hits.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
    results.push({
      session_id: sessionId, title: tr?.title ?? tr?.first_prompt?.slice(0, 70) ?? sessionId.slice(0, 8),
      repos: tr?.repos ?? [], last_activity: tr?.last_activity ?? null, open_url: openUrl(sessionId),
      total: hits.length, hits: hits.slice(0, perSession),
    });
    if (results.reduce((n, r) => n + r.hits.length, 0) >= limit || Date.now() - started > 8000) break;
  }
  return { q, terms, days, scanned: files.length, ms: Date.now() - started, results };
}
