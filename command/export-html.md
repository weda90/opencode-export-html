---
description: Export this conversation to a single-file HTML report
agent: build
---

Export the current conversation to a single-file, offline-portable HTML report using the `export_html` tool.

Map these `$ARGUMENTS` to the tool parameters where present:
- `--output <path>`  ->  output
- `--theme dark|light|auto`  ->  theme
- `--include-reasoning`  ->  includeReasoning: true
- `--include-files`  ->  includeFiles: true
- `--no-redact`  ->  redact: false
- `--title <text>`  ->  title

The `export_html` tool already knows the current session and computes a sensible default output path (`./exports/<title>-<timestamp>.html`). Do not invent session IDs or file paths. After the tool runs, reply with the absolute path of the generated file and the export stats it returns.