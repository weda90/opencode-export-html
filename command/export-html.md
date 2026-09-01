---
description: Export this conversation to a single-file HTML report
---

Call the `export_html` tool once to export this conversation to a single-file, offline-portable HTML report with these `$ARGUMENTS` mapped to its parameters, then reply with the absolute path and the export stats it returns.

- `--output <path>`  ->  output
- `--theme dark|light|auto`  ->  theme
- `--include-reasoning`  ->  includeReasoning: true
- `--include-files`  ->  includeFiles: true
- `--no-redact`  ->  redact: false
- `--title <text>`  ->  title

Do not invent session IDs or file paths. The tool picks a sensible default output (`./exports/<title>-<timestamp>.html`) when `output` is omitted. Call the tool immediately, no preamble, no commentary.