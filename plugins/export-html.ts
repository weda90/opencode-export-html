import { type Plugin, tool } from "@opencode-ai/plugin"
import * as path from "node:path"
import { promises as fs } from "node:fs"

/* ============================================================================
 * export_html — export the current opencode conversation to a single, portable,
 * offline-friendly HTML file (all CSS/JS/theme inline, local images embedded).
 *
 * Sections:
 *   1. types
 *   2. helpers (slugify, time, escape, entities, model parse, file io)
 *   3. redaction (ON by default)
 *   4. markdown -> sanitized HTML -> highlight pass
 *   5. session loading + normalization
 *   6. renderer + HTML template (CSS/JS inline)
 *   7. tool registration
 *   8. plugin export
 * ==========================================================================*/

/* ------------------------------- 1. types ------------------------------- */

export type ExportOptions = {
  output?: string
  theme?: "auto" | "light" | "dark"
  includeReasoning?: boolean
  includeFiles?: boolean
  redact?: boolean
  title?: string
}

type SessionMeta = {
  id: string
  title: string
  model: { id: string; providerID: string; variant?: string } | null
  agent?: string
  directory: string
  created: number
  updated: number
  tokens: { input: number; output: number; reasoning: number }
  cost: number
}

type FileRender = { kind: "file"; mime?: string; filename?: string; dataUri?: string; url?: string }

type ToolRender = {
  kind: "tool"
  tool: string
  title?: string
  status: string
  input: string
  output?: string
  error?: string
  start?: number
  end?: number
  attachments: FileRender[]
  diff?: string
  filePath?: string
  content?: string
}

type ItemRender =
  | { kind: "text"; role: string; html: string }
  | { kind: "reasoning"; html: string }
  | ToolRender
  | { kind: "file"; mime?: string; filename?: string; dataUri?: string; url?: string }
  | { kind: "annotation"; text: string }

type RenderMessage = {
  role: string
  providerID?: string
  modelID?: string
  created: number
  completed?: number
  finish?: string
  error?: string
  items: ItemRender[]
}

export type Conversation = {
  meta: SessionMeta
  messages: RenderMessage[]
  stats: { messages: number; tools: number; errors: number; reasoning: number; redactions: number }
}

/* ----------------------------- 2. helpers ------------------------------- */

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return slug || "session"
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function localTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

function formatDur(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatTokens(n?: number): string {
  return n && Number.isFinite(n) && n > 0 ? n.toLocaleString("en-US") : "0"
}

function formatCost(c?: number): string {
  if (!c || !isFinite(c) || c <= 0) return "—"
  return `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
}

function entityDecode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const code = parseInt(ent.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    if (ent.startsWith("#")) {
      const code = parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m
  })
}

function parseModel(raw: unknown): SessionMeta["model"] {
  if (!raw) return null
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as SessionMeta["model"]
    } catch {
      return null
    }
  }
  if (typeof raw === "object") {
    const o = raw as { id?: unknown; providerID?: unknown; variant?: unknown }
    if (!o.id || !o.providerID) return null
    return { id: String(o.id), providerID: String(o.providerID), variant: o.variant ? String(o.variant) : undefined }
  }
  return null
}

/** Call a client.session method, adapting to both the v1 (options+path) and v2 (parameters, options) SDK shapes. */
export async function sessionFetch<T>(client: any, name: "get" | "messages", sessionID: string): Promise<T> {
  const fn: any = client.session?.[name]
  if (typeof fn !== "function") throw new Error(`client.session.${name} is not a function`)
  let res: any
  if (fn.length >= 2) {
    res = await fn.call(client.session, { sessionID }, { throwOnError: true })
  } else {
    res = await fn.call(client.session, { id: sessionID, path: { id: sessionID }, throwOnError: true })
  }
  if (res && typeof res === "object" && "data" in res) return res.data as T
  return res as T
}

/* ------------------------------ 3. redaction ----------------------------- */

type RedactRule = { re: RegExp; label: string; toolOnly?: boolean }

const REDACT_RULES: RedactRule[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, label: "private key" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: "api key" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g, label: "bearer token" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws access key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "gcp api key" },
  { re: /\{env:[^}]+\}|\{file:[^}]+\}/g, label: "secret reference" },
  {
    re: /\b(api[_-]?key|token|secret|password|passwd|auth[_-]?token|access[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})/gi,
    label: "credential",
  },
  { re: /\b(?:0x)?[0-9a-f]{40,}\b/g, label: "long string", toolOnly: true },
  { re: /\b[A-Za-z0-9+/=]{44,}\b/g, label: "long string", toolOnly: true },
]

export function applyRedaction(text: string, scope: "all" | "tool"): { text: string; count: number } {
  let count = 0
  let out = typeof text === "string" ? text : text == null ? "" : String(text)
  for (const rule of REDACT_RULES) {
    if (rule.toolOnly && scope === "all") continue
    out = out.replace(rule.re, () => {
      count++
      return `[REDACTED: ${rule.label}]`
    })
  }
  return { text: out, count }
}

/* ---------------------- 4. markdown -> sanitized HTML -------------------- */

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code",
    "strong", "em", "del", "a", "img", "hr",
    "table", "thead", "tbody", "tr", "th", "td", "input",
  ],
  allowedAttributes: {
    a: ["href", "title", "name"],
    img: ["src", "alt", "title"],
    code: ["class"],
    pre: ["class"],
    th: ["align"],
    td: ["align"],
    input: ["type", "checked", "disabled"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["data", "http", "https"] },
  disallowedTagsMode: "discard",
} as const

export async function markdownToHtml(text: string): Promise<string> {
  const mod = await import("marked")
  const api = (mod.default ?? mod.marked) as any
  if (!api || typeof api.parse !== "function") throw new Error("marked: no parse export")
  const raw = api.parse(text, { gfm: true, breaks: false })
  const html = typeof raw === "string" ? raw : await raw
  const { default: sanitizeHtml } = await import("sanitize-html")
  const clean = sanitizeHtml(html, SANITIZE_OPTIONS as any)
  return highlightFencedHtml(clean)
}

async function highlightFencedHtml(html: string): Promise<string> {
  const mod = await import("highlight.js")
  const h = (mod.default ?? mod) as any
  const run = (code: string, lang?: string): string => {
    try {
      if (lang) return h.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true }).value as string
      return h.highlightAuto(code).value as string
    } catch {
      try {
        return h.highlightAuto(code).value as string
      } catch {
        return escapeHtml(code)
      }
    }
  }
  let out = html.replace(/(<pre><code class="language-)([^"]+)(">)([\s\S]*?)(<\/code><\/pre>)/g, (_m, open, lang, mid, inner, close) => {
    return `${open}${lang} hljs${mid}${run(entityDecode(inner), lang)}${close}`
  })
  out = out.replace(/(<pre><code>)([\s\S]*?)(<\/code><\/pre>)/g, (_m, open, inner, close) => {
    return `${open}${run(entityDecode(inner))}${close}`
  })
  return out
}

/** Highlight arbitrary tool output (plain text, never markdown). */
async function highlightPlainAsync(text: string): Promise<string> {
  if (text.length > 200_000) return escapeHtml(text)
  try {
    const mod = await import("highlight.js")
    const h = (mod.default ?? mod) as any
    const r = h.highlightAuto(text)
    return (r.value as string) || escapeHtml(text)
  } catch {
    return escapeHtml(text)
  }
}

/* --------------------- 5. session loading + normalization ---------------- */

function rawText(value: unknown): string {
  return String(value ?? "")
}

const EXPORT_PROMPT_MARKERS = ["offline-portable HTML report", "`export_html`"]

/** True when a user text part is our own /export-html slash-command prompt. */
export function isExportHtmlPrompt(text: string, role?: string): boolean {
  if (role === "assistant") return false
  return EXPORT_PROMPT_MARKERS.every((m) => text.includes(m))
}

export async function loadConversation(
  session: any,
  messages: Array<{ info?: any; parts?: any[] }>,
  opts: ExportOptions,
  abort?: AbortSignal,
): Promise<Conversation> {
  const meta: SessionMeta = {
    id: session.id,
    title: opts.title && opts.title.trim() ? opts.title : session.title || "Untitled session",
    model: parseModel(session.model),
    agent: session.agent || undefined,
    directory: session.directory || "",
    created: session.time?.created ?? Date.now(),
    updated: session.time?.updated ?? Date.now(),
    tokens: {
      input: session.tokens?.input ?? 0,
      output: session.tokens?.output ?? 0,
      reasoning: session.tokens?.reasoning ?? 0,
    },
    cost: session.cost ?? 0,
  }

  const redact = opts.redact !== false
  const out: RenderMessage[] = []
  let statTools = 0
  let statErrors = 0
  let statReasoning = 0
  let redactions = 0

  for (const m of messages) {
    const info = m.info ?? m
    const parts = m.parts ?? []
    const items: ItemRender[] = []

    const isExportTurn = parts.some((p) => p && p.type === "tool" && p.tool === "export_html")
    if (isExportTurn) continue

    for (const part of parts) {
      const t = part?.type
      if (t === "step-start") continue

      if (t === "tool") {
        if (part.tool === "export_html") continue
        const st = part.state ?? {}
        const status = st.status || "pending"
        const inputRaw = st.input
        const inputText =
          typeof inputRaw === "string"
            ? rawText(inputRaw)
            : inputRaw && typeof inputRaw === "object" && typeof (inputRaw as any).command === "string"
              ? rawText((inputRaw as any).command)
              : JSON.stringify(inputRaw ?? {}, null, 2)
        const diff =
          typeof (st.metadata as any)?.diff === "string"
            ? String((st.metadata as any).diff)
            : typeof st.diff === "string"
              ? String(st.diff)
              : undefined
        const filePath =
          inputRaw &&
          typeof inputRaw === "object" &&
          typeof (inputRaw as any).filePath === "string"
            ? String((inputRaw as any).filePath)
            : undefined
        const content =
          inputRaw &&
          typeof inputRaw === "object" &&
          part.tool === "write" &&
          typeof (inputRaw as any).content === "string"
            ? String((inputRaw as any).content)
            : undefined
        const inputForCard = content !== undefined && filePath ? filePath : inputText
        const redInput = redact ? applyRedaction(inputForCard, "tool") : { text: inputForCard, count: 0 }
        redactions += redInput.count

        let contentText: string | undefined
        if (content !== undefined) {
          const rc = redact ? applyRedaction(content, "tool") : { text: content, count: 0 }
          redactions += rc.count
          contentText = rc.text
        }

        let outputText: string | undefined
        if (status === "error") outputText = rawText(st.error)
        else if (st.output != null) outputText = rawText(st.output)
        if (outputText !== undefined) {
          const redOut = redact ? applyRedaction(outputText, "tool") : { text: outputText, count: 0 }
          redactions += redOut.count
          outputText = redOut.text
        }

        let diffText: string | undefined
        if (diff !== undefined) {
          const redDiff = redact ? applyRedaction(diff, "tool") : { text: diff, count: 0 }
          redactions += redDiff.count
          diffText = redDiff.text
        }

        const attachments: FileRender[] = (st.attachments || part.attachments || []).map((a: any) => ({
          kind: "file" as const,
          mime: a.mime || "application/octet-stream",
          filename: a.filename,
          url: a.url,
        }))
        if (status !== "pending") statTools++
        if (status === "error") statErrors++
        items.push({
          kind: "tool",
          tool: part.tool || "tool",
          title: st.title,
          status,
          input: redInput.text,
          output: outputText,
          error: status === "error" ? outputText : undefined,
          start: st.time?.start,
          end: st.time?.end,
          attachments,
          diff: diffText,
          filePath,
          content: contentText,
        })
      } else if (t === "reasoning") {
        statReasoning++
        if (opts.includeReasoning) {
          const rt = redact ? applyRedaction(rawText(part.text), "all") : { text: rawText(part.text), count: 0 }
          redactions += rt.count
          items.push({ kind: "reasoning", html: await markdownToHtml(rt.text) })
        }
      } else if (t === "file" || t === "image") {
        items.push({ kind: "file", mime: part.mime, filename: part.filename, url: part.url })
      } else if (t === "text") {
        if (part.synthetic || part.ignored) continue
        const ttRaw = rawText(part.text)
        if (isExportHtmlPrompt(ttRaw, info.role)) continue
        const tt = redact ? applyRedaction(ttRaw, "all") : { text: ttRaw, count: 0 }
        redactions += tt.count
        items.push({ kind: "text", role: info.role || "assistant", html: await markdownToHtml(tt.text) })
      } else if (t === "step-finish") {
        const tk = part.tokens ?? {}
        const line = [`step: ${formatTokens(tk.output)} out / ${formatTokens(tk.input)} in`]
        if (part.cost) line.push(formatCost(part.cost))
        items.push({ kind: "annotation", text: line.join(" · ") })
      } else {
        items.push({ kind: "annotation", text: t.replace(/-/g, " ") })
      }

      if (abort?.aborted) throw new DOMException("Export aborted", "AbortError")
    }

    if (items.length) {
      out.push({
        role: info.role || "assistant",
        providerID: info.providerID,
        modelID: info.modelID,
        created: info.time?.created ?? Date.now(),
        completed: info.time?.completed,
        finish: info.finish,
        error: info.error ? (typeof info.error === "string" ? info.error : info.error?.data?.message) : undefined,
        items,
      })
    }
  }

  return {
    meta,
    messages: out,
    stats: { messages: out.length, tools: statTools, errors: statErrors, reasoning: statReasoning, redactions },
  }
}

/* ----------------------- 6. renderer + HTML template ---------------------- */

const CSS = `
:root {
  --bg:#ffffff; --bg-soft:#f6f7f9; --fg:#1f2328; --muted:#6b7280;
  --border:#e5e7eb; --accent:#2563eb; --accent-weak:#eef2ff;
  --user-bg:#eef2ff; --user-border:#dbe3ff; --assistant-bg:#ffffff;
  --tool-bg:#f8fafc; --reason-bg:#fffbeb;
  --code-bg:#0f1419; --code-fg:#e6edf3;
  --error-bg:#fef2f2; --error-fg:#b91c1c; --ok:#15803d; --warn:#b45309;
}
:root[data-theme="dark"] {
  --bg:#0d1117; --bg-soft:#161b22; --fg:#e6edf3; --muted:#9198a1;
  --border:#30363d; --accent:#3b82f6; --accent-weak:#1f2733;
  --user-bg:#1f2733; --user-border:#2d3b4f; --assistant-bg:#161b22;
  --tool-bg:#161b22; --reason-bg:#2b2311;
  --code-bg:#0b0e12; --code-fg:#e6edf3;
  --error-bg:#2a1518; --error-fg:#f87171; --ok:#4ade80; --warn:#fbbf24;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.55; font-size: 15px;
}
.wrap { max-width: 860px; margin: 0 auto; padding: 24px 20px 64px; }
header.chat-header { border-bottom: 1px solid var(--border); padding-bottom: 18px; margin-bottom: 22px; }
.chat-header-top { display: flex; align-items: flex-start; gap: 12px; justify-content: space-between; }
h1 { font-size: 1.45rem; margin: 0 0 4px; line-height: 1.2; word-break: break-word; }
.sub { color: var(--muted); font-size: 0.85rem; }
.theme-btn {
  flex: 0 0 auto; display:inline-flex; align-items:center; gap:6px;
  background: var(--bg-soft); color: var(--fg); border:1px solid var(--border);
  border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 0.8rem;
}
.theme-btn svg { width: 14px; height: 14px; }
.theme-btn .moon { display:none }
:root[data-theme="dark"] .theme-btn .moon { display:inline }
:root[data-theme="dark"] .theme-btn .sun { display:none }
.meta-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 16px; margin: 14px 0 0; font-size: 0.82rem;
}
.meta-grid dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; margin: 0; }
.meta-grid dd { margin: 2px 0 0; word-break: break-word; }
.redact-banner {
  margin-top: 14px; padding: 10px 14px; border: 1px solid var(--border);
  background: var(--reason-bg); border-radius: 10px; font-size: 0.82rem;
}
.chat { display: flex; flex-direction: column; gap: 20px; }
.turn { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; overflow-wrap: break-word; }
.turn-user { background: var(--user-bg); border-color: var(--user-border); }
.turn-assistant { background: var(--assistant-bg); }
.turn-head {
  display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
  font-size: 0.75rem; color: var(--muted); margin-bottom: 8px;
}
.turn-name { font-weight: 600; color: var(--fg); font-size: 0.8rem; }
.markdown { overflow-wrap: break-word; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6 { line-height:1.25; margin:1.1em 0 .5em; }
.markdown a { color: var(--accent); }
.markdown blockquote { margin:.6em 0; padding:.1em 1em; color:var(--muted); border-left:3px solid var(--border); }
.markdown table { border-collapse: collapse; margin:.6em 0; font-size:.9em; display:block; overflow-x:auto; }
.markdown th,.markdown td { border:1px solid var(--border); padding:5px 9px; }
.markdown hr { border:0; border-top:1px solid var(--border); margin:1em 0; }
.markdown img { max-width:100%; border-radius:8px; }
.markdown ul,.markdown ol { padding-left:1.4em; }
.markdown li+li { margin-top:2px; }
.markdown input[type=checkbox] { margin-right:4px; }
.codewrap { position: relative; margin: .7em 0; }
.codewrap pre {
  background: var(--code-bg); color: var(--code-fg); border-radius: 10px;
  padding: 12px 14px; overflow-x: auto; font-size: 0.82em; line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  margin: 0; white-space: pre-wrap; word-break: break-word;
}
.copy-btn {
  position:absolute; top:8px; right:8px; padding:3px 9px; font-size:0.72rem;
  border:1px solid var(--border); border-radius:6px; background: var(--bg-soft); color: var(--fg);
  cursor: pointer; opacity:.85;
}
.copy-btn.copied { color: var(--ok); }
details.toolcard {
  border:1px solid var(--border); border-radius:10px; background: var(--tool-bg);
  margin: .6em 0; overflow: hidden;
}
details.toolcard summary {
  cursor:pointer; list-style:none; display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding: 8px 12px; font-size: 0.8rem; user-select: none;
}
details.toolcard summary::-webkit-details-marker { display:none; }
details.toolcard summary:hover { background: var(--bg-soft); }
.tool-arrow { color: var(--muted); font-size:.7rem; transition: transform .12s; }
details[open] > summary .tool-arrow { transform: rotate(90deg); }
.tool-name { font-weight:600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tool-cmd { color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; font-size:0.78em; max-width: 55ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tool-meta { margin-left:auto; font-size:0.72rem; color: var(--muted); }
.tool-status { font-weight:600; font-size:0.72rem; }
.tool-status.completed { color: var(--ok); }
.tool-status.running, .tool-status.pending { color: var(--warn); }
.tool-status.error { color: var(--error-fg); }
.tool-body { padding: 4px 12px 12px; font-size: 0.82rem; }
.tool-row + .tool-row { margin-top: 10px; }
.tool-lbl { font-size:0.68rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:4px; }
pre.tool-input {
  margin:0; white-space:pre-wrap; word-break:break-word; font-size:.8em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--bg-soft); border:1px solid var(--border); border-radius:8px; padding:8px 10px; color: var(--fg);
}
pre.tool-input span.hljs { color: inherit; }
details.tool-error { border:1px solid var(--error-fg); border-radius:8px; overflow:hidden; margin-top:8px; }
details.tool-error summary { cursor:pointer; padding:6px 10px; font-size:.72rem; color: var(--error-fg); background: var(--error-bg); font-weight:600; }
details.tool-error pre { margin:0; padding:8px 10px; white-space:pre-wrap; word-break:break-word; font-size:.8em; font-family: ui-monospace, Menlo, Consolas, monospace; background: var(--error-bg); }
details.reasoning {
  border-left:3px solid var(--warn); border-radius:0 8px 8px 0; background: var(--reason-bg);
  padding: 8px 12px; margin: .6em 0; font-size: 0.85rem; color: var(--muted);
}
details.reasoning summary { cursor:pointer; font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
details.reasoning .markdown { font-size:.9em; }
.annotation { font-size: 0.72rem; color: var(--muted); margin-top: 6px; font-style: italic; }
.file-row {
  display:flex; align-items:center; gap:8px; margin:.5em 0; padding:8px 10px;
  border:1px dashed var(--border); border-radius:8px; font-size:0.8rem; color:var(--muted);
}
.file-row a { color: var(--accent); text-decoration: none; }
.file-row img { max-height: 220px; max-width:100%; border-radius:6px; }
.errbar { color: var(--error-fg); font-size:.78rem; margin-top:6px; }
footer.chat-footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.78rem; }
/* highlight.js dark theme (github-dark-ish), used for code blocks + tool output */
.hljs { color: var(--code-fg); }
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_ { color:#ff7b72; }
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_ { color:#d2a8ff; }
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id { color:#79c0ff; }
.hljs-string,.hljs-regexp,.hljs-addition { color:#a5d6ff; }
.hljs-built_in,.hljs-symbol,.hljs-bullet { color:#ffa657; }
.hljs-comment,.hljs-code,.hljs-formula { color:#8b949e; font-style: italic; }
.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo { color:#7ee787; }
.hljs-subst { color:#c9d1d9; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.edit-diff {
  margin: .6em 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--code-bg);
  color: var(--code-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .78rem;
}
.edit-diff-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-soft);
  border-bottom: 1px solid var(--border); color: var(--fg);
}
.edit-diff-header .edit-icon { color: var(--muted); }
.edit-diff-header .edit-tool { font-weight: 600; }
.edit-diff-header .edit-file {
  color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diff { overflow-x: auto; }
.diff-line {
  display: grid; grid-template-columns: 24px minmax(0, 1fr);
  min-height: 21px; line-height: 21px; white-space: pre;
}
.diff-sign { text-align: center; user-select: none; }
.diff-content { padding-right: 16px; }
.diff-add { background: rgba(46, 160, 67, .16); }
.diff-add .diff-sign { color: #3fb950; }
.diff-remove { background: rgba(248, 81, 73, .16); }
.diff-remove .diff-sign { color: #f85149; }
.diff-context { background: transparent; }
.diff-hunk {
  padding: 4px 12px; color: #58a6ff;
  background: rgba(56, 139, 253, .10);
  border-top: 1px solid rgba(56, 139, 253, .12);
  border-bottom: 1px solid rgba(56, 139, 253, .12);
}
.diff-file { padding: 5px 12px; color: var(--muted); }
@media (max-width: 560px) {
  .wrap { padding: 16px 12px 48px; }
  .meta-grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  body { font-size: 14px; }
}
`

const JS = `
(function () {
  function applyTheme(v) {
    document.documentElement.setAttribute("data-theme", v === "dark" ? "dark" : "light");
  }
  var forced = document.documentElement.getAttribute("data-theme-initial");
  if (forced === "light" || forced === "dark") applyTheme(forced);
  try {
    if (!forced) {
      var t = localStorage.getItem("export-html:theme");
      applyTheme(t || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    }
  } catch (_) {}
  var btn = document.getElementById("theme-btn");
  if (btn) {
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem("export-html:theme", next); } catch (_) {}
      document.documentElement.removeAttribute("data-theme-initial");
    });
  }
  function legacyCopy(btn, text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) markCopied(btn);
  }
  function markCopied(btn) {
    if (!btn) return;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
  }
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".copy-btn") : null;
    if (!btn) return;
    var target = document.getElementById(btn.getAttribute("data-target"));
    if (!target) return;
    var text = target.innerText || target.textContent || "";
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { markCopied(btn); }, function () { legacyCopy(btn, text); });
    } else {
      legacyCopy(btn, text);
    }
  });
  var times = document.querySelectorAll("time[data-ts]");
  for (var i = 0; i < times.length; i++) {
    var el = times[i];
    var ts = parseInt(el.getAttribute("data-ts"), 10);
    if (!isNaN(ts)) {
      try { el.textContent = new Date(ts).toLocaleString(); } catch (_) {}
    }
  }
})();
`

function themeSvg(): string {
  return `
    <span class="sun"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-10a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-1.5 0v-2A.75.75 0 0 1 8 1Zm5.3 1.7a.75.75 0 0 1 0 1.06l-1.4 1.4a.748.748 0 0 1-1.06-1.06l1.4-1.4a.75.75 0 0 1 1.06 0ZM11 8a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 11 8ZM1.7 9.06a.75.75 0 0 1 0-1.06l1.4-1.4a.748.748 0 0 1 1.06 1.06l-1.4 1.4a.75.75 0 0 1-1.06 0Zm7.3 1.94a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-1.5 0v-2A.75.75 0 0 1 9 11Zm-5.06-.19a.75.75 0 0 1 1.06 1.06l-1.4 1.4a.75.75 0 0 1-1.06-1.06l1.4-1.4ZM11.06 9.06a.75.75 0 0 1 1.06-1.06l1.4 1.4a.748.748 0 0 1-1.06 1.06l-1.4-1.4Z"/></svg></span>
    <span class="moon"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.6 1.9A7 7 0 1 1 6.7 8.7 6.7 5.7 9.6 1.9Zm.8 1.5a5.5 5.5 0 1 0 6.2 6.2A5.5 5.5 0 0 1 10.4 3.4Z"/></svg></span>`
}

function renderMeta(conv: Conversation, opts: ExportOptions): string {
  const { meta, stats } = conv
  const model = meta.model ? `${meta.model.providerID}/${meta.model.id}` + (meta.model.variant ? ` (${meta.model.variant})` : "") : "—"
  const durMs = meta.updated - meta.created
  const rows: Array<[string, string]> = [
    ["Model", model],
    ["Agent", meta.agent ? escapeHtml(meta.agent) : "—"],
    ["Directory", meta.directory ? `<code>${escapeHtml(meta.directory)}</code>` : "—"],
    ["Started", `<time data-ts="${meta.created}">${escapeHtml(localTime(meta.created))}</time>`],
    ["Duration", formatDur(durMs)],
    ["Messages", String(stats.messages)],
    ["Tools", String(stats.tools)],
    [
      "Tokens",
      `${formatTokens(meta.tokens.input)} in · ${formatTokens(meta.tokens.output)} out` +
        (meta.tokens.reasoning ? ` · ${formatTokens(meta.tokens.reasoning)} reasoning` : ""),
    ],
    ["Cost", formatCost(meta.cost)],
  ]
  let banner = ""
  if (stats.redactions > 0 && opts.redact !== false) {
    banner = `<div class="redact-banner"><strong>Redacted:</strong> ${stats.redactions} value${stats.redactions === 1 ? "" : "s"} hidden from this export. Re-export with <code>--no-redact</code> to include them.</div>`
  }
  return `
  <div class="chat-header-top">
    <div>
      <h1>${escapeHtml(meta.title)}</h1>
      <div class="sub">Session ${escapeHtml(meta.id)}</div>
    </div>
    <button class="theme-btn" id="theme-btn" type="button" title="Toggle dark / light">${themeSvg()}</button>
  </div>
  <dl class="meta-grid">${rows.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join("")}</dl>
  ${banner}`
}

async function fileToDataUri(url: string, cwd: string): Promise<string | undefined> {
  if (!url.startsWith("file://") && !url.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(url)) return undefined
  let p: string
  try {
    if (url.startsWith("file://")) p = new URL(url).pathname
    else p = url
    const stat = await fs.stat(p)
    if (stat.size > 2 * 1024 * 1024) return undefined
    const buf = await fs.readFile(p)
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    }
    const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase()
    const mt = mimeMap[ext] || "image/png"
    return `data:${mt};base64,${buf.toString("base64")}`
  } catch {
    return undefined
  }
}

async function renderFileItem(f: { kind: "file"; mime?: string; filename?: string; dataUri?: string; url?: string }, opts: ExportOptions, cwd: string): Promise<string> {
  const name = f.filename || f.url || "attachment"
  if (f.mime?.startsWith("image/") && f.url && opts.includeFiles !== false) {
    const dataUri = await fileToDataUri(f.url, cwd)
    if (dataUri) return `<div class="file-row"><img src="${dataUri}" alt="${escapeHtml(name)}" loading="lazy"></div>`
  }
  const href = f.url?.startsWith("http") ? f.url : undefined
  const label = href ? `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name)
  return `<div class="file-row"><span>${label}${f.mime ? ` · ${escapeHtml(f.mime)}` : ""}</span></div>`
}

function parseUnifiedDiff(diff: string): string {
  const lines = diff.split("\n")
  const html: string[] = []
  for (const line of lines) {
    if (line.startsWith("@@")) {
      html.push(`<div class="diff-hunk">${escapeHtml(line)}</div>`)
      continue
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      html.push(`<div class="diff-file">${escapeHtml(line)}</div>`)
      continue
    }
    if (line.startsWith("+")) {
      html.push(
        `<div class="diff-line diff-add"><span class="diff-sign">+</span><span class="diff-content">${escapeHtml(line.slice(1))}</span></div>`,
      )
      continue
    }
    if (line.startsWith("-")) {
      html.push(
        `<div class="diff-line diff-remove"><span class="diff-sign">−</span><span class="diff-content">${escapeHtml(line.slice(1))}</span></div>`,
      )
      continue
    }
    html.push(`<div class="diff-line diff-context"><span class="diff-sign"> </span><span class="diff-content">${escapeHtml(line)}</span></div>`)
  }
  return html.join("")
}

function synthesizeWriteDiff(filePath: string, content: string): string {
  const norm = content.replace(/\r/g, "").split("\n")
  if (norm.length && norm[norm.length - 1] === "") norm.pop()
  return (
    `--- a/${filePath}\n` +
    `+++ b/${filePath}\n` +
    `@@ -0,0 +1,${norm.length} @@\n` +
    norm.map((l) => `+${l}`).join("\n")
  )
}

async function renderConversation(conv: Conversation, opts: ExportOptions, cwd: string): Promise<string> {
  let uniq = 0
  const blocks: string[] = []
  for (const m of conv.messages) {
    const isUser = m.role === "user"
    const head =
      `<div class="turn-head"><span class="turn-name">${isUser ? "You" : "Assistant"}</span>` +
      (m.modelID && !isUser ? ` <span>· <code>${escapeHtml(m.modelID)}</code></span>` : "") +
      ` <time data-ts="${m.created}">${escapeHtml(localTime(m.created))}</time>` +
      (m.finish ? ` <span>· ${escapeHtml(String(m.finish))}</span>` : "") +
      `</div>`
    const items: string[] = []
    for (const it of m.items) {
      if (it.kind === "text") {
        items.push(`<div class="markdown">${it.html}</div>`)
      } else if (it.kind === "reasoning") {
        items.push(`<details class="reasoning"><summary>Reasoning</summary><div class="markdown">${it.html}</div></details>`)
      } else if (it.kind === "tool") {
        const t = it
        const isFileDiff = (t.tool === "edit" || t.tool === "apply_patch") && t.diff !== undefined
        const isWrite = t.tool === "write" && t.content !== undefined
        if (isFileDiff || isWrite) {
          const file = t.filePath || t.title || "file"
          const diff = isWrite ? synthesizeWriteDiff(file, t.content as string) : (t.diff as string)
          const dur = t.start && t.end ? formatDur(t.end - t.start) : ""
          const statusLabel = t.status === "error" ? "error" : t.status === "completed" ? "completed" : t.status
          const statusClass = ["completed", "error", "running", "pending"].includes(t.status) ? t.status : "running"
          let extra = ""
          if (t.status === "error") {
            extra = `<details class="tool-error"><summary>Show error</summary><pre>${escapeHtml(t.error ?? t.output ?? "")}</pre></details>`
          } else if (t.output != null && t.output !== "") {
            const oh = await highlightPlainAsync(t.output)
            const id = `output-${uniq++}`
            extra = `<div class="tool-row"><div class="tool-lbl">Output</div><div class="codewrap"><button class="copy-btn" type="button" data-target="${id}">Copy</button><pre class="output" id="${id}">${oh}</pre></div></div>`
          }
          items.push(
            `<details class="toolcard"><summary><span class="tool-arrow">▸</span>` +
              `<span class="tool-name">${escapeHtml(t.tool)}</span><span class="tool-cmd">${escapeHtml(file)}</span>` +
              `<span class="tool-meta">${dur ? `${dur} · ` : ""}<span class="tool-status ${statusClass}">${escapeHtml(statusLabel)}</span></span></summary>` +
              `<div class="tool-body"><div class="edit-diff">` +
              `<div class="edit-diff-header"><span class="edit-icon">✎</span><span class="edit-tool">${escapeHtml(t.tool)}</span><span class="edit-file">${escapeHtml(file)}</span></div>` +
              `<div class="diff">${parseUnifiedDiff(diff)}</div>` +
              `</div>${extra}</div></details>`,
          )
          continue
        }
        const dur = t.start && t.end ? formatDur(t.end - t.start) : ""
        const statusLabel = t.status === "error" ? "error" : t.status === "completed" ? "completed" : t.status
        const statusClass = ["completed", "error", "running", "pending"].includes(t.status) ? t.status : "running"
        let body = `<div class="tool-row"><div class="tool-lbl">Input</div><pre class="tool-input">${await highlightPlainAsync(t.input)}</pre></div>`
        const atts: string[] = []
        for (const f of t.attachments) atts.push(await renderFileItem(f, opts, cwd))
        for (const a of atts) body += `<div class="tool-row">${a}</div>`
        if (t.status === "error") {
          body += `<details class="tool-error"><summary>Show error</summary><pre>${escapeHtml(t.error ?? t.output ?? "")}</pre></details>`
        } else if (t.output != null && t.output !== "") {
          const html = await highlightPlainAsync(t.output)
          const id = `output-${uniq++}`
          body += `<div class="tool-row"><div class="tool-lbl">Output</div><div class="codewrap"><button class="copy-btn" type="button" data-target="${id}">Copy</button><pre class="output" id="${id}">${html}</pre></div></div>`
        }
        const cmd = t.title ? `<span class="tool-cmd">${escapeHtml(String(t.title))}</span>` : `<span class="tool-cmd">${escapeHtml(t.input.split("\n")[0]?.slice(0, 120) ?? "")}</span>`
        items.push(
          `<details class="toolcard"><summary><span class="tool-arrow">▸</span><span class="tool-name">${escapeHtml(t.tool)}</span>${cmd}` +
            `<span class="tool-meta">${dur ? `${dur} · ` : ""}<span class="tool-status ${statusClass}">${escapeHtml(statusLabel)}</span></span></summary>` +
            `<div class="tool-body">${body}</div></details>`,
        )
      } else if (it.kind === "file") {
        items.push(await renderFileItem(it, opts, cwd))
      } else if (it.kind === "annotation") {
        items.push(`<div class="annotation">${escapeHtml(it.text)}</div>`)
      }
    }
    if (m.error) items.push(`<div class="errbar">error: ${escapeHtml(m.error)}</div>`)
    if (!items.length) continue
    blocks.push(`<div class="turn turn-${isUser ? "user" : "assistant"}">${head}${items.join("")}</div>`)
  }
  return blocks.join("\n")
}

export async function renderDocument(conv: Conversation, opts: ExportOptions, cwd: string): Promise<string> {
  const meta = conv.meta
  const title = `${meta.title} — opencode export`
  const body = await renderConversation(conv, opts, cwd)
  const modelNote = meta.model ? `${meta.model.providerID}/${meta.model.id}` : "opencode"
  const footer =
    `Generated ${localTime(Date.now())} by opencode export_html · ${conv.stats.messages} messages · ` +
    `${conv.stats.tools} tool calls · model ${escapeHtml(modelNote)}`
  const initialTheme = opts.theme === "light" || opts.theme === "dark" ? opts.theme : ""
  return `<!doctype html>
<html lang="en"${initialTheme ? ` data-theme-initial="${initialTheme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="opencode-export-html">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="chat-header">${renderMeta(conv, opts)}</header>
<main class="chat">${body}</main>
<footer class="chat-footer">${footer}</footer>
</div>
<script>${JS}</script>
</body>
</html>
`
}

/* ------------------------------ 7. tool ---------------------------------- */

function resolveOutput(opts: ExportOptions, cwd: string, meta: SessionMeta): string {
  if (opts.output) return path.resolve(cwd, opts.output)
  const dir = path.join(cwd || process.cwd(), "exports")
  const base = slugify(meta.title) || `session-${meta.id.slice(-8)}`
  return path.join(dir, `${base}-${stamp()}.html`)
}

async function exportCurrentSession(
  client: any,
  opts: ExportOptions,
  context: { sessionID: string; directory: string; worktree: string; abort: AbortSignal },
): Promise<{ file: string; htmlSize: number; conversation: Conversation }> {
  const check = () => {
    if (context.abort?.aborted) throw new DOMException("Export aborted", "AbortError")
  }

  check()
  const session = await sessionFetch<any>(client, "get", context.sessionID)
  check()
  const messages = await sessionFetch<Array<{ info?: any; parts?: any[] }>>(client, "messages", context.sessionID)

  const cwd = context.directory || process.cwd()
  check()
  const conversation = await loadConversation(session, messages, opts, context.abort)
  check()
  const html = await renderDocument(conversation, opts, cwd)
  check()
  const file = resolveOutput(opts, cwd, conversation.meta)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, html, "utf-8")
  return { file, htmlSize: Buffer.byteLength(html), conversation }
}

/* -------------------------- 8. plugin export ------------------------------ */

export const ExportHtmlPlugin: Plugin = async ({ client, directory }) => {
  const export_html = tool({
    description:
      "Export the current opencode conversation to a single-file, offline-portable HTML report (all CSS/JS/theme inline, local images embedded as data URIs).",
    args: {
      output: tool.schema
        .string()
        .optional()
        .describe("Target .html file path (default: <project>/exports/<title>-<timestamp>.html)"),
      theme: tool.schema.enum(["auto", "light", "dark"]).optional().describe("Initial colour theme of the generated file"),
      includeReasoning: tool.schema.boolean().optional().describe("Include collapsed reasoning/thinking blocks (default false)"),
      includeFiles: tool.schema.boolean().optional().describe("Embed local file/image attachments as data URIs (default true)"),
      redact: tool.schema.boolean().optional().describe("Redact obvious secrets (API keys, tokens, {env:VAR} refs); default true"),
      title: tool.schema.string().optional().describe("Override the title shown in the report header"),
    },
    async execute(args, context) {
      const opts: ExportOptions = {
        output: args.output,
        theme: args.theme,
        includeReasoning: args.includeReasoning,
        includeFiles: args.includeFiles,
        redact: args.redact,
        title: args.title,
      }
      const { file, htmlSize, conversation } = await exportCurrentSession(client, opts, context as any)
      const s = conversation.stats
      const rel = file.startsWith(directory) ? file.slice(directory.length) : file
      return {
        title: "HTML export complete",
        output:
          `Exported conversation "${conversation.meta.title}" to:\n${file}\n\n` +
          `${s.messages} messages · ${s.tools} tool calls · ${s.errors} errors · ${(htmlSize / 1024).toFixed(1)} KiB` +
          (s.reasoning ? ` · ${s.reasoning} reasoning block(s)` : "") +
          (s.redactions > 0 ? ` · ${s.redactions} value(s) redacted` : "") +
          `\n\nOpen it with \`open "${rel}"\``,
        metadata: { file, size: htmlSize, messages: s.messages, tools: s.tools, errors: s.errors, redactions: s.redactions },
      }
    },
  })

  return { tool: { export_html } }
}

export default ExportHtmlPlugin