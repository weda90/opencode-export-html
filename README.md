# opencode-export-html

An [OpenCode](https://opencode.ai) plugin that exports the current conversation to a single, offline-portable HTML report. All CSS/JS/theme are inlined and local images are embedded as data URIs, so the file is self-contained and opens in any browser.

## Features

- **Self-contained output** — one `.html` file, no external assets, works offline.
- **Chat transcript** — user/assistant messages, tool calls, and reasoning (thinking) blocks rendered for review and learning.
- **Code highlighting** — code blocks are syntax-highlighted.
- **Redaction (on by default)** — obvious secrets (API keys, tokens, `{env:VAR}` refs) are redacted before export.
- **Self-exclusion** — `/export-html` invocations (the command prompt and `export_html` tool calls) are stripped from the report, so exports never contain themselves.
- **Themes** — `light`, `dark`, or `auto`.

## Install

Copy the plugin into your OpenCode config and register it:

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/export-html.ts ~/.config/opencode/plugins/
```

Add it to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["./plugins/export-html.ts"]
}
```

## Usage

The plugin registers an `export_html` tool. You can also install the bundled slash command:

```bash
mkdir -p ~/.config/opencode/command
cp command/export-html.md ~/.config/opencode/command/
```

Then in a session run:

```bash
/export-html
```

Or invoke the tool with options:

| Option | Description |
|--------|-------------|
| `--output <path>` | Output file path |
| `--theme dark\|light\|auto` | Color theme |
| `--include-reasoning` | Include thinking/reasoning blocks |
| `--include-files` | Embed local files as data URIs |
| `--no-redact` | Disable secret redaction |
| `--title <text>` | Override report title |

Default output is `./exports/<title>-<timestamp>.html`, or whichever path the tool/tool caller provides.

## Development

```bash
bun install
bun test          # runs plugin-tests/export-html.test.ts
```

Tests use `bun:test` and cover slugify, HTML escaping, markdown rendering, redaction, and document rendering.

## Layout

```
plugins/export-html.ts          # the plugin
plugin-tests/export-html.test.ts # bun tests
plugin-tests/fixtures/           # test fixtures
command/export-html.md           # /export-html slash command
```

## License

MIT
