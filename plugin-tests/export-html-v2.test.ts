import { describe, expect, test } from "bun:test"
import mod from "../plugins/export-html.ts"

describe("export-html plugin V2 shape", () => {
  test("default export has id and setup", () => {
    expect((mod as any)?.id).toBe("export-html")
    expect(typeof (mod as any)?.setup).toBe("function")
  })

  test("setup registers export_html tool via ctx.tool.transform", async () => {
    let editor: any = null
    const added: any[] = []
    const ctx: any = {
      location: { directory: "/tmp/proj" },
      session: { get: async () => ({}), context: async () => [] },
      tool: {
        transform: async (fn: any) => {
          editor = {
            add: (t: any) => added.push(t),
            list: () => [],
            get: () => undefined,
            update: () => {},
            remove: () => {},
            namespace: () => {},
          }
          fn(editor)
        },
      },
    }
    await (mod as any).setup(ctx)
    const tool = added.find((t) => t.name === "export_html")
    expect(tool).toBeDefined()
    expect(tool.description).toContain("HTML")
    expect(tool.input?.type).toBe("object")
  })
})
