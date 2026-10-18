import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import {
  checkExportStatus,
  EXPORT_STATUS_FILE,
  statusKey,
  watchExportStatus,
} from "../plugins/export-html-tui-run.ts"

type Toast = { title?: string; message: string; variant?: string }

function fakeContext(toasts: Toast[]) {
  return { ui: { toast: { show: (toast: Toast) => toasts.push(toast) } } } as any
}

describe("export status toasts", () => {
  test("shows start, success, and error toasts once per status", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "export-tui-"))
    const file = path.join(dir, EXPORT_STATUS_FILE)
    const toasts: Toast[] = []
    const context = fakeContext(toasts)

    try {
      await writeFile(file, JSON.stringify({ status: "running", started: 100 }))
      let key = await checkExportStatus(context, file, "")
      expect(key).toBe(statusKey({ status: "running", started: 100 }))
      expect(toasts.at(-1)?.message).toContain("Exporting")
      expect(toasts.at(-1)?.variant).toBe("info")

      await writeFile(file, JSON.stringify({ status: "done", started: 100, file: "/tmp/report.html" }))
      key = await checkExportStatus(context, file, key)
      expect(toasts.at(-1)?.message).toBe("/tmp/report.html")
      expect(toasts.at(-1)?.variant).toBe("success")

      const count = toasts.length
      await checkExportStatus(context, file, key)
      expect(toasts.length).toBe(count)

      await writeFile(file, JSON.stringify({ status: "error", started: 200, message: "boom" }))
      await checkExportStatus(context, file, key)
      expect(toasts.at(-1)?.message).toBe("boom")
      expect(toasts.at(-1)?.variant).toBe("error")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("watchExportStatus polls until a new status appears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "export-tui-"))
    const file = path.join(dir, EXPORT_STATUS_FILE)
    const toasts: Toast[] = []
    const context = fakeContext(toasts)
    const stop = watchExportStatus(context, () => file, "", 10)

    try {
      await writeFile(file, JSON.stringify({ status: "done", started: 1, file: "/tmp/report.html" }))
      await sleep(50)
      expect(toasts.some((toast) => toast.variant === "success" && toast.message === "/tmp/report.html")).toBe(true)
    } finally {
      stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
