# export-html V2 migration and feature port — implementation plan

## Context

`opencode-export-html` currently ships a V1 plugin (`@opencode-ai/plugin` 1.18.25,
`tool()` helper, `hooks["chat.params"]`) that has features the locally installed
V2 port lacks: an OpenCode-style split diff renderer for `edit`/`apply_patch`/
`write` tools and self-exclusion of `/export-html` turns.

The globally installed plugin at `~/.config/opencode/plugins/export-html.ts`
is a V2 port (`@opencode/plugin`, `Plugin.define`, `ctx.tool.transform`,
`ctx.session.context`) but predates the diff renderer and self-exclusion.

Goal: port the two missing features into the V2 implementation, make the repo's
`main` the V2 source of truth, and tag both API generations so V1 users keep a
checkout point.

## Global Constraints

- Do not invent OpenCode APIs. V2 source of truth: `@opencode/plugin@2.0.32`
  typings and <https://opencode.ai/v2/docs/build/plugins>.
- Keep the V1 code reachable through tag `v1.0.0`; do not rewrite history.
- All tests run with `bun test`. Typecheck with the repo's `tsc`.
- Diff renderer output must stay HTML-escaped and self-contained (no external
  assets, exactly one inline `<script>`).
- Self-exclusion: the `/export-html` prompt and every `export_html` tool part
  are absent from generated reports.
- Working directory for repo work: `~/Code/opencode_project/opencode-export-html`.
- The installed plugin copy at `~/.config/opencode/plugins/export-html.ts` must
  match the repo plugin at the end.

## Pre-flight

- Repo `main` is clean at `04cd9b8`; remote `origin/main` is identical.
- `v1.0.0` tag is created at `04cd9b8` before Task 1.
- Config tests and repo tests both import `../plugins/export-html.ts`; the repo
  test file is the superset (diff/self-export fixtures already present).
- Ruling: implementation proceeds on `main` because the deliverable is release
  tags on this repo and the human partner directed the commit/tag flow. Cost if
  wrong: history moves to a branch instead of landing directly.

# Task 1 — Diff and self-exclusion tests in the installed V2 plugin (RED)

## Produces

`~/.config/opencode/plugin-tests/export-html.test.ts` grows coverage for:

- `isExportHtmlPrompt` (export-command detection, role-aware).
- `loadConversation` capturing `diff`/`filePath`/`content`/`additions`/`deletions`
  from `edit` and `write` tool state, replacing the raw write input with the path.
- self-export stripping: export turn dropped, `export_html` tool part dropped,
  prompt text dropped.
- `renderDocument` emitting the split diff markup (`edit-diff`, `diff-hunk`,
  `diff-num old remove`, `diff-num new add`) and no raw `Input` block for
  edit/write.

Fixtures `edit.json`, `write.json`, `self-export.json` are copied from the repo
into `~/.config/opencode/plugin-tests/fixtures/`.

## Steps

1. Copy the three fixtures from the repo into the config fixtures directory.
2. Append the diff/self-export test blocks from
   `~/Code/opencode_project/opencode-export-html/plugin-tests/export-html.test.ts`
   to the config test file, and add `isExportHtmlPrompt` to its imports.
3. Run the config suite.

Expected: failures only for the new assertions — missing `isExportHtmlPrompt`
export (`SyntaxError`/`undefined`), missing `edit-diff` markup, and self-export
turns still present. The 27 existing tests stay green.

# Task 2 — Implement the port in the installed V2 plugin (GREEN)

## Consumes

Task 1's tests and fixtures.

## Produces

`~/.config/opencode/plugins/export-html.ts`:

- `ToolRender` gains `diff?`, `filePath?`, `content?`, `additions?`, `deletions?`.
- `isExportHtmlPrompt(text, role?)` exported; `EXPORT_PROMPT_MARKERS` constant.
- `loadConversation` extracts and redacts diff/content, sets `input` to the file
  path for `write`, skips export turns and `export_html` parts, skips the
  export prompt text.
- CSS for `.edit-diff`, `.diff-split`, `.diff-row`, `.diff-num`, `.diff-code`,
  `.diff-gutter`, `.diff-hunk`, and the mobile grid override.
- `detectLanguage`, `countDiffStats`, `parseDiffHunks`, `highlightDiffLine`,
  `renderDiffRow`, `renderSplitDiff`, `synthesizeWriteDiff`.
- `renderConversation` renders `edit`/`apply_patch`/`write` as a collapsed diff
  card and keeps the generic input card for everything else.
- Type fix: `mod.default` access on `marked` is cast through `any` so `tsc`
  no longer reports `TS2551` (runtime fallback to `mod.marked` is unchanged).

## Steps

1. Apply the implementation edits (types, CSS, loader, renderer, helper).
2. Run the config suite.
   Expected: all export-html tests pass, 0 failures.
3. Typecheck the installed plugin.
   Expected: one pre-existing `marked` `TS2551` error before step 1; none after.

# Task 3 — Migrate the repo to V2 with the ported features

## Produces

Repo files:

- `plugin-tests/export-html-v2.test.ts` and `plugin-tests/export-html-v2adapter.test.ts`
  (V2 plugin shape and V2 message adapter coverage).
- `plugin-tests/export-html.test.ts` no longer imports the V1-only
  `extractMessageText`; diff/self-export coverage stays.
- `plugins/export-html.ts` replaced by the Task 2 implementation.
- `package.json`: `@opencode/plugin@2.0.32`; keep `highlight.js`, `marked`,
  `sanitize-html`; add `@types/node` dev dependency.
- `tsconfig.json`: `types: ["node"]`, no V1 plugin types.
- `README.md`: V2 install/registration, version tag table, dev commands.

## Steps

1. Add the V2 test files and update the main test file imports; run the suite.
   Expected RED: V2 shape tests fail (default export has no `id`; no
   `normalizeV2Messages` import) while diff/self-export tests pass.
2. Copy the Task 2 plugin over `plugins/export-html.ts`; update `package.json`,
   `tsconfig.json`, `README.md`.
3. `bun install`.
4. Run `bun test`.
   Expected: all tests pass, 0 failures.
5. Run `bunx tsc --noEmit` (or the repo `tsc`).
   Expected: clean.
6. Commit the migration.

# Task 4 — Release tags and final verification

## Steps

1. Run the full repo suite and typecheck once more.
   Expected: green.
2. Create annotated tag `v2.0.0` on the migration commit.
3. Confirm `v1.0.0` points at `04cd9b8` and `v2.0.0` at the migration commit.
4. Stop before pushing; ask the human partner to confirm the push of `main`
   plus both tags.

## Review Focus

- Diff HTML injection: tool diff lines must be escaped/highlighted, never raw.
- Self-exclusion edge cases: assistant turns whose only content is the export
  tool; user text that merely mentions `export_html`.
- V2 message adapter: legacy `{info, parts}` pass-through and tool state mapping
  (`completed`, `error`, pending).
- Installed config plugin and repo plugin stay byte-identical.
