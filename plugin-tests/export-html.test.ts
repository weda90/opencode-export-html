import { describe, expect, test } from "bun:test"
import {
  applyRedaction,
  escapeHtml,
  loadConversation,
  markdownToHtml,
  renderDocument,
  sessionFetch,
  slugify,
  type Conversation,
  type ExportOptions,
} from "../plugins/export-html.ts"
import basicFixture from "./fixtures/basic.json"
import shortFixture from "./fixtures/short.json"

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("slugify", () => {
  test("sanitizes titles into safe filenames", () => {
    expect(slugify("Build: auth system!?")).toBe("build-auth-system")
    expect(slugify("Contacts & Friends")).toBe("contacts-friends")
    expect(slugify("")).toBe("session")
    expect(slugify("  --  -")).toBe("session")
    expect(slugify("A".repeat(200)).length).toBeLessThanOrEqual(80)
  })
})

describe("escapeHtml", () => {
  test("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;")
  })
})

describe("applyRedaction", () => {
  test("redacts obvious secrets in all scopes", () => {
    const r = applyRedaction("key=sk-abcdefghijklmnopqrstuvwxyz ... done", "all")
    expect(r.count).toBe(1)
    expect(r.text).toContain("[REDACTED: api key]")
    expect(r.text).not.toContain("sk-")
  })
  test("redacts private key blocks (multiline)", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA123\n-----END RSA PRIVATE KEY-----"
    const r = applyRedaction(pem, "all")
    expect(r.count).toBe(1)
    expect(r.text).toBe("[REDACTED: private key]")
  })
  test("redacts bearer tokens, github tokens and {env:} refs", () => {
    const r = applyRedaction("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 ghp_abcdefghijklmnopqrstuvwxyz env {env:PATH}", "all")
    expect(r.text).toContain("[REDACTED: bearer token]")
    expect(r.text).toContain("[REDACTED: github token]")
    expect(r.text).toContain("[REDACTED: secret reference]")
  })
  test("redacts credential key:value pairs", () => {
    const r = applyRedaction(`config.password: "hunter22secret"`, "all")
    expect(r.count).toBe(1)
    expect(r.text).toContain("[REDACTED: credential]")
  })
  test("leaves ordinary prose untouched", () => {
    const r = applyRedaction("hello world, this is a normal sentence about tokens and secrets in code.", "all")
    expect(r.count).toBe(0)
    expect(r.text).toContain("hello world")
  })
  test("long hex/base64 only redacted in tool scope", () => {
    const hex = "1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c"
    expect(applyRedaction(hex, "all").count).toBe(0)
    expect(applyRedaction(hex, "tool").count).toBe(1)
  })
})

describe("sessionFetch", () => {
  test("v1 SDK client: substitutes path param from options.path", async () => {
    const seen: any = {}
    const client: any = {
      session: {
        get: (options: any) => {
          seen.get = options
          return Promise.resolve({ data: { id: options.path.id } })
        },
        messages: (options: any) => {
          seen.messages = options
          return Promise.resolve({ data: [{ info: { id: options.path.id }, parts: [] }] })
        },
      },
    }
    const session = await sessionFetch<any>(client, "get", "ses_abc123")
    const messages = await sessionFetch<any>(client, "messages", "ses_abc123")
    expect(seen.get.path?.id).toBe("ses_abc123")
    expect(seen.messages.path?.id).toBe("ses_abc123")
    expect(session.id).toBe("ses_abc123")
    expect(messages[0].info.id).toBe("ses_abc123")
  })

  test("v2 SDK client: positional (parameters, options) with sessionID key", async () => {
    const seen: any = {}
    const client: any = {
      // eslint-disable-next-line no-unused-vars
      session: {
        get(parameters: any, _options: any) {
          seen.get = parameters
          return Promise.resolve({ data: { id: parameters.sessionID } })
        },
        messages(parameters: any, _options: any) {
          seen.messages = parameters
          return Promise.resolve({ data: [{ info: { id: parameters.sessionID }, parts: [] }] })
        },
      },
    }
    const session = await sessionFetch<any>(client, "get", "ses_xyz789")
    const messages = await sessionFetch<any>(client, "messages", "ses_xyz789")
    expect(seen.get.sessionID).toBe("ses_xyz789")
    expect(seen.messages.sessionID).toBe("ses_xyz789")
    expect(session.id).toBe("ses_xyz789")
    expect(messages[0].info.id).toBe("ses_xyz789")
  })
})

describe("markdownToHtml", () => {
  test("renders markdown and discards injected HTML", async () => {
    const out = await markdownToHtml(
      "# Title\n\nSee <script>alert(1)</script><img src=x onerror=alert(2)> and [docs](https://example.com).",
    )
    expect(out).toContain("<h1>Title</h1>")
    expect(out).toContain('<a href="https://example.com">docs</a>')
    expect(out).not.toContain("alert(1)")
    expect(out).not.toContain("onerror")
    expect(out).not.toContain("<script")
  })
  test("syntax-highlights fenced code blocks at export time", async () => {
    const out = await markdownToHtml("```js\nconst x = 1\n```")
    expect(out).toContain('<code class="language-js hljs"')
    expect(out).toContain("hljs-keyword") // highlight.js token spans embedded
  })
})

describe("loadConversation", () => {
  const opts: ExportOptions = { redact: true }

  test("short fixture: no tools/reasoning, metadata parsed", async () => {
    const conv = await loadConversation((shortFixture as any).session, (shortFixture as any).messages, opts)
    expect(conv.meta.title).toBe("Quick question")
    expect(conv.meta.model).toEqual({ id: "gpt-4o-mini", providerID: "openai" })
    expect(conv.stats.tools).toBe(0)
    expect(conv.stats.reasoning).toBe(0)
    expect(conv.stats.redactions).toBe(0)
    expect(conv.messages.length).toBe(2)
  })

  test("basic fixture: tools/errors counted, synthetic parts filtered", async () => {
    const conv = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, opts)
    expect(conv.meta.title).toBe("Build authentication system")
    expect(conv.stats.messages).toBe(4)
    expect(conv.stats.tools).toBe(3) // two completed + one error
    expect(conv.stats.errors).toBe(1)
    expect(conv.stats.reasoning).toBe(1)

    const allText = conv.messages.map((m) => m.items.map((i) => (i.kind === "text" ? i.html : "")).join("")).join(" ")
    expect(allText).not.toContain("system-reminder")
    expect(allText).not.toContain("ignored retry text")
  })

  test("reasoning hidden by default, included as collapsed block with flag", async () => {
    const hidden = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true })
    const visible = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true, includeReasoning: true })
    const hiddenReasons = hidden.messages.flatMap((m) => m.items.filter((i) => i.kind === "reasoning"))
    const visibleReasons = visible.messages.flatMap((m) => m.items.filter((i) => i.kind === "reasoning"))
    expect(hiddenReasons.length).toBe(0)
    expect(visibleReasons.length).toBe(1)
  })

  test("secrets redacted by default, kept with redact:false", async () => {
    const on = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true })
    const off = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: false })
    expect(on.stats.redactions).toBeGreaterThan(0)
    expect(off.stats.redactions).toBe(0)

    const onText = JSON.stringify(on.messages)
    const offText = JSON.stringify(off.messages)
    expect(onText).toContain("[REDACTED:")
    expect(onText).not.toContain("sk-123456789012345678901234567890")
    expect(onText).not.toContain("gho_abcdefghijklmnopqrstuvwxyz1234567890")
    expect(offText).toContain("sk-123456789012345678901234567890")
  })
})

describe("renderDocument", () => {
  test("produces a self-contained single-file document", async () => {
    const conv = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")

    expect(doc.startsWith("<!doctype html>")).toBe(true)
    expect(doc).toContain('<html lang="en"')
    expect(doc).toContain("<style>")
    expect(doc).toContain('<button class="theme-btn" id="theme-btn"')
    expect(doc).toContain("Build authentication system")
    expect(doc).toContain('<dl class="meta-grid">')
    expect(doc).toContain("Generated")

    // exactly one <script> — our fixed inline runtime only
    expect(count(doc, "<script>")).toBe(1)
    expect(doc).toContain("getElementById")

    // no content HTML leaks through
    expect(doc).not.toContain("alert(1)")
    expect(doc).not.toContain("onerror")
    expect(doc).not.toContain("<script>alert")
    expect(doc).not.toContain("{env:OPENAI_API_KEY}")
    expect(doc).not.toContain("sk-123456789012345678901234567890")

    // tool calls rendered as collapsible <details>
    expect(count(doc, '<details class="toolcard">')).toBe(3)
    expect(doc).toContain("npm test")
    expect(doc).toContain("Show error")
    expect(doc).toContain("completed")
  })

  test("copy buttons match number of output blocks", async () => {
    const conv = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    const copyBtns = count(doc, 'class="copy-btn"')
    const outputs = count(doc, '<pre class="output"')
    expect(copyBtns).toBe(outputs)
    expect(outputs).toBeGreaterThan(0)
  })

  test("honours explicit theme via data-theme-initial", async () => {
    const conv = await loadConversation((shortFixture as any).session, (shortFixture as any).messages, { redact: true })
    const dark = await renderDocument(conv, { theme: "dark" }, "/tmp/proj")
    const light = await renderDocument(conv, { theme: "light" }, "/tmp/proj")
    const auto = await renderDocument(conv, { theme: "auto" }, "/tmp/proj")
    expect(dark).toContain('data-theme-initial="dark"')
    expect(light).toContain('data-theme-initial="light"')
    expect(auto).not.toContain("data-theme-initial=")
  })

  test("redaction banner present when values were hidden", async () => {
    const conv = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).toContain('class="redact-banner"')
    expect(doc).toContain("values hidden from this export")

    const raw = await loadConversation((basicFixture as any).session, (basicFixture as any).messages, { redact: false })
    const docRaw = await renderDocument(raw, { redact: false }, "/tmp/proj")
    expect(docRaw).not.toContain('class="redact-banner"')
  })
})

describe("round-trip smoke", () => {
  test("short session renders and stays script-clean", async () => {
    const conv: Conversation = await loadConversation((shortFixture as any).session, (shortFixture as any).messages, { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).toContain("Quick question")
    expect(doc).toContain("What is 2+2?")
    expect(count(doc, "<script>")).toBe(1)
    expect(doc).not.toContain("</script> inline") // inline-code script tag stays escaped
  })
})