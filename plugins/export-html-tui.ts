import { Plugin } from "@opencode/plugin/tui"
import * as path from "node:path"
import { EXPORT_STATUS_FILE, readExportStatus, statusKey, watchExportStatus } from "./export-html-tui-run"

export default Plugin.define({
  id: "export-html.tui",
  async setup(context) {
    const statusFile = () => {
      const route = context.ui.router.current()
      if (route.type !== "session") return undefined
      const session = context.data.session.get(route.sessionID)
      const directory = session?.location?.directory ?? context.data.session.root(route.sessionID)
      return path.join(directory, "exports", EXPORT_STATUS_FILE)
    }
    const current = statusFile()
    const status = current ? await readExportStatus(current) : undefined
    return watchExportStatus(context, statusFile, status ? statusKey(status) : "")
  },
})
