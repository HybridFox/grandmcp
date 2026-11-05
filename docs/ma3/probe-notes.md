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
- MA2 library files (`.pxml`) are encrypted: modes and footprints are only known after import.
- `LivePatch:Export(dir, file)` writes the full patch (types included) as XML, no dialog.

## Library paths (`GetPath(Enums.PathType.X)`)
- `GrandMA3Library`: `shared/lib_fixture_types/grandma3` (171 files, mostly `set@`)
- `GrandMA2Library`: `shared/lib_fixture_types/grandma2` (11,536 `.pxml` files)
- `UserFixtures`: `gma3_library/fixturetypes` (user GDTF / XML)
- `DirList(path, "generic@d*")` returns `{name, size, time}` rows.
