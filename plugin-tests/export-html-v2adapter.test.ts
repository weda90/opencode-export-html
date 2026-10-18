import { describe, expect, test } from "bun:test"
import { loadConversation, normalizeV2Messages } from "../plugins/export-html.ts"

const session = {
  id: "ses_v2test",
  title: "V2 shape session",
  model: { id: "test-model", providerID: "test-provider" },
  agent: "build",
  time: { created: 1700000000000, updated: 1700000001000 },
  tokens: { input: 10, output: 20, reasoning: 0 },
  cost: 0,
}

const v2messages = [
  { type: "user", id: "m1", time: { created: 1700000000000 }, text: "What is 2+2?" },
  {
    type: "assistant",
    id: "m2",
    time: { created: 1700000000500, completed: 1700000000800 },
    agent: "build",
    model: { id: "test-model", providerID: "test-provider" },
    finish: "stop",
    content: [
      { type: "text", text: "It is **4**." },
      { type: "reasoning", text: "simple arithmetic" },
      {
        type: "tool",
        id: "t1",
        name: "bash",
        state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] },
        time: { created: 1 },
      },
    ],
  },
  { type: "system", id: "m0", time: { created: 1 }, text: "should be skipped" },
]

describe("normalizeV2Messages", () => {
  test("passes legacy {info,parts} shapes through", () => {
    const legacy = [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }]
    expect(normalizeV2Messages(legacy as any)).toEqual(legacy)
  })

  test("maps V2 user and assistant variants", () => {
    const out = normalizeV2Messages(v2messages as any)
    expect(out.length).toBe(2)
    expect(out[0].info.role).toBe("user")
    expect(out[0].parts[0]).toMatchObject({ type: "text" })
    expect(out[1].info.role).toBe("assistant")
    expect(out[1].info.modelID).toBe("test-model")
    const kinds = out[1].parts.map((p) => p.type)
    expect(kinds).toContain("text")
    expect(kinds).toContain("reasoning")
    expect(kinds).toContain("tool")
  })

  test("normalized output renders through loadConversation", async () => {
    const conv = await loadConversation(session as any, normalizeV2Messages(v2messages as any), { redact: true })
    expect(conv.meta.title).toBe("V2 shape session")
    expect(conv.stats.tools).toBe(1)
    expect(conv.messages.length).toBe(2)
  })

  test("tool error state maps to error status", async () => {
    const msgs = [
      {
        type: "assistant",
        id: "m9",
        time: { created: 1 },
        model: { id: "m", providerID: "p" },
        content: [
          { type: "tool", id: "t9", name: "bash", state: { status: "error", input: {}, error: { message: "boom" } }, time: {} },
        ],
      },
    ]
    const conv = await loadConversation(session as any, normalizeV2Messages(msgs as any), { redact: true })
    expect(conv.stats.errors).toBe(1)
  })
})
