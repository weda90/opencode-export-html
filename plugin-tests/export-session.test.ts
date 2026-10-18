import { describe, expect, test } from "bun:test"
import { parseExportArgs } from "../plugins/export-html.ts"

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

  test("rejects bare arguments", () => {
    expect(() => parseExportArgs("hello")).toThrow(/Unexpected argument/)
  })
})
