import { spawn } from "node:child_process"

export function openCommand(file: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [file]]
  if (platform === "win32") return ["cmd", ["/c", "start", "", file]]
  return ["xdg-open", [file]]
}

export function openReport(file: string): void {
  const [command, args] = openCommand(file)
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Opening the report is best-effort.
  }
}
