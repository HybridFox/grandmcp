# grandMA3 probe notes (onPC 2.5.1.1, macOS)

Verified live through the bridge's dev `lua` op on 2026-11-05. `lua_functions_2.5.1.1.txt` is the
`HelpLua` dump for the same build.

## Runtime

- Lua 5.5. `require("socket")` and `require("json")` (rxi) ship in `shared/resource/lib_plugins/requirements`.
- `coroutine.yield(seconds)` works inside `xpcall`, so ops can wait for the main task.
- `CmdObj():Get("Destination", Enums.Roles.Display)` shows where the command line points
  (`Root`, `ShowData.Patch`, `Stage 1.Fixtures`).

## Patch objects

- `ShowData().LivePatch` (`14.9`) is the active patch. `ShowData().Patch` (`14.10`) is the edit copy.
- `Patch()` returns the **edit copy while one is open**, the live patch otherwise. Read from
  `ShowData().LivePatch` explicitly.
- Fixtures: `LivePatch.Stages[<stage>].Fixtures:Children()`. Useful properties (Display role):
  `FID`, `CID`, `IDTYPE`, `NAME`, `FIXTURETYPE`, `MODE`, `MODEDIRECT`, `PATCH` (`"1.001"`, empty when
  unpatched), `CONFLITEDPATCH` (sic), `STAGE`.
- DMX mode: `TOTALFOOTPRINT` is the channel count (16-bit dimmer = 2). Channels carry `DMXBREAK`.

## Edit cycle (no dialogs, verified)

1. `CmdIndirect('ChangeDestination Root')`, `CmdIndirect('ChangeDestination "ShowData"."Patch"')`.
2. Import a type into the edit copy:
   `ShowData().Patch.FixtureTypes:Acquire():Import(GetPath(Enums.PathType.GrandMA2Library) .. GetPathSeparator(), "generic@dimmer.pxml")`.
3. `CmdIndirect('ChangeDestination "Stages"."Stage 1"."Fixtures"')`, then
   `AddFixtures{mode = <DMXMode handle>, amount = 1, fid = "101", name = "...", patch = {"1.001"}}` returns `true`.
4. `CmdIndirect('ChangeDestination Root')` commits silently, with no undo.

## Gotchas

- `CheckFIDCollision` / `CheckDMXCollision` only see the **committed** patch. Fixtures added in the open
  edit copy still read as free, so overlaps inside one batch must be checked by the caller.
- `FixtureTypes.Source` is a `SourceType` enum (`show` / `library` / `PSR`), not a library selector.
  The `set 'FixtureTypes' Source='grandMA3'` line in `gma3internal_fixtures.lua` is stale.
- MA2 library files (`.pxml`) are encrypted on disk; read their modes from the library listing below instead.
- `LivePatch:Export(dir, file)` writes the full patch (types included) as XML, no dialog.
- `ShowData().Patch:Import(dir, file)` of such an export **merges**: fixtures in the file are restored, fixtures
  added since stay. The backup is a full record, not a one-step undo.
- The commit replaces the `LivePatch` object: handles taken before `ChangeDestination Root` are stale
  (indexing them returns nil). Re-read `ShowData().LivePatch` after every commit.
- MA2 library types use generic mode names: `robe@robin ledbeam 150 rgba.pxml` has "Mode 1" (22 ch, the
  manufacturer's "Standard 16-bit") and "Mode 2" (16 ch). Match modes by footprint, not by the document's name.

## Plugin lifecycle

- `ReloadAllPlugins` reloads the Lua stored in the show, not the file on disk. Picking up a new file takes
  `Delete Plugin <n> /NoConfirmation`, `Import Plugin Library "grandmcp.xml" At Plugin <n>`, `Plugin <n>`
  (the dev `reload` op queues exactly that with `CmdIndirect`).
- After a re-import the old copy's `Cleanup` still runs, late. Anything it closes must belong to that copy only,
  never to state shared through `_G`.

## Fixture catalog (`CmdObj().Library`)

- The import dialog's listing: one object per fixture type with `FileName`, `Path`, `Manufacturer`, `Version`,
  `Source` (`grandMA3`, `grandMA2`, `User [GDTF]`, `GDTF Share`, `Fixture Share`) and children per DMX mode
  (`Mode`, `DMXFootprint`). About 25,800 entries, 13,500 of them GDTF Share (`Path` = `ws://GDTFShare/id=<n>`).
- Filled by `Call Library` with the command line inside the patch's `FixtureTypes`. The source switches are
  `CurrentProfile().LoadFixtureLibraryMA / User / Share`; writing them re-lists the library for wherever the command
  line is at that moment, so only touch them inside `FixtureTypes`. The listing survives leaving the edit copy.
- It is **shared by every import dialog**: `Import Plugin Library ...` replaces it with the plugins folder. Check
  `LibraryDestination == "FixtureTypes"` before using it.
- `Import Lib <index> /NC` (command line in `FixtureTypes`) imports entry `<index>`, downloading Share entries via the
  World Server into `gma3_library/fixturetypes` first (~1 s). Indexes shift on every rescan: resolve right before.
- Catalog footprints are hints: the GDTF Share listing reported "126ch = 3" for a mode that imports as 126 channels.
  Mode names can carry trailing spaces (`"36ch "`).
- `shared/lib_fixture_types/worldserver/fixture_cache.dat` is MA's binary cache of the Share catalog, not downloads.
- Source of these findings: MA's own system tests in `lib_plugins/systemtests` (`system_test_fixture_import_shares*.lua`).

## Library paths (`GetPath(Enums.PathType.X)`)

- `GrandMA3Library`: `shared/lib_fixture_types/grandma3` (171 files, mostly `set@`)
- `GrandMA2Library`: `shared/lib_fixture_types/grandma2` (11,536 `.pxml` files)
- `UserFixtures`: `gma3_library/fixturetypes` (user GDTF / XML)
- `DirList(path, "generic@d*")` returns `{name, size, time}` rows.
