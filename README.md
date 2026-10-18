# opencode-export-html

An [OpenCode](https://opencode.ai) plugin that exports the current conversation to a single, offline-portable HTML report. All CSS/JS/theme are inlined and local images are embedded as data URIs, so the file is self-contained and opens in any browser.

## Features

- **Self-contained output** — one `.html` file, no external assets, works offline.
- **Chat transcript** — user/assistant messages, tool calls, and reasoning (thinking) blocks rendered for review and learning.
- **Split diff cards** — `edit`, `apply_patch`, and `write` tool calls render as side-by-side diffs with syntax highlighting.
- **Code highlighting** — code blocks and tool output are syntax-highlighted.
- **Redaction (on by default)** — obvious secrets (API keys, tokens, `{env:VAR}` refs) are redacted before export.
- **Direct command** — `/export-session` exports immediately without a prompt, a model turn, or a session entry.
- **TUI progress and browser open:** the TUI companion shows an `Exporting session...` toast, then the saved path, and opens the report.
- **Full history after compaction:** the exporter reads the stored transcript instead of only the active post-compaction context.
- **Self-exclusion** — legacy `/export-html` invocations (the command prompt and `export_html` tool calls) are stripped from the report, so exports never contain themselves.
- **Themes** — `light`, `dark`, or `auto`.

## Versions

| Tag | OpenCode | Plugin API | Package |
|-----|----------|------------|---------|
| `v2.0.0` | V2 (2.0.x) | `@opencode/plugin` | `@opencode/plugin` |
| `v1.0.0` | V1 (1.x) | `@opencode-ai/plugin` | `@opencode-ai/plugin` |

`main` tracks the V2 plugin. V1 stays available at tag `v1.0.0`:

```bash
git checkout v1.0.0
```

## Install

Copy the plugin into your OpenCode config and register it:

```bash
mkdir -p ~/.config/opencode/plugins/export-html
cp plugins/export-html.ts ~/.config/opencode/plugins/export-html/index.ts
cp plugins/export-html-tui.ts ~/.config/opencode/plugins/export-html/tui.ts
cp plugins/export-html-tui-run.ts ~/.config/opencode/plugins/export-html/export-html-tui-run.ts
cp plugins/open-report.ts ~/.config/opencode/plugins/export-html/open-report.ts
```

Add it to the `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["./plugins/export-html"]
}
```

## Usage

The plugin registers a direct command and an `export_html` tool. The legacy
`/export-html` prompt command is a separate optional install.

### `/export-session` (direct, nothing appended)

`/export-session` runs through an OpenCode command callback. It does not submit
a prompt, does not run a model turn, and does not append anything to the
session. In the TUI, the companion shows an `Exporting session...` toast, then
the saved path, and opens the report. The command itself stays silent when
called through the API.

```bash
/export-session
/export-session --theme dark --title "Release review"
/export-session --no-open --output ~/Desktop/report.html
/export-session --output ./exports
```

| Option | Description |
|--------|-------------|
| `--output <path>` | Output file (`.html`/`.htm`) or directory (created if missing) |
| `--theme dark\|light\|auto` | Color theme |
| `--include-reasoning` | Include thinking/reasoning blocks |
| `--no-include-files` | Do not embed local files as data URIs (embedding is on by default) |
| `--no-redact` | Disable secret redaction |
| `--title <text>` | Override report title |
| `--open` | Open the report in the default browser (default for `/export-session`) |
| `--no-open` | Do not open the report |

Default output is `./exports/<title>-<timestamp>.html` under the session's
working directory (which may be a git worktree). Use `--output` to place it
elsewhere. A leading `~` expands to your home directory. If `--output` is a
directory (existing, missing, or ending in `/`), the default filename is
written inside it. A path ending in `.html` or `.htm` is treated as a file.

### `/export-html` (legacy, prompt-based)

> Deprecated. This command submits a prompt and adds a model turn plus an
> `export_html` tool call to the session. Use `/export-session` instead.

Install the old command only if you still need it:

```bash
mkdir -p ~/.config/opencode/command
cp command/export-html.md ~/.config/opencode/command/
```

Then:

```bash
/export-html
```

The `export_html` tool remains available to the model with the same options as
JSON tool inputs. Default output is `./exports/<title>-<timestamp>.html`, or
whichever path the tool caller provides. The tool does not open the report.

## Development

```bash
bun install
bun test          # all plugin-tests
bun run typecheck # tsc --noEmit
```

Tests use `bun:test` and cover slugify, HTML escaping, markdown rendering, redaction, document rendering, split diffs, self-exclusion, the V2 message adapter, `/export-session` argument parsing, the no-append command path, the export status file, the TUI toast watcher, and the browser command mapping.

## Layout

```
plugins/export-html.ts               # server plugin
plugins/export-html-tui.ts           # TUI companion
plugins/export-html-tui-run.ts       # TUI status watcher
plugins/open-report.ts               # platform browser opener
plugin-tests/export-html.test.ts     # core + diff + self-exclusion
plugin-tests/export-html-v2.test.ts  # V2 plugin shape
plugin-tests/export-html-v2adapter.test.ts # V2 message adapter
plugin-tests/export-html-v2-native.test.ts # V2-native tool payloads + attachments
plugin-tests/export-session.test.ts  # command parser + no-append behavior
plugin-tests/export-tui.test.ts      # TUI status watcher + toasts
plugin-tests/open-report.test.ts     # browser command mapping
plugin-tests/fixtures/               # test fixtures
command/export-html.md               # legacy /export-html slash command
```

## License

MIT
