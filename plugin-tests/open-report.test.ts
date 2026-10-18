import { describe, expect, test } from "bun:test"
import { openCommand } from "../plugins/open-report.ts"

describe("openCommand", () => {
  test("uses open on macOS", () => {
    expect(openCommand("/tmp/report.html", "darwin")).toEqual(["open", ["/tmp/report.html"]])
  })

  test("uses xdg-open on Linux", () => {
    expect(openCommand("/tmp/report.html", "linux")).toEqual(["xdg-open", ["/tmp/report.html"]])
  })

  test("uses cmd start on Windows", () => {
    expect(openCommand("C:\\report.html", "win32")).toEqual(["cmd", ["/c", "start", "", "C:\\report.html"]])
  })
})
