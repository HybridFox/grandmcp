# grandmcp

MCP server (TypeScript, Node 24) plus a Lua plugin that runs inside grandMA3 onPC. The server talks to the
plugin over newline-delimited JSON on TCP 127.0.0.1:9810. See README.md for the user-facing picture.

## Layout

- `plugin/grandmcp.lua` / `.xml`: the bridge. Socket loop, op dispatch, all grandMA3 access. Lua 5.5.
- `src/index.ts`: MCP entry. `serveStdio` takes a factory and may build a server per request, so long-lived state
  (bridge socket, stored plans, library cache, write queue) lives in `src/context.ts`, never in the factory.
- `src/bridge/`: NDJSON client (`client.ts`) and the plugin's response shapes (`types.ts`).
- `src/patch/`: pure logic, no console access. `schema.ts` (fixture-list input), `planner.ts` (IDs, addresses,
  conflicts), `changes.ts` (changes to existing fixtures, judged on the final state), `library.ts` (fuzzy catalog search).
- `src/tools/`: one `registerXTools(server, ctx)` per area (status, inspect, library, patch, move, groups, presets,
  sequences, manual). `result.ts` holds `ok` / `failure` / `fromError`.
- `src/prompts/`: MCP prompts.
- `scripts/`: `probe.ts` (dev CLI), `install-plugin.ts`, `smoke.ts` (end-to-end through a real MCP client).
- `docs/ma3/`: verified grandMA3 facts (`probe-notes.md`) and the `HelpLua` API dump for 2.5.1.1.

## Commands

- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: all must pass before work is done.
- `pnpm reload`: copy the plugin into gma3_library and hot-swap it in the running onPC (plugin must run in dev mode).
- `pnpm probe <ping|info|cmd ...|lua ...|raw op json>`: talk to the plugin directly.
- `pnpm test:e2e`: full end-to-end suite through the MCP server against a running onPC (test show, plugin started,
  no pop-up open). Run it after plugin changes and on new grandMA3 versions.
- `pnpm smoke` (read-only) / `pnpm smoke --write --fid N` (test show only): quick end-to-end check.

## Rules

- **Verify grandMA3 behaviour live, don't assume it.** The manual and community posts are often stale (see
  probe-notes). Try it with `pnpm probe lua '...'` against onPC, then record anything non-obvious in
  `docs/ma3/probe-notes.md`.
- **Never write to stdout in the server.** stdout is the MCP channel; `no-console` lint guards this. Scripts may use
  `console.info`.
- **Read the live patch via `ShowData().LivePatch`.** `Patch()` returns the edit copy while one is open, and
  handles taken before a commit are stale after it.
- **Pop-ups are the user's.** Never click, key or otherwise answer an MA pop-up from code (`Mouse`/`Keyboard` exist;
  don't use them for this). Report it with `describeModal` / `failModal` and let the user answer on the console; if a
  flow needs an answer, split it into a start op that returns `pending` and a finish op (see `patch.move`).
- **No dialogs on the plugin thread.** Anything that may open a pop-up goes through `CmdIndirect` and is polled
  (`waitDestination`). Writes call `guardIdle()` first.
- **Writes are plan → review → apply.** New write tools check `ctx.allowWrite`, run inside `ctx.serialize`, and
  back up or verify state. Once a commit happened, report "committed but unverified" rather than an error.
- **A timeout after sending is an unknown outcome.** Never retry a write automatically (`BridgeError.outcome`).
- **Write show data as MA XML and verify it.** Groups, presets and sequences are generated XML imported into the pool
  slot (no programmer, no dialogs); after import, read back (`GetPresetData`, exports, object properties) and report
  mismatches instead of assuming success.
- **Keep pure logic pure.** Planning and searching stay in `src/patch/` with unit tests; tools only fetch and format.
- Code style: tabs, single quotes, width 160 (prettier + eslint config from the repo). `erasableSyntaxOnly` is on,
  so no enums, namespaces or constructor parameter properties: Node runs the sources without a build.
- Bump `VERSION` in `plugin/grandmcp.lua` and `Version` in `plugin/grandmcp.xml` together when the plugin changes,
  and update the version in the README's setup step.
- This repo is public. Never commit show files, customer documents or other third-party data (test with
  generic fixture names), and no personal paths or hostnames in docs.
- Update README.md (tools table, limitations) and this file when behaviour or layout changes.
