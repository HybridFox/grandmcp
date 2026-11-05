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

    The command line history should show `grandmcp 0.22.0 listening on 127.0.0.1:9810`. Save the show to keep the
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

## Driving grandMA3 on another machine

The MCP server can run on one machine (where Claude runs) and drive onPC or a console on another, for example your
laptop and an onPC with wings on a show PC.

1. On the grandMA3 machine, install the plugin: copy `plugin/grandmcp.xml` and `plugin/grandmcp.lua` into
   `gma3_library/datapools/plugins` (Windows: `C:\ProgramData\MALightingTechnology\gma3_library\datapools\plugins`),
   or run `pnpm install-plugin` there.
2. Import it as in Setup, but start it in network mode:

    ```
    Plugin "grandmcp" "lan"
    ```

    The first start creates a token in `gma3_library/grandmcp-token.txt` on that machine. It stays the same across
    restarts; delete the file to get a new one. (If the plugin is already running locally, stop it first with
    `Plugin "grandmcp" "stop"`.)

3. On the Claude machine, point the MCP server at it:

    ```sh
    claude mcp add grandmcp -e GRANDMCP_HOST=192.168.1.50 -e GRANDMCP_TOKEN=<token> -e GRANDMCP_ALLOW_WRITE=1 \
      -- node /path/to/grandmcp/src/index.ts
    ```

Network clients must send the token before anything else and are dropped otherwise; clients on the grandMA3 machine
itself need no token. The connection is not encrypted, so use it on a trusted show network only. On Windows, allow
onPC through the firewall when asked. Dev ops (`"dev"`) never answer network clients.

## Tools

| Tool                                                                 | What it does                                                                                                                                                           | Writes |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `grandmcp_status`                                                    | Connection check: software version, host type, show status, open pop-ups                                                                                               |        |
| `grandmcp_get`, `grandmcp_children`                                  | Read any object in the grandMA3 object tree                                                                                                                            |        |
| `grandmcp_patch_list`                                                | Every fixture in the live patch with FID, type, mode, footprint and address                                                                                            |        |
| `grandmcp_fixture_types`                                             | Fixture types in the show, with DMX modes and channel counts                                                                                                           |        |
| `grandmcp_fixture_library_search`                                    | Search the full fixture catalog (MA3, MA2, your files, GDTF Share, Fixture Share) with DMX modes; filter by channel count                                              |        |
| `grandmcp_fixture_type_import`                                       | Import a catalog entry into the show (Share entries are downloaded first)                                                                                              | yes    |
| `grandmcp_patch_plan`                                                | Work out FIDs and addresses for a fixture list and check every conflict. Changes nothing                                                                               |        |
| `grandmcp_patch_plan_changes`                                        | Plan changes to existing fixtures: remove, new FID, rename, re-address or unpatch, new type or mode. Lists where removed or retyped fixtures are used. Changes nothing |        |
| `grandmcp_patch_apply`                                               | Back up the patch, apply an add or change plan, commit, read back and verify                                                                                           | yes    |
| `grandmcp_patch_move`                                                | Move fixtures under a grouping fixture or back to the top level; reports grandMA3's question for you to answer                                                         | yes    |
| `grandmcp_patch_move_finish`                                         | Complete a move after you answered on the console                                                                                                                      | yes    |
| `grandmcp_group_list`                                                | Groups in the current data pool with their fixture IDs                                                                                                                 |        |
| `grandmcp_group_store`                                               | Create or replace a group with exactly these fixtures, in order                                                                                                        | yes    |
| `grandmcp_group_delete`                                              | Delete a group (exported first)                                                                                                                                        | yes    |
| `grandmcp_fixture_attributes`                                        | What a fixture type can do: attributes, channel functions, physical ranges, named slots (wheel positions, gel macros, strobe modes)                                    |        |
| `grandmcp_preset_list`                                               | Presets per pool with their fixtures and attributes                                                                                                                    |        |
| `grandmcp_preset_store`                                              | Create or replace a preset from values or effects per fixture, verified after import                                                                                   | yes    |
| `grandmcp_sequence_list`                                             | Sequences with their cues, fade times and triggers                                                                                                                     |        |
| `grandmcp_sequence_store`                                            | Create or replace a sequence whose cues reference presets and/or carry values, with timing and triggers                                                                | yes    |
| `grandmcp_executor_list`                                             | What is assigned to the executors of a page                                                                                                                            |        |
| `grandmcp_executor_assign`                                           | Put a sequence on an executor                                                                                                                                          | yes    |
| `grandmcp_view3d`                                                    | Put grandMA3's 3D window on a screen (adds one if needed) and pick a camera                                                                                            | yes    |
| `grandmcp_executor_configure`                                        | Fader function (Master, Temp, X, Rate, Speed, ...), button functions (Go+, Toggle, Flash, ...) and size of an executor                                                 | yes    |
| `grandmcp_speedmaster_set`                                           | BPM and label of a speed master, optionally on an executor as a tap button                                                                                             | yes    |
| `grandmcp_page_store`                                                | Create and name an executor page (for example one per music style)                                                                                                     | yes    |
| `grandmcp_matricks_list`, `grandmcp_matricks_store`                  | MAtricks pool: blocks, groups, wings, width, shift, invert, phase/fade/delay spreads                                                                                   | store  |
| `grandmcp_preset_read`, `grandmcp_sequence_read`                     | What a preset or sequence contains, in readable terms                                                                                                                  |        |
| `grandmcp_cue_store`, `grandmcp_cue_delete`                          | Add, replace or delete a single cue without rewriting the sequence                                                                                                     | yes    |
| `grandmcp_pool_copy`, `grandmcp_pool_rename`, `grandmcp_pool_delete` | Copy, rename or delete presets, sequences, groups and MAtricks (exported before delete or overwrite)                                                                   | yes    |
| `grandmcp_appearance_list`, `grandmcp_appearance_store`              | Button colours, assigned to presets, sequences, groups or MAtricks                                                                                                     | store  |
| `grandmcp_layout_list`, `grandmcp_layout_store`                      | 2D layout views of fixtures, placed explicitly or from the 3D positions                                                                                                | store  |
| `grandmcp_screenshot`                                                | A screenshot of a grandMA3 screen, rendered by grandMA3 itself                                                                                                         |        |
| `grandmcp_manual_search`, `grandmcp_manual_read`                     | Search and read the grandMA3 manual that ships with onPC                                                                                                               |        |

The `patch_from_document` prompt walks Claude through a document-to-patch session, and `build_busking_show` through
building groups, palettes, effects and executors for playing live, with you deciding the layout.

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

| Variable               | Default                  | Meaning                                                                         |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `GRANDMCP_ALLOW_WRITE` | off                      | `1` enables tools that change the show                                          |
| `GRANDMCP_PORT`        | `9810`                   | Port of the Lua plugin                                                          |
| `GRANDMCP_HOST`        | `127.0.0.1`              | Host of the Lua plugin                                                          |
| `GRANDMCP_TOKEN`       | none                     | Token of a plugin started with `"lan"` (from `gma3_library/grandmcp-token.txt`) |
| `GRANDMCP_TIMEOUT_MS`  | `15000`                  | Default request timeout                                                         |
| `GMA3_LIBRARY`         | OS default               | Path to `gma3_library` (used by `pnpm install-plugin`)                          |
| `GMA3_MANUAL_DIR`      | newest installed version | Path to the HTML manual (`gma3_<version>/shared/language/HTML`)                 |

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

## Presets, effects and sequences

These are the building blocks of a busking show: palettes per group, effects with a speed you can tap, and cue lists
on executors. Everything is written as grandMA3 XML and imported, so the programmer is never touched.

- **Values** (`grandmcp_preset_store`) are given per attribute as a named slot (`{ "slot": "C3" }`, a gobo, a gel macro,
  "open"), a percentage of the range (`{ "percent": 80 }`, pan 50 = centre), or a physical value
  (`{ "physical": -45 }` degrees, `{ "physical": 8, "function": "Shutter1Strobe" }` Hz). `grandmcp_fixture_attributes`
  lists what each fixture type offers. Values are converted per fixture type and checked after import against what
  grandMA3 actually stored.
- **Effects** are a value made of steps: `{ "effect": { "steps": [{ "percent": 100, "width": 25, "trans": 0 },
{ "percent": 0 }], "bpm": 128, "phase": { "from": 0, "to": 360 }, "speedMaster": 1 } }` is a dimmer chase across
  the fixtures, linked to speed master 1 so a BPM tap sets its speed. Steps can be any value type, so colour chases
  over wheel slots work the same way.
- **Sequences** (`grandmcp_sequence_store`) are cue lists. A cue's looks are preset references (the cue follows the
  preset when you change it) and/or explicit values, with fade, delay and go/follow/time triggers.
- **Executors** (`grandmcp_executor_assign`) put a sequence on a fader or button of a page. Something already on the
  executor is only replaced with `overwrite`.

**3D**: `grandmcp_patch_plan_changes` also sets fixture positions and rotations (`posX/posY/posZ` in metres,
`rotX/rotY/rotZ` in degrees; in grandMA3 `rotX: 0` hangs a fixture from a truss and `rotX: 180` stands it on the floor). `grandmcp_view3d` puts the 3D
window on a screen with a camera of your choice, and `grandmcp_screenshot` lets Claude look at it.

**Playing it**: `grandmcp_executor_configure` sets what faders and buttons do (effect layers on Toggle or Flash, a
Temp fader, ...), `grandmcp_speedmaster_set` sets BPM and puts speed masters on executors as tap buttons, and
`grandmcp_page_store` makes a page per style. Effects take a `pattern` (blocks, groups, wings, invert) that lays the
phase spread over the fixtures like MAtricks, for example a chase from the centre out; `grandmcp_matricks_store`
stores MAtricks to call live on top of a group. `grandmcp_appearance_store` colours the buttons and
`grandmcp_layout_store` builds a 2D map of the rig.

**Changing it later**: `grandmcp_preset_read` and `grandmcp_sequence_read` show what is inside, `grandmcp_cue_store` /
`grandmcp_cue_delete` edit single cues, and `grandmcp_pool_copy` / `_rename` / `_delete` manage pool objects. Replacing
a sequence keeps it on its executors.

Replacing a preset or sequence exports the old one to `gma3_library/datapools/presets` or `.../sequences` first.

## Safety

- Read-only unless `GRANDMCP_ALLOW_WRITE=1`.
- Patch changes always go plan → user review → apply, and the plan is bound to the patch it was made against.
- grandmcp never answers grandMA3's pop-ups. When the console asks something, the tool reports the question and the
  buttons, and you answer on the console.
- The plugin refuses to write while a pop-up is open or while the command line is inside another editor (for example
  someone in the Patch menu).
- The patch is exported before every apply. Importing that file again **merges**: it restores fixtures that were
  changed or deleted, but does not remove fixtures added since. It is a record to recover from, not a one-click undo.
- Patch changes (apply, move, fixture type import) are refused while sequences are running, unless you confirm and
  Claude passes `duringPlayback`. `grandmcp_status` lists running sequences.
- There is no tool that runs arbitrary Lua or command-line commands.

## Limitations

- One DMX break per mode (multi-break modes are refused).
- Only fixtures with ID type "Fixture" (no channel IDs yet).
- The catalog is MA's own library listing. The first search of a session loads it from the console (about 20
  seconds for 25,000 entries); it is then cached for 30 minutes. Loading it switches on all sources (MA, user,
  Share) in the fixture import dialog.
- Share imports need the console to reach MA's World Server (internet).
- The plugin has to be started after every show load (`Plugin "grandmcp"`); grandMA3 has no show-load hook to start it
  automatically. Putting that command on a macro button is the easy way.
- `grandmcp_screenshot` shows a grandMA3 screen. Fixtures and beams render in onPC's 3D view without MA hardware.
  When onPC runs on the same Mac, the onPC window is captured through macOS (grandMA3's own capture only grabs the
  top-left corner on Retina screens); on other machines grandMA3 renders the screenshot itself.
- Network mode is plain TCP with a token; not encrypted.

## Roadmap

- Executor options (fader and button functions) and speed master BPM
- Cues and looks from a description
- Verifying network mode on a rig with MA hardware

## Development

```sh
pnpm test          # unit tests (planner, library search, bridge client, manual search)
pnpm test:e2e      # end-to-end suite against a running onPC with the plugin (test shows only)
pnpm typecheck
pnpm lint
pnpm format
```

Talking to a running onPC:

- Start the plugin with `Plugin "grandmcp" "dev"` to enable two probe ops, `cmd` and `lua`, for experiments. They
  only listen on 127.0.0.1 and are never exposed as MCP tools. `Plugin "grandmcp" "dev off"` turns them off.
- `pnpm probe ping`, `pnpm probe info`, `pnpm probe lua 'return Patch():Count()'`, `pnpm probe raw patch.list`
- `pnpm reload` copies the plugin into the library and hot-swaps it in the running onPC (needs dev mode).
- `pnpm test:e2e` drives every tool through the real MCP server against a running onPC. It works in a scratch area
  (FIDs 9000-9004 in universe 500, pool slot 990, page 99, speed master 16), refuses to start if that area holds
  anything it did not create, and cleans up afterwards. Moves and saving under a new name always ask a question on
  the console, so they are not covered.
- `pnpm smoke` runs the MCP server through a real MCP client against onPC. `pnpm smoke --write --fid 301` also
  imports a fixture type and patches three fixtures. Only use that on a test show.

[`docs/ma3/probe-notes.md`](docs/ma3/probe-notes.md) collects what was verified about grandMA3's Lua API and patch
internals, including the behaviour the official manual does not describe.

## License

MIT, see [LICENSE](LICENSE).
