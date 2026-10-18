# export-session direct command — implementation plan

## Context

The existing `/export-html` markdown command is a prompt template. Invoking it
submits a durable user prompt, runs a model turn, and records an `export_html`
tool call. The session grows on every export even though the generated HTML
hides those parts.

Goal: add `/export-session`, a server command callback registered with
`ctx.command.transform`. It runs immediately, exports the current session to the
same single-file HTML, and never calls `ctx.session.prompt` or
`ctx.session.synthetic`, so nothing is appended.

The existing `/export-html` markdown command stays for compatibility and is
marked deprecated. The `export_html` tool stays for model-driven use.

## Global constraints

- V2 only. Source of truth: installed `@opencode/plugin@2.0.32` typings and
  <https://opencode.ai/v2/docs/build/plugins>.
- TDD for every production change: write the failing test, watch it fail,
  implement, watch it pass.
- `bun test` and `bun run typecheck` must stay green.
- No changes to the report HTML/CSS/JS design.
- No session prompt, no synthetic message, no model turn from the direct
  command.
- Worktree: `/Users/weda90/.local/share/opencode/worktree/12b606/export-session-command`
  on branch `feat/export-session-command`.

## Pre-flight

- Baseline: 43 tests pass, 0 fail; `tsc --noEmit` clean at `0fb5027`.
- `command/export-html.md` and `plugins/export-html.ts` exist as described.
- `@opencode/plugin` exposes `ctx.command.transform`, `CommandDefinition`,
  and `CommandInvocation` with `sessionID`, `prompt`, `delivery`.

# Task 1 — `parseExportArgs`

## Produces

`plugins/export-html.ts` exports:

```ts
export function parseExportArgs(text: string): ExportOptions
```

Supported syntax:

- `--output <path>` or `--output=<path>`
- `--theme dark|light|auto` or `--theme=<value>`
- `--include-reasoning`
- `--no-include-files`
- `--no-redact`
- `--title <text>` or `--title=<text>`
- Quoted values (`"..."` or `'...'`) are one token.
- Unknown options throw `Error` naming the option.
- Empty text returns `{}`.

Tests in `plugin-tests/export-session.test.ts` cover every flag, the `=` form,
quoted titles, defaults, and the unknown-option error.

## Steps

1. Write the failing tests. Run `bun test plugin-tests/export-session.test.ts`.
   Expected: RED because `parseExportArgs` is not exported.
2. Add the parser and export it. Run the test file.
   Expected: GREEN.
3. Run the full suite. Expected: all existing tests still pass.

# Task 2 — Register `export-session`

## Consumes

`parseExportArgs` from Task 1.

## Produces

In `plugins/export-html.ts` `setup()`, after the tool transform:

```ts
await ctx.command.transform((editor) => {
  editor.add({
    name: "export-session",
    description: "...",
    async execute({ sessionID, prompt }) {
      const opts = parseExportArgs(prompt.text)
      await exportCurrentSessionV2(ctx, sessionID, opts)
    },
  })
})
```

No `ctx.session.prompt`, no `ctx.session.synthetic`.

Tests:

- `setup()` registers both `export_html` and `export-session`.
- Invoking the command writes the HTML and does not call a `session.prompt`
  spy or a `session.synthetic` spy.
- Invoking with `--theme dark --title "Demo"` writes HTML containing the dark
  theme and the title.
- An unknown option rejects and writes no file.

## Steps

1. Add the registration and no-append tests. Run the file.
   Expected: RED because no command is registered.
2. Add the `ctx.command.transform` registration. Run the file.
   Expected: GREEN.
3. Run the full suite and typecheck.

# Task 3 — Docs and version

## Produces

- `README.md`: `/export-session` primary usage, flags table, default output
  path, explicit no-append statement, legacy note for `/export-html`.
- `command/export-html.md`: frontmatter description marked deprecated, points
  to `/export-session`. Prompt body unchanged.
- `package.json`: version `2.1.0`.

No production behavior changes, so no new tests. Run the full suite after the
edits to prove the docs/build files did not break anything.

# Task 4 — Runtime verification (requires consent)

## Steps

1. Ask before copying the plugin to `~/.config/opencode/plugins/` and running
   `opencode reload`; this modifies the user's global OpenCode setup.
2. `opencode api get /api/command` lists `export-session`.
3. In a scratch session, record the message count, run `/export-session`, and
   confirm the count is unchanged.
4. Run `/export-session --theme dark --title Demo` and confirm the file.
5. Confirm `/export-html` still behaves as before.

If the TUI does not surface the command, or the callback appends anything,
stop and report. The fallback is a TUI plugin command, not a workaround.

## Review focus

- Parser rejects unknown flags and never silently drops a value.
- The command callback has no path that prompts or synthesizes messages.
- The no-append test asserts behavior, not mock calls alone.
- Default output path and `includeFiles`/`redact` defaults match the tool.
- Docs do not claim the deprecated command stopped appending.
