# grandmcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) read and change a running
**grandMA3** show. The first thing it does well is **patching from documents**: hand Claude a fixture report,
equipment list or plot, and it finds the fixture types, works out fixture IDs and DMX addresses, shows you the plan
and patches it after you agree.

> **Status: early.** Tested on grandMA3 onPC 2.5.1.1 on macOS. Windows onPC should work the same way but has not
> been tested yet. Try it on a test show before you point it at anything that matters.
>
> grandmcp is an independent project, not affiliated with or endorsed by MA Lighting. grandMA3 is a trademark of
> MA Lighting Technology GmbH.

## How it works

```
Claude ──MCP (stdio)──▶ grandmcp (Node.js)  ──JSON over TCP 127.0.0.1:9810──▶  grandmcp Lua plugin, inside grandMA3
```

grandMA3 has no network API that can read show data, so grandmcp ships a small Lua plugin that runs inside onPC.
The plugin answers requests from the MCP server over a local socket and uses MA's own Lua API to read the object
tree and edit the patch. It only accepts connections from the same machine.

Patch changes go through MA's patch edit copy, exactly like editing in the Patch menu, and are committed when the
change is complete. MA cannot undo a patch commit, so every apply first exports the current patch to
`gma3_library/patch/grandmcp-backup-<timestamp>.xml`.

## Requirements

- grandMA3 onPC 2.5.x (macOS or Windows)
- Node.js 24 or newer, and [pnpm](https://pnpm.io)

## Setup

1. Install and copy the plugin into your grandMA3 library:

    ```sh
    git clone https://github.com/HybridFox/grandmcp.git
    cd grandmcp
    pnpm install
    pnpm install-plugin
    ```

    `install-plugin` copies `plugin/grandmcp.xml` and `plugin/grandmcp.lua` to
    `~/MALightingTechnology/gma3_library/datapools/plugins` (macOS) or
    `C:\ProgramData\MALightingTechnology\gma3_library\datapools\plugins` (Windows).

2. In grandMA3, on the command line (use a free plugin slot if 1 is taken):

    ```
    Import Plugin Library "grandmcp.xml" At Plugin 1
    Plugin "grandmcp"
    ```

    The command line history should show `grandmcp 0.7.0 listening on 127.0.0.1:9810`. Save the show to keep the
    plugin in it. The plugin has to be started again after loading a show.

3. Add the server to your MCP client. For Claude Code:

    ```sh
    claude mcp add grandmcp -- node /path/to/grandmcp/src/index.ts
    ```

    Writes are off by default. To let Claude change the show, add `-e GRANDMCP_ALLOW_WRITE=1`:

    ```sh
    claude mcp add grandmcp -e GRANDMCP_ALLOW_WRITE=1 -- node /path/to/grandmcp/src/index.ts
    ```

    Other clients (Claude Desktop and others) take the same command: `node /path/to/grandmcp/src/index.ts`. Node 24
    runs the TypeScript sources directly; there is no build step.

4. Ask Claude to check the connection ("what's the status of my console?"), or start a patch with the
   `patch_from_document` prompt.

## Tools

| Tool                                             | What it does                                                                                                                                                           | Writes |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `grandmcp_status`                                | Connection check: software version, host type, show status, open pop-ups                                                                                               |        |
| `grandmcp_get`, `grandmcp_children`              | Read any object in the grandMA3 object tree                                                                                                                            |        |
| `grandmcp_patch_list`                            | Every fixture in the live patch with FID, type, mode, footprint and address                                                                                            |        |
| `grandmcp_fixture_types`                         | Fixture types in the show, with DMX modes and channel counts                                                                                                           |        |
| `grandmcp_fixture_library_search`                | Search the full fixture catalog (MA3, MA2, your files, GDTF Share, Fixture Share) with DMX modes; filter by channel count                                              |        |
| `grandmcp_fixture_type_import`                   | Import a catalog entry into the show (Share entries are downloaded first)                                                                                              | yes    |
| `grandmcp_patch_plan`                            | Work out FIDs and addresses for a fixture list and check every conflict. Changes nothing                                                                               |        |
| `grandmcp_patch_plan_changes`                    | Plan changes to existing fixtures: remove, new FID, rename, re-address or unpatch, new type or mode. Lists where removed or retyped fixtures are used. Changes nothing |        |
| `grandmcp_patch_apply`                           | Back up the patch, apply an add or change plan, commit, read back and verify                                                                                           | yes    |
| `grandmcp_patch_move`                            | Move fixtures under a grouping fixture or back to the top level; reports grandMA3's question for you to answer                                                         | yes    |
| `grandmcp_patch_move_finish`                     | Complete a move after you answered on the console                                                                                                                      | yes    |
| `grandmcp_group_list`                            | Groups in the current data pool with their fixture IDs                                                                                                                 |        |
| `grandmcp_group_store`                           | Create or replace a group with exactly these fixtures, in order                                                                                                        | yes    |
| `grandmcp_group_delete`                          | Delete a group (exported first)                                                                                                                                        | yes    |
| `grandmcp_manual_search`, `grandmcp_manual_read` | Search and read the grandMA3 manual that ships with onPC                                                                                                               |        |

The `patch_from_document` prompt walks Claude through a document-to-patch session.

## Patching from a document

1. Claude reads the document and lists the fixtures, modes and addresses it finds.
2. It checks which fixture types the show already has, and searches grandMA3's fixture catalog for the rest: the MA3
   and MA2 libraries, your own files in `gma3_library/fixturetypes`, and the online GDTF Share and MA Fixture Share
   (about 25,000 types, each with its DMX modes). Documents often use marketing names ("LED 350W BSW Moving Head")
   where the catalog has model codes ("PL-L350CMY"), so Claude also searches by model number and by the channel count
   the document's addresses imply. Only exact matches count as the same fixture; for anything else Claude shows you
   the candidates and asks.
3. Imports from the Shares are downloaded through MA's World Server and also saved in `gma3_library/fixturetypes`.
   After importing, Claude compares the type's real DMX modes with the address gaps in the document (catalog
   footprints are hints, and MA2 types often name modes "Mode 1" and "Mode 2").
4. `grandmcp_patch_plan` checks the whole list against the live patch: free FIDs, overlapping addresses (with the
   show and within the list), universe boundaries and mode footprints. Rows can give a start address (`"1.23"`), use
   `"auto"` for the first free block, or `"none"` to leave fixtures unpatched.
5. You see the plan table. Only after you agree does `grandmcp_patch_apply` write it. The apply is refused if the
   patch changed in the meantime.

## Configuration

| Variable               | Default                  | Meaning                                                         |
| ---------------------- | ------------------------ | --------------------------------------------------------------- |
| `GRANDMCP_ALLOW_WRITE` | off                      | `1` enables tools that change the show                          |
| `GRANDMCP_PORT`        | `9810`                   | Port of the Lua plugin                                          |
| `GRANDMCP_HOST`        | `127.0.0.1`              | Host of the Lua plugin                                          |
| `GRANDMCP_TIMEOUT_MS`  | `15000`                  | Default request timeout                                         |
| `GMA3_LIBRARY`         | OS default               | Path to `gma3_library` (used by `pnpm install-plugin`)          |
| `GMA3_MANUAL_DIR`      | newest installed version | Path to the HTML manual (`gma3_<version>/shared/language/HTML`) |

## Changing existing fixtures

`grandmcp_patch_plan_changes` takes changes by current FID and checks them on the final state, so swaps (two
fixtures trading IDs or addresses) and moves into space another change frees up work. What happens to programming:

- **New FID, rename, re-address, unpatch:** safe. Groups and cues refer to the fixture itself and follow it.
- **Remove:** the fixture disappears from groups, cues and presets that used it. The plan lists those places.
- **New fixture type or mode:** programmed values are kept per attribute; values for attributes the new mode does not
  have are lost. The plan lists where the fixture is used.

The changes are made in one edit session: type and mode first, then IDs, names and addresses, removals last. If
anything fails before the removals, the earlier steps are reverted and nothing changes.

## Grouping fixtures

Some show files organise the patch with grouping fixtures: a fixture of the MA3 library type "Grouping" (no DMX
channels, never patched) with real fixtures under it, for example one per truss. A plan row can create a grouping
fixture (`type: "Grouping"`, `patch: "none"`) and later rows can put new fixtures under it with `parent: <its FID>`, or
under a grouping fixture already in the show. The patch list shows nested fixtures indented under their parent.
Removing a grouping fixture removes the fixtures under it; the plan says so.

`grandmcp_patch_move` moves fixtures that already exist under a grouping fixture, or back to the top level. FIDs,
addresses, names, group membership and cues stay as they are, but grandMA3 moves the relocated fixtures to the end of
the selection order of groups that contain them (re-store the group if the order matters). grandMA3 asks on the console whether the fixtures keep their
absolute 3D position or their offset relative to the new parent: grandmcp reports that question, you answer it on the
console, and `grandmcp_patch_move_finish` commits and verifies (or reports the cancel). Changing the type or mode of a
fixture inside a grouping fixture is not supported yet.

## Groups

`grandmcp_group_store` writes a group as grandMA3's own XML and imports it into the pool slot, so it never touches
the programmer or the current selection. Fixture order is the selection order (what MAtricks and effects follow).
Replacing or deleting a group exports the old one to `gma3_library/datapools/groups` first.

## Safety

- Read-only unless `GRANDMCP_ALLOW_WRITE=1`.
- Patch changes always go plan → user review → apply, and the plan is bound to the patch it was made against.
- grandmcp never answers grandMA3's pop-ups. When the console asks something, the tool reports the question and the
  buttons, and you answer on the console.
- The plugin refuses to write while a pop-up is open or while the command line is inside another editor (for example
  someone in the Patch menu).
- The patch is exported before every apply. Importing that file again **merges**: it restores fixtures that were
  changed or deleted, but does not remove fixtures added since. It is a record to recover from, not a one-click undo.
- There is no tool that runs arbitrary Lua or command-line commands.

## Limitations

- One DMX break per mode (multi-break modes are refused).
- Only fixtures with ID type "Fixture" (no channel IDs yet).
- The catalog is MA's own library listing. The first search of a session loads it from the console (about 20
  seconds for 25,000 entries); it is then cached for 30 minutes. Loading it switches on all sources (MA, user,
  Share) in the fixture import dialog.
- Share imports need the console to reach MA's World Server (internet).
- The plugin only listens on 127.0.0.1. Driving a console on another machine is planned (see below).

## Roadmap

- Presets and executor layouts generated from the patch
- Cues and looks from a description
- Connecting to a console or onPC on another machine (LAN with a token, or a grandMA3 session)

## Development

```sh
pnpm test          # unit tests (planner, library search, bridge client, manual search)
pnpm typecheck
pnpm lint
pnpm format
```

Talking to a running onPC:

- Start the plugin with `Plugin "grandmcp" "dev"` to enable two probe ops, `cmd` and `lua`, for experiments. They
  only listen on 127.0.0.1 and are never exposed as MCP tools. `Plugin "grandmcp" "dev off"` turns them off.
- `pnpm probe ping`, `pnpm probe info`, `pnpm probe lua 'return Patch():Count()'`, `pnpm probe raw patch.list`
- `pnpm reload` copies the plugin into the library and hot-swaps it in the running onPC (needs dev mode).
- `pnpm smoke` runs the MCP server through a real MCP client against onPC. `pnpm smoke --write --fid 301` also
  imports a fixture type and patches three fixtures. Only use that on a test show.

[`docs/ma3/probe-notes.md`](docs/ma3/probe-notes.md) collects what was verified about grandMA3's Lua API and patch
internals, including the behaviour the official manual does not describe.

## License

MIT, see [LICENSE](LICENSE).
