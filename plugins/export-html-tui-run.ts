import { promises as fs } from "node:fs"
import type { Context } from "@opencode/plugin/tui/context"

export const EXPORT_STATUS_FILE = ".export-session.json"

export type ExportStatus =
  | { status: "running"; started: number }
  | { status: "done"; started: number; file: string; messages?: number; tools?: number }
  | { status: "error"; started: number; message: string }

export function statusKey(status: ExportStatus): string {
  return `${status.started}:${status.status}`
}

export async function readExportStatus(file: string): Promise<ExportStatus | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as ExportStatus
  } catch {
    return undefined
  }
}

export async function checkExportStatus(
  context: Pick<Context, "ui">,
  file: string,
  lastKey: string,
): Promise<string> {
  const status = await readExportStatus(file)
  if (!status) return lastKey
  const key = statusKey(status)
  if (key === lastKey) return lastKey

  if (status.status === "running") {
    context.ui.toast.show({ title: "Export", message: "Exporting session...", variant: "info", duration: 3000 })
  } else if (status.status === "done") {
    context.ui.toast.show({ title: "Export complete", message: status.file, variant: "success", duration: 8000 })
  } else {
    context.ui.toast.show({ title: "Export failed", message: status.message, variant: "error", duration: 8000 })
  }
  return key
}

export function watchExportStatus(
  context: Pick<Context, "ui">,
  statusFile: () => string | undefined,
  initialKey = "",
  intervalMs = 100,
): () => void {
  let lastKey = initialKey
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        const file = statusFile()
        if (file) lastKey = await checkExportStatus(context, file, lastKey)
      } catch {
        // Status polling must never break the TUI.
      } finally {
        busy = false
      }
    })()
  }, intervalMs)
  return () => clearInterval(timer)
}
