import { describe, expect, test } from "bun:test"
import { loadConversation, normalizeV2Messages, renderDocument } from "../plugins/export-html.ts"

const session = {
  id: "ses_v2native",
  title: "V2 native payloads",
  model: { id: "test-model", providerID: "test-provider" },
  agent: "build",
  directory: "/tmp/proj",
  time: { created: 1700000000000, updated: 1700000001000 },
  tokens: { input: 10, output: 20, reasoning: 0 },
  cost: 0,
}

function v2Edit() {
  return [
    { type: "user", id: "m1", time: { created: 1700000000000 }, text: "edit the controller" },
    {
      type: "assistant",
      id: "m2",
      time: { created: 1700000000500, completed: 1700000000800 },
      model: { id: "test-model", providerID: "test-provider" },
      finish: "stop",
      content: [
        {
          type: "tool",
          id: "t1",
          name: "edit",
          state: {
            status: "completed",
            input: { path: "/tmp/proj/app/TrackingController.php", oldString: "a", newString: "b" },
            metadata: {
              files: [
                {
                  file: "/tmp/proj/app/TrackingController.php",
                  patch: "@@ -1,2 +1,2 @@\n-old line\n+new line\n context",
                  additions: 1,
                  deletions: 1,
                },
              ],
            },
          },
          time: { created: 1700000000600, ran: 1700000000650, completed: 1700000000700 },
        },
      ],
    },
  ]
}

function v2Write() {
  return [
    { type: "user", id: "m1", time: { created: 1700000000000 }, text: "write the script" },
    {
      type: "assistant",
      id: "m2",
      time: { created: 1700000000500, completed: 1700000000800 },
      model: { id: "test-model", providerID: "test-provider" },
      finish: "stop",
      content: [
        {
          type: "tool",
          id: "t1",
          name: "write",
          state: {
            status: "completed",
            input: { path: "/tmp/proj/src/track.js", content: "const x = 1\nconst y = 2" },
            metadata: { truncated: false },
          },
          time: { created: 1700000000600, ran: 1700000000650, completed: 1700000000700 },
        },
      ],
    },
  ]
}

describe("V2 native tool payloads", () => {
  test("edit uses input.path and metadata.files[].patch", async () => {
    const conv = await loadConversation(session as any, normalizeV2Messages(v2Edit() as any), { redact: true })
    const tool = conv.messages.flatMap((m) => m.items).find((i) => i.kind === "tool")
    expect(tool?.kind).toBe("tool")
    if (tool?.kind === "tool") {
      expect(tool.filePath).toBe("/tmp/proj/app/TrackingController.php")
      expect(tool.diff).toContain("@@ -1,2 +1,2 @@")
      expect(tool.additions).toBe(1)
      expect(tool.deletions).toBe(1)
    }
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).toContain('class="edit-diff"')
    expect(doc).toContain('class="diff-hunk"')
    expect(doc).toContain('edit-file">/tmp/proj/app/TrackingController.php')
    expect(doc).not.toContain(">Input</div>")
  })

  test("write uses input.path for the card and synthesized diff", async () => {
    const conv = await loadConversation(session as any, normalizeV2Messages(v2Write() as any), { redact: true })
    const tool = conv.messages.flatMap((m) => m.items).find((i) => i.kind === "tool")
    expect(tool?.kind).toBe("tool")
    if (tool?.kind === "tool") {
      expect(tool.filePath).toBe("/tmp/proj/src/track.js")
      expect(tool.content).toContain("const y = 2")
      expect(tool.input).toBe("/tmp/proj/src/track.js")
    }
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).toContain('edit-file">/tmp/proj/src/track.js')
    expect(doc).toContain("@@ -0,0 +1,2 @@")
  })
})

describe("V2 file attachments", () => {
  test("inline user image is embedded as a data URI", async () => {
    const messages = [
      {
        type: "user",
        id: "m1",
        time: { created: 1700000000000 },
        text: "look at this",
        files: [{ data: "aGVsbG8=", mime: "image/png", source: { type: "inline" }, name: "shot.png" }],
      },
    ]
    const conv = await loadConversation(session as any, normalizeV2Messages(messages as any), { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).toContain('src="data:image/png;base64,aGVsbG8="')
  })

  test("URI user file keeps its name and link", async () => {
    const messages = [
      {
        type: "user",
        id: "m1",
        time: { created: 1700000000000 },
        text: "see the doc",
        files: [{ mime: "text/plain", source: { type: "file", uri: "file:///tmp/proj/notes.txt" }, name: "notes.txt" }],
      },
    ]
    const conv = await loadConversation(session as any, normalizeV2Messages(messages as any), { redact: true })
    const file = conv.messages.flatMap((m) => m.items).find((i) => i.kind === "file")
    expect(file?.kind).toBe("file")
    if (file?.kind === "file") {
      expect(file.filename).toBe("notes.txt")
      expect(file.url).toBe("file:///tmp/proj/notes.txt")
    }
  })

  test("tool result file content becomes an attachment, not JSON output", async () => {
    const messages = [
      { type: "user", id: "m1", time: { created: 1 }, text: "render it" },
      {
        type: "assistant",
        id: "m2",
        time: { created: 2 },
        model: { id: "test-model", providerID: "test-provider" },
        content: [
          {
            type: "tool",
            id: "t1",
            name: "screenshot",
            state: {
              status: "completed",
              input: {},
              content: [
                { type: "text", text: "captured" },
                { type: "file", mime: "image/png", name: "out.png", data: "aGVsbG8=", source: { type: "inline" } },
              ],
            },
            time: {},
          },
        ],
      },
    ]
    const conv = await loadConversation(session as any, normalizeV2Messages(messages as any), { redact: true })
    const tool = conv.messages.flatMap((m) => m.items).find((i) => i.kind === "tool")
    expect(tool?.kind).toBe("tool")
    if (tool?.kind === "tool") {
      expect(tool.output).toBe("captured")
      expect(tool.attachments).toHaveLength(1)
      expect(tool.attachments[0]).toMatchObject({ mime: "image/png", filename: "out.png" })
      expect(tool.attachments[0].dataUri).toBe("data:image/png;base64,aGVsbG8=")
    }
  })
})

describe("V2 self-exclusion mixed turns", () => {
  test("keeps assistant explanation and drops only the export call", async () => {
    const messages = [
      { type: "user", id: "m1", time: { created: 1 }, text: "Export this conversation to a single-file, offline-portable HTML report using the `export_html` tool." },
      {
        type: "assistant",
        id: "m2",
        time: { created: 2 },
        model: { id: "test-model", providerID: "test-provider" },
        content: [
          { type: "text", text: "Here is the report you asked for." },
          {
            type: "tool",
            id: "t1",
            name: "export_html",
            state: { status: "completed", input: {}, content: [{ type: "text", text: "done" }] },
            time: {},
          },
        ],
      },
    ]
    const conv = await loadConversation(session as any, normalizeV2Messages(messages as any), { redact: true })
    expect(conv.messages).toHaveLength(1)
    const items = conv.messages[0].items
    expect(items.some((i) => i.kind === "tool")).toBe(false)
    expect(items.some((i) => i.kind === "annotation")).toBe(false)
    const text = items.filter((i) => i.kind === "text").map((i) => (i as any).html).join(" ")
    expect(text).toContain("Here is the report you asked for.")
  })
})

describe("header escaping", () => {
  test("model id cannot inject raw HTML into the report", async () => {
    const evil = { ...session, model: { id: "<img src=x onerror=alert(1)>", providerID: "test" } }
    const messages = [{ type: "user", id: "m1", time: { created: 1 }, text: "hi" }]
    const conv = await loadConversation(evil as any, normalizeV2Messages(messages as any), { redact: true })
    const doc = await renderDocument(conv, {}, "/tmp/proj")
    expect(doc).not.toContain("<img src=x onerror=alert(1)>")
    expect(doc).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })
})
