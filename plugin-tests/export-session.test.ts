import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import mod, { exportCurrentSessionV2, parseExportArgs, resolveSessionMessages } from "../plugins/export-html.ts"

describe("parseExportArgs", () => {
  test("empty text returns defaults", () => {
    expect(parseExportArgs("")).toEqual({})
    expect(parseExportArgs("   ")).toEqual({})
  })

  test("parses --output with a space", () => {
    expect(parseExportArgs("--output report.html")).toEqual({ output: "report.html" })
  })

  test("parses --output with equals", () => {
    expect(parseExportArgs("--output=report.html")).toEqual({ output: "report.html" })
  })

  test("parses --theme", () => {
    expect(parseExportArgs("--theme dark")).toEqual({ theme: "dark" })
    expect(parseExportArgs("--theme=light")).toEqual({ theme: "light" })
    expect(parseExportArgs("--theme auto")).toEqual({ theme: "auto" })
  })

  test("rejects an unknown theme", () => {
    expect(() => parseExportArgs("--theme neon")).toThrow(/Invalid theme/)
  })

  test("parses boolean flags", () => {
    expect(parseExportArgs("--include-reasoning")).toEqual({ includeReasoning: true })
    expect(parseExportArgs("--no-include-files")).toEqual({ includeFiles: false })
    expect(parseExportArgs("--no-redact")).toEqual({ redact: false })
  })

  test("parses quoted and equals-form titles", () => {
    expect(parseExportArgs('--title "My Report"')).toEqual({ title: "My Report" })
    expect(parseExportArgs("--title='My Report'")).toEqual({ title: "My Report" })
    expect(parseExportArgs('--title="My Report"')).toEqual({ title: "My Report" })
  })

  test("parses several options together", () => {
    expect(parseExportArgs('--theme dark --no-redact --title "Demo Run" --output out.html')).toEqual({
      theme: "dark",
      redact: false,
      title: "Demo Run",
      output: "out.html",
    })
  })

  test("rejects unknown options", () => {
    expect(() => parseExportArgs("--wat")).toThrow(/Unknown option/)
  })

  test("rejects a missing value", () => {
    expect(() => parseExportArgs("--title")).toThrow(/requires a value/)
  })

  test("rejects a following flag as a value", () => {
    expect(() => parseExportArgs("--title --no-redact")).toThrow(/requires a value/)
    expect(() => parseExportArgs("--output --wat")).toThrow(/requires a value/)
    expect(() => parseExportArgs("--title --theme dark")).toThrow(/requires a value/)
  })

  test("allows a literal value starting with dashes via equals", () => {
    expect(parseExportArgs("--title=--literal")).toEqual({ title: "--literal" })
  })

  test("rejects empty values", () => {
    expect(() => parseExportArgs("--output=")).toThrow(/requires a value/)
    expect(() => parseExportArgs("--title=")).toThrow(/requires a value/)
    expect(() => parseExportArgs("--theme=")).toThrow(/requires a value/)
  })

  test("rejects bare arguments", () => {
    expect(() => parseExportArgs("hello")).toThrow(/Unexpected argument/)
  })
})

async function withCtx(
  fn: (added: { tools: any[]; commands: any[] }, calls: { prompt: number; synthetic: number }, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "export-session-"))
  const added = { tools: [] as any[], commands: [] as any[] }
  const calls = { prompt: 0, synthetic: 0 }
  const ctx: any = {
    location: { directory: dir },
    session: {
      get: async () => ({
        id: "ses_demo",
        title: "Demo Session",
        directory: dir,
        model: JSON.stringify({ id: "test-model", providerID: "test-provider" }),
        agent: "build",
        time: { created: 1700000000000, updated: 1700000010000 },
        tokens: { input: 10, output: 20, reasoning: 0 },
        cost: 0,
      }),
      context: async () => [
        {
          info: { role: "user", time: { created: 1700000000000 } },
          parts: [{ type: "text", text: "Hello from the test session" }],
        },
      ],
      prompt: async () => {
        calls.prompt++
      },
      synthetic: async () => {
        calls.synthetic++
      },
    },
    tool: { transform: async (transform: any) => transform({ add: (tool: any) => added.tools.push(tool) }) },
    command: { transform: async (transform: any) => transform({ add: (command: any) => added.commands.push(command) }) },
  }
  try {
    await (mod as any).setup(ctx)
    await fn(added, calls, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("export-session command", () => {
  test("setup registers export_html and export-session", async () => {
    await withCtx(async (added) => {
      expect(added.tools.map((tool) => tool.name)).toContain("export_html")
      expect(added.commands.map((command) => command.name)).toContain("export-session")
    })
  })

  test("execute writes the report without prompting or synthesizing", async () => {
    await withCtx(async (added, calls, dir) => {
      const command = added.commands.find((entry) => entry.name === "export-session")
      await command.execute({ sessionID: "ses_demo", prompt: { text: "" }, delivery: "queue" })

      const files = await readdir(path.join(dir, "exports"))
      expect(files.filter((file) => file.endsWith(".html"))).toHaveLength(1)
      const html = await readFile(path.join(dir, "exports", files[0]), "utf-8")
      expect(html).toContain("Hello from the test session")
      expect(calls).toEqual({ prompt: 0, synthetic: 0 })
    })
  })

  test("execute honors --theme and --title", async () => {
    await withCtx(async (added, _calls, dir) => {
      const command = added.commands.find((entry) => entry.name === "export-session")
      await command.execute({
        sessionID: "ses_demo",
        prompt: { text: '--theme dark --title "Demo Report"' },
        delivery: "queue",
      })

      const files = await readdir(path.join(dir, "exports"))
      const html = await readFile(path.join(dir, "exports", files[0]), "utf-8")
      expect(html).toContain('data-theme-initial="dark"')
      expect(html).toContain("<title>Demo Report")
    })
  })

  test("execute rejects an unknown option and writes nothing", async () => {
    await withCtx(async (added, _calls, dir) => {
      const command = added.commands.find((entry) => entry.name === "export-session")
      await expect(
        command.execute({ sessionID: "ses_demo", prompt: { text: "--wat" }, delivery: "queue" }),
      ).rejects.toThrow(/Unknown option/)
      await expect(readdir(path.join(dir, "exports"))).rejects.toThrow()
    })
  })
})

describe("session history after compaction", () => {
  const compaction = { type: "compaction", summary: "old context" }
  const full = [
    { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "old user message" }] },
    { info: { role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "old assistant message" }] },
  ]

  test("uses the full history when the active context contains a compaction", async () => {
    const ctx = { session: { context: async () => [compaction] } }
    const messages = await resolveSessionMessages(ctx, "ses_demo", async () => full)
    expect(messages).toBe(full)
  })

  test("uses the full history when a compaction is followed by new messages", async () => {
    const ctx = { session: { context: async () => [compaction, { type: "user", text: "after" }] } }
    const messages = await resolveSessionMessages(ctx, "ses_demo", async () => full)
    expect(messages).toBe(full)
  })

  test("keeps the active context when it is not compacted", async () => {
    const context = [{ type: "user", text: "hello" }]
    let called = false
    const ctx = { session: { context: async () => context } }
    const messages = await resolveSessionMessages(ctx, "ses_demo", async () => {
      called = true
      return full
    })
    expect(messages).toBe(context)
    expect(called).toBe(false)
  })

  test("reports an error instead of exporting an empty compacted transcript", async () => {
    const ctx = { session: { context: async () => [compaction] } }
    await expect(
      resolveSessionMessages(ctx, "ses_demo", async () => {
        throw new Error("offline")
      }),
    ).rejects.toThrow(/full session transcript/)
  })

  test("exports the full transcript when the active context is compacted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "export-session-"))
    const ctx: any = {
      location: { directory: dir },
      session: {
        get: async () => ({
          id: "ses_demo",
          title: "Compacted Session",
          directory: dir,
          model: JSON.stringify({ id: "test-model", providerID: "test-provider" }),
          agent: "build",
          time: { created: 1, updated: 2 },
          tokens: { input: 10, output: 20, reasoning: 0 },
          cost: 0,
        }),
        context: async () => [compaction],
      },
    }
    try {
      const { conversation } = await exportCurrentSessionV2(ctx, "ses_demo", {}, undefined, async () => full)
      expect(conversation.stats.messages).toBe(2)
      const files = await readdir(path.join(dir, "exports"))
      const html = await readFile(path.join(dir, "exports", files[0]), "utf-8")
      expect(html).toContain("old user message")
      expect(html).toContain("old assistant message")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
