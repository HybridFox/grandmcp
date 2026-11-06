-- grandmcp bridge: serves newline-delimited JSON over TCP from inside grandMA3.
--
--   request   {"id": <any>, "op": "<name>", "args": {...}}
--   response  {"id": <any>, "ok": true,  "result": <any>}
--             {"id": <any>, "ok": false, "code": "<code>", "error": "<message>"}
--
-- Start:    Plugin "grandmcp"            local only (127.0.0.1)
--           Plugin "grandmcp" "lan"      all network interfaces; network clients must send the token first
--           (add "dev" to enable the probe ops, which only ever answer local clients)
-- Control:  Plugin "grandmcp" "stop" | "status" | "dev on" | "dev off"

local myHandle = select(4, ...)

local socket = require("socket")
local json = require("json")

local VERSION = "0.22.2"
local LOCAL_HOST = "127.0.0.1"
local TOKEN_FILE = "grandmcp-token.txt" -- in gma3_library
local PORT = 9810
local MAX_LINES_PER_TICK = 32
local MAX_LINE_BYTES = 4 * 1024 * 1024
local STALE_AFTER_S = 3

-- One server per console. `shared.current` survives between plugin calls (and reloads of this file) so
-- a control call can reach it, but each loaded copy only ever stops the instance it started itself:
-- after a re-import the old copy's late Cleanup must not touch the new server.
_G.__grandmcp = _G.__grandmcp or {}
local shared = _G.__grandmcp
local mine -- the instance this copy started
local pendingControlCleanups = 0

---------------------------------------------------------------------------
-- JSON-safe conversion
---------------------------------------------------------------------------

local function describeHandle(h)
	local d = { type = "handle" }
	local ok, v = pcall(HandleToStr, h)
	if ok then d.handle = v end
	ok, v = pcall(function() return h:ToAddr() end)
	if ok and v ~= nil then d.addr = v end
	ok, v = pcall(function() return h:GetClass() end)
	if ok and v ~= nil then d.class = v end
	ok, v = pcall(function() return h.name end)
	if ok and type(v) == "string" then d.name = v end
	return d
end

local function isArray(t)
	local n = #t
	local count = 0
	for k in pairs(t) do
		if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
		count = count + 1
	end
	return count == n
end

local function sanitize(v, depth)
	depth = depth or 0
	local tv = type(v)
	if tv == "string" or tv == "boolean" or tv == "nil" then return v end
	if tv == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
		return v
	end
	if tv == "userdata" then return describeHandle(v) end
	if tv ~= "table" then return "<" .. tv .. ">" end
	if depth >= 12 then return "<max depth>" end
	local out = {}
	if isArray(v) then
		for i = 1, #v do out[i] = sanitize(v[i], depth + 1) end
	else
		for k, val in pairs(v) do out[tostring(k)] = sanitize(val, depth + 1) end
	end
	return out
end

---------------------------------------------------------------------------
-- Ops
---------------------------------------------------------------------------

local function fail(code, message, detail)
	error({ code = code, message = message, detail = detail }, 0)
end

-- What an open pop-up asks: title, message and button labels, read from MA's MessageBox UI. Pop-ups are the user's
-- to answer; the bridge only reports them.
local function describeModal(m)
	if not m then return nil end
	local d = { title = nil, message = nil, buttons = {} }
	local function text(o)
		local ok, v = pcall(o.Get, o, "Text", Enums.Roles.Display)
		return ok and v ~= "" and v or nil
	end
	local function walk(h, depth)
		if depth > 12 then return end
		for _, c in ipairs(h:Children()) do
			local class = c:GetClass()
			if class == "TitleButton" and not d.title then d.title = text(c)
			elseif class == "Button" and text(c) then d.buttons[#d.buttons + 1] = text(c)
			elseif c.name == "Text" and text(c) and not d.message then d.message = text(c) end
			walk(c, depth + 1)
		end
	end
	pcall(walk, m, 0)
	return d
end

local function modalSummary(d)
	if not d then return "" end
	return string.format(' "%s": %s [buttons: %s]', tostring(d.title or "?"), tostring(d.message or ""), table.concat(d.buttons, " / "))
end

local function failModal(context)
	local d = describeModal(GetTopModal())
	fail("modal-open", context .. modalSummary(d) .. ". Ask the user to answer it on the console.", { dialog = d })
end

local function devEnabled()
	return shared.current ~= nil and shared.current.dev == true
end

local activeClient -- the client whose request is being handled

local function requireDev()
	if not devEnabled() then fail("dev-disabled", 'start the plugin with Plugin "grandmcp" "dev on"') end
	if not (activeClient and activeClient.loopback) then fail("dev-local-only", "dev ops only answer clients on this machine") end
end

local ops = {}

ops.ping = function()
	return { pong = true, plugin = VERSION, time = socket.gettime() }
end

ops.info = function()
	return {
		plugin = VERSION,
		build = BuildDetails(),
		hostOS = HostOS(),
		showFileStatus = GetShowFileStatus(),
		modalOpen = GetTopModal() ~= nil,
		dialog = describeModal(GetTopModal()),
		runningSequences = (function()
			local ok, list = pcall(function()
				local running = {}
				for _, seq in ipairs(DataPool().Sequences:Children()) do
					local okActive, active = pcall(seq.HasActivePlayback, seq)
					if okActive and active then running[#running + 1] = seq.name end
				end
				return running
			end)
			return ok and list or {}
		end)(),
		commandLine = CmdObj():Get("Destination", Enums.Roles.Display),
		dev = devEnabled(),
		network = shared.current and (shared.current.lan and "lan" or "local") or nil,
	}
end

---------------------------------------------------------------------------
-- Object access
---------------------------------------------------------------------------

local function display(h, prop)
	local ok, v = pcall(h.Get, h, prop, Enums.Roles.Display)
	if ok then return v end
	return nil
end

local function blankToNil(s)
	if s == nil or s == "" or s == "None" then return nil end
	return s
end

local function props(h)
	local out = {}
	for i = 0, h:PropertyCount() - 1 do
		local name = h:PropertyName(i)
		local v = display(h, name)
		if v ~= nil and v ~= "" then out[name] = v end
	end
	return out
end

-- "LivePatch.Stages.Stage 1" (names from ShowData), "Root.ShowData...", or a numeric address like "14.9".
local function resolve(path)
	if type(path) ~= "string" or path == "" then fail("bad-args", "path must be a non-empty string") end
	if path:match("^[%d%.]+$") then
		local h = FromAddr(path)
		if not h then fail("not-found", "no object at address " .. path) end
		return h
	end
	local h, rest = ShowData(), path
	local first, remainder = path:match("^([^%.]+)%.?(.*)$")
	if first == "Root" then
		h, rest = Root(), remainder
	elseif first == "ShowData" then
		rest = remainder
	end
	for part in rest:gmatch("[^%.]+") do
		local n = tonumber(part)
		local child = n and h:Ptr(n) or nil
		if not child then
			local ok, c = pcall(function() return h[part] end)
			if ok and type(c) == "userdata" then child = c end
		end
		if not child then child = h:Find(part) end
		if not child then fail("not-found", "'" .. part .. "' not found under " .. tostring(h:ToAddr())) end
		h = child
	end
	return h
end

local function childSummary(c, index)
	return { index = index, name = c.name, class = c:GetClass(), count = c:Count() }
end

---------------------------------------------------------------------------
-- Patch reads (always from LivePatch: Patch() follows the edit copy while one is open)
---------------------------------------------------------------------------

local function modeInfo(mode)
	local breaks = {}
	for _, ch in ipairs(mode.DMXChannels:Children()) do breaks[display(ch, "DMXBreak") or "1"] = true end
	local count = 0
	for _ in pairs(breaks) do count = count + 1 end
	return { name = mode.name, footprint = tonumber(display(mode, "TotalFootprint")) or 0, breaks = count }
end

local function fixtureTypeInfo(ft, index)
	local modes = {}
	for i, m in ipairs(ft.DMXModes:Children()) do modes[i] = modeInfo(m) end
	return {
		index = index,
		name = ft.name,
		manufacturer = blankToNil(display(ft, "Manufacturer")),
		shortName = blankToNil(display(ft, "ShortName")),
		modes = modes,
	}
end

-- Children of class "Fixture" are fixtures under a grouping fixture; class "SubFixture" are cells of a multi-instance
-- fixture (pixel bars and the like), which have no FID of their own.
local function childCounts(f)
	local children, cells = 0, 0
	for _, c in ipairs(f:Children()) do
		if c:GetClass() == "Fixture" then children = children + 1 else cells = cells + 1 end
	end
	return children, cells
end

local function fixtureRow(f, stageName, parentFid)
	local ft = f:Get("FixtureType")
	local mode = f:Get("ModeDirect")
	local idType = display(f, "IDType") or ""
	local children, cells = childCounts(f)
	return {
		stage = stageName,
		fid = blankToNil(display(f, "FID")),
		cid = blankToNil(display(f, "CID")),
		idType = idType:match("'(.-)'") or idType,
		name = f.name,
		type = type(ft) == "userdata" and ft.name or nil,
		mode = type(mode) == "userdata" and mode.name or nil,
		patch = blankToNil(display(f, "Patch")),
		footprint = type(mode) == "userdata" and tonumber(display(mode, "TotalFootprint")) or nil,
		conflicted = display(f, "ConflitedPatch") == "Yes",
		parent = parentFid,
		children = children,
		subfixtures = cells,
	}
end

-- Calls visit(fixture, stageName, holder, index, parentFid) for every fixture, including those under grouping fixtures.
local function eachFixture(patchObj, visit)
	local function walk(holder, stageName, parentFid)
		for i, f in ipairs(holder:Children()) do
			if f:GetClass() == "Fixture" then
				if visit(f, stageName, holder, i, parentFid) then return true end
				if walk(f, stageName, blankToNil(display(f, "FID"))) then return true end
			end
		end
	end
	for _, stage in ipairs(patchObj.Stages:Children()) do
		if walk(stage.Fixtures, stage.name, nil) then return end
	end
end

-- Fixture with ID type "Fixture" and this FID in a patch object (also under grouping fixtures), with its stage name,
-- the object holding it (the stage's Fixtures or a grouping fixture) and its index there.
local function findFixture(patchObj, fid)
	local found
	eachFixture(patchObj, function(f, stageName, holder, index)
		if display(f, "FID") == tostring(fid) and (display(f, "IDType") or ""):match("'Fixture'") then
			found = { f, stageName, holder, index }
			return true
		end
	end)
	if found then return found[1], found[2], found[3], found[4] end
	return nil
end

local function indexIn(holder, handle)
	for i, child in ipairs(holder:Children()) do
		if child == handle then return i end
	end
	return nil
end

ops.get = function(args)
	local h = resolve(args.path)
	return { object = describeHandle(h), properties = props(h), childCount = h:Count() }
end

ops.children = function(args)
	local h = resolve(args.path)
	local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
	local limit = math.min(500, math.max(1, math.floor(tonumber(args.limit) or 100)))
	local out = {}
	local total = h:Count()
	for i = offset + 1, math.min(total, offset + limit) do
		local c = h:Ptr(i)
		if c then out[#out + 1] = childSummary(c, i) end
	end
	return { object = describeHandle(h), total = total, offset = offset, children = out }
end

ops["patch.types"] = function()
	local out = {}
	for i, ft in ipairs(ShowData().LivePatch.FixtureTypes:Children()) do out[i] = fixtureTypeInfo(ft, i) end
	return out
end

ops["patch.list"] = function()
	local live = ShowData().LivePatch
	local stages, fixtures = {}, {}
	for _, stage in ipairs(live.Stages:Children()) do stages[#stages + 1] = stage.name end
	eachFixture(live, function(f, stageName, _, _, parentFid) fixtures[#fixtures + 1] = fixtureRow(f, stageName, parentFid) end)
	return { stages = stages, fixtures = fixtures }
end

---------------------------------------------------------------------------
-- Patch writes: edit copy -> change -> silent commit (no undo, so callers back up first)
---------------------------------------------------------------------------

local function destination()
	return display(CmdObj(), "Destination")
end

local function guardIdle()
	if GetTopModal() ~= nil then failModal("a pop-up is open on the console") end
	local dest = destination()
	if dest ~= "Root" then
		fail("busy", "the command line is at '" .. tostring(dest) .. "', not Root; someone may be editing. Run 'ChangeDestination Root' when done.")
	end
end

local function runningSequences()
	local running = {}
	for _, seq in ipairs(DataPool().Sequences:Children()) do
		local ok, active = pcall(seq.HasActivePlayback, seq)
		if ok and active then running[#running + 1] = string.format("%s '%s'", tostring(display(seq, "No")):match("^%d+") or "?", tostring(seq.name)) end
	end
	return running
end

-- Patch changes while a show is playing can hit what the audience sees, so they need an explicit go-ahead.
local function guardPlayback(args)
	if args.duringPlayback then return end
	local running = runningSequences()
	if #running > 0 then
		fail("playback-running", "sequences are running (" .. table.concat(running, ", ") .. "); patch changes now could affect the live output. Stop them, or confirm with the user and pass duringPlayback.")
	end
end

local function waitDestination(expected, timeout)
	local t0 = socket.gettime()
	while socket.gettime() - t0 < (timeout or 5) do
		coroutine.yield(0.05)
		if destination() == expected then return end
		if GetTopModal() ~= nil then failModal("a pop-up opened while the command line moved to " .. expected) end
	end
	fail("timeout", "command line did not reach " .. expected .. " (now at " .. tostring(destination()) .. ")")
end

local function checkName(name, what)
	if type(name) ~= "string" or name == "" or name:find('"', 1, true) then fail("bad-args", what .. " must be a non-empty string without quotes") end
	return name
end

local function enterPatchEdit(stageName)
	CmdIndirect("ChangeDestination Root")
	CmdIndirect('ChangeDestination "ShowData"."Patch"')
	waitDestination("ShowData.Patch")
	if stageName then
		CmdIndirect(string.format('ChangeDestination "Stages"."%s"."Fixtures"', stageName))
		waitDestination(stageName .. ".Fixtures")
	end
end

local function commitPatchEdit()
	CmdIndirect("ChangeDestination Root")
	waitDestination("Root", 10)
end

local function backupLivePatch(label)
	local sep = GetPathSeparator()
	local dir = GetPath(Enums.PathType.Library) .. sep .. "patch"
	local file = string.format("grandmcp-backup-%s-%s.xml", os.date("%Y%m%d-%H%M%S"), label)
	if not ShowData().LivePatch:Export(dir, file) then fail("backup-failed", "could not export the live patch to " .. dir) end
	return dir .. sep .. file
end

---------------------------------------------------------------------------
-- Fixture type catalog: MA's own library listing (CmdObj().Library), the list the import dialog shows. It covers
-- the MA3 and MA2 libraries, user files in gma3_library/fixturetypes and the GDTF / Fixture Share, with DMX modes.
---------------------------------------------------------------------------

local function normalizeSource(source)
	source = string.lower(source or "")
	if source:find("^user") then return "user" end
	if source:find("gdtf") then return "gdtf-share" end
	if source:find("fixture share") then return "fixture-share" end
	return source -- grandma3, grandma2
end

local function leavePatchEdit()
	if destination() ~= "Root" then pcall(commitPatchEdit) end
end

local function enterFixtureTypes()
	enterPatchEdit(nil)
	CmdIndirect('ChangeDestination "FixtureTypes"')
	waitDestination("FixtureTypes")
end

-- The listing is shared by every import dialog (plugins, macros, ...), so it only counts as the fixture catalog
-- while its destination is FixtureTypes.
local function catalogReady()
	local lib = CmdObj().Library
	return lib:Count() > 0 and display(lib, "LibraryDestination") == "FixtureTypes"
end

-- The listing is empty until someone opens an import dialog (or after a restart), and holds whatever that dialog
-- imports (plugins, macros, ...). Filling it needs the command line
-- in the patch's FixtureTypes, so this enters the edit copy and leaves it again without changing anything.
local function loadCatalog()
	guardIdle()
	local ok, err = pcall(function()
		enterFixtureTypes()
		-- Writing these profile switches (the source buttons of the import dialog) re-lists the library for wherever
		-- the command line is, so only touch them here, inside FixtureTypes, and leave them on afterwards.
		local profile = CurrentProfile()
		for _, key in ipairs({ "LoadFixtureLibraryMA", "LoadFixtureLibraryUser", "LoadFixtureLibraryShare" }) do
			if not profile[key] then profile[key] = true end
		end
		CmdIndirect("Call Library")
		-- Done once the listing belongs to FixtureTypes (the old listing may still be there for a moment) and its
		-- count has settled for 1.5 s (the Share part can arrive later than the local libraries).
		local t0, lastCount, stableSince = socket.gettime(), -1, socket.gettime()
		while socket.gettime() - t0 < 45 do
			coroutine.yield(0.25)
			if catalogReady() then
				local count = CmdObj().Library:Count()
				if count ~= lastCount then
					lastCount, stableSince = count, socket.gettime()
				elseif socket.gettime() - stableSince > 1.5 then
					return
				end
			end
		end
		fail("timeout", "the fixture library did not load within 45 s")
	end)
	leavePatchEdit()
	if not ok then error(err, 0) end
end

local function catalogEntry(e)
	local modes = {}
	for i, m in ipairs(e:Children()) do modes[i] = { name = display(m, "Mode"), footprint = tonumber(display(m, "DMXFootprint")) } end
	return {
		source = normalizeSource(display(e, "Source")),
		file = display(e, "FileName"),
		path = display(e, "Path"),
		manufacturer = blankToNil(display(e, "Manufacturer")),
		name = e.name,
		version = blankToNil(display(e, "Version")),
		modes = modes,
	}
end

-- Paged so a 25k-entry catalog never blocks the console for long. args: { offset, limit }
ops["library.catalog"] = function(args)
	if not catalogReady() then loadCatalog() end
	local lib = CmdObj().Library
	local total = lib:Count()
	local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
	local limit = math.min(5000, math.max(1, math.floor(tonumber(args.limit) or 2000)))
	local entries = {}
	for i = offset + 1, math.min(total, offset + limit) do
		local e = lib:Ptr(i)
		if e then entries[#entries + 1] = catalogEntry(e) end
		if i % 250 == 0 then coroutine.yield() end
	end
	return { total = total, offset = offset, entries = entries }
end

-- Imports one catalog entry the way the import dialog does ("Import Lib <index>"); Share entries are downloaded into
-- gma3_library/fixturetypes first. args: { file, path? } as returned by library.catalog.
ops["patch.importType"] = function(args)
	local file = checkName(args.file, "file")
	local path = type(args.path) == "string" and args.path ~= "" and args.path or nil
	guardIdle()
	guardPlayback(args)
	if not catalogReady() then loadCatalog() end
	local liveBefore = ShowData().LivePatch.FixtureTypes:Count()

	enterFixtureTypes()
	local ok, err = pcall(function()
		local lib = CmdObj().Library
		local index -- indexes shift whenever the listing is rescanned, so look it up right before importing
		for i = 1, lib:Count() do
			local e = lib:Ptr(i)
			if display(e, "FileName") == file and (path == nil or display(e, "Path") == path) then
				index = i
				break
			end
		end
		if not index then fail("not-found", "'" .. file .. "' is not in the fixture library") end

		local types = ShowData().Patch.FixtureTypes
		local before = types:Count()
		CmdIndirect(string.format("Import Lib %d /NC", index))
		local t0 = socket.gettime()
		while types:Count() <= before do
			coroutine.yield(0.1)
			if GetTopModal() ~= nil then failModal("a pop-up opened during the import") end
			if socket.gettime() - t0 > 90 then
				fail("timeout", "the import did not finish within 90 s (Share downloads need the World Server connection)")
			end
		end
	end)
	leavePatchEdit()
	if not ok then error(err, 0) end

	local live = ShowData().LivePatch.FixtureTypes
	if live:Count() <= liveBefore then fail("verify-failed", "no new fixture type in the live patch after the import") end
	return fixtureTypeInfo(live:Ptr(live:Count()), live:Count())
end

-- args: { stage, fixtures = [{ fid, name, type, mode, patch?, parent? }] }. parent is the FID of a grouping fixture,
-- in the show or earlier in the batch. Overlaps inside the batch are the caller's job: CheckFIDCollision and
-- CheckDMXCollision only see the committed patch.
ops["patch.add"] = function(args)
	local stageName = checkName(args.stage, "stage")
	if type(args.fixtures) ~= "table" or #args.fixtures == 0 then fail("bad-args", "fixtures must be a non-empty array") end
	guardIdle()
	guardPlayback(args)

	local live = ShowData().LivePatch
	if not live.Stages[stageName] then fail("not-found", "no stage '" .. stageName .. "'") end
	local seen = {}
	for _, f in ipairs(args.fixtures) do
		local fid = math.tointeger(f.fid)
		if not fid or fid < 1 then fail("bad-args", "fid must be a positive integer") end
		if seen[fid] then fail("conflict", "FID " .. fid .. " appears twice in the batch") end
		seen[fid] = true
		local ft = live.FixtureTypes[checkName(f.type, "type")]
		if not ft then fail("not-found", "fixture type '" .. f.type .. "' is not in the show") end
		local mode = ft.DMXModes[checkName(f.mode, "mode")]
		if not mode then fail("not-found", "fixture type '" .. f.type .. "' has no mode '" .. f.mode .. "'") end
		if not CheckFIDCollision(fid, 1) then fail("conflict", "FID " .. fid .. " is already used") end
		if f.patch ~= nil and not CheckDMXCollision(mode, f.patch, 1) then fail("conflict", "DMX " .. f.patch .. " overlaps patched channels (FID " .. fid .. ")") end
		if f.parent ~= nil and not seen[math.tointeger(f.parent)] and not findFixture(live, f.parent) then
			fail("not-found", "parent FID " .. tostring(f.parent) .. " is neither in the show nor earlier in the batch")
		end
	end

	local backup = backupLivePatch("patch-add")
	enterPatchEdit(stageName)
	local edit = ShowData().Patch
	local okAll, err = pcall(function()
		for _, f in ipairs(args.fixtures) do
			local spec = { mode = edit.FixtureTypes[f.type].DMXModes[f.mode], amount = 1, fid = tostring(math.tointeger(f.fid)), name = f.name }
			if f.patch ~= nil then spec.patch = { f.patch } end
			if f.parent ~= nil then
				spec.parent = findFixture(edit, f.parent)
				if not spec.parent then fail("add-failed", "parent FID " .. tostring(f.parent) .. " not found in the edit copy") end
			end
			if not AddFixtures(spec) then fail("add-failed", "AddFixtures failed for FID " .. spec.fid) end
		end
	end)
	if not okAll then
		-- Undo our additions in the edit copy so the commit that leaves it changes nothing.
		local doomed = {}
		eachFixture(edit, function(f, _, holder, index)
			local fid = tonumber(display(f, "FID"))
			if fid and seen[fid] then table.insert(doomed, 1, { holder, index }) end -- deepest and last first
		end)
		for _, d in ipairs(doomed) do pcall(d[1].Delete, d[1], d[2]) end
		commitPatchEdit()
		error(err, 0)
	end
	commitPatchEdit()

	-- The commit replaces the LivePatch object, so handles taken before it are stale. From here on the change
	-- is in: a failing read-back must be reported as "committed, not verified", never as an error.
	local okRead, readBack = pcall(function()
		local byFid = {}
		eachFixture(ShowData().LivePatch, function(f, stage, _, _, parentFid)
			local fid = tonumber(display(f, "FID"))
			if fid and seen[fid] then byFid[fid] = fixtureRow(f, stage, parentFid) end
		end)
		local results, verified = {}, true
		for i, f in ipairs(args.fixtures) do
			local row = byFid[math.tointeger(f.fid)]
			local match = row ~= nil and row.type == f.type and row.mode == f.mode and row.patch == f.patch and not row.conflicted
				and (f.parent == nil or tonumber(row.parent) == math.tointeger(f.parent))
			verified = verified and match
			results[i] = { fid = f.fid, ok = match, actual = row }
		end
		return { verified = verified, results = results }
	end)
	if not okRead then
		return { backup = backup, committed = true, verified = false, results = {}, verifyError = tostring(type(readBack) == "table" and readBack.message or readBack) }
	end
	return { backup = backup, committed = true, verified = readBack.verified, results = readBack.results }
end

---------------------------------------------------------------------------
-- Changing existing fixtures
---------------------------------------------------------------------------

-- Inside the edit copy, absolute ChangeDestination paths resolve relative to the current destination and
-- "ChangeDestination Root" commits, so climb with ".." to get back to the patch root.
local function upToPatch()
	for _ = 1, 5 do
		local dest = destination()
		if dest == "ShowData.Patch" then return end
		CmdIndirect("ChangeDestination ..")
		local t0 = socket.gettime()
		repeat
			coroutine.yield(0.05)
		until destination() ~= dest or socket.gettime() - t0 > 3
	end
	fail("timeout", "could not get back to the patch root (now at " .. tostring(destination()) .. ")")
end

local function enterStage(stageName)
	upToPatch()
	CmdIndirect(string.format('ChangeDestination "Stages"."%s"."Fixtures"', stageName))
	waitDestination(stageName .. ".Fixtures")
end

-- Groups, cues, presets, layouts and worlds store fixtures as IDType="0" ID="<fid>" in their exported XML (the Lua tree
-- does not expose it), so export each object to a temp file and scan it. args: { fids = [...] }
ops["patch.usage"] = function(args)
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	local wanted, usage = {}, {}
	for _, fid in ipairs(args.fids) do
		wanted[tostring(math.tointeger(fid))] = true
		usage[tostring(math.tointeger(fid))] = {}
	end
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_usage.xml"
	local pools = { { "Group", DataPool().Groups }, { "Sequence", DataPool().Sequences }, { "Layout", DataPool().Layouts }, { "World", DataPool().Worlds } }
	for _, presetPool in ipairs(DataPool().PresetPools:Children()) do
		pools[#pools + 1] = { "Preset " .. (tostring(display(presetPool, "No")):match("^%d+") or "?") .. ".", presetPool }
	end
	local scanned = 0
	for _, pool in ipairs(pools) do
		local label, holder = pool[1], pool[2]
		for _, obj in ipairs(holder and holder:Children() or {}) do
			if obj:Export(dir, file) then
				local f = io.open(dir .. sep .. file, "r")
				local xml = f and f:read("a") or ""
				if f then f:close() end
				local found = {}
				for id in xml:gmatch('IDType="0" ID="(%d+)"') do
					if wanted[id] and not found[id] then
						found[id] = true
						local no = tostring(display(obj, "No") or ""):match("^%d+") or "?"
						table.insert(usage[id], string.format("%s%s%s '%s'", label, label:sub(-1) == "." and "" or " ", no, tostring(obj.name)))
					end
				end
			end
			scanned = scanned + 1
			if scanned % 25 == 0 then coroutine.yield() end
		end
	end
	os.remove(dir .. sep .. file)
	return { usage = usage, scanned = scanned }
end

-- args: { changes = [{ fid, remove?, newFid?, name?, patch? ("U.AAA" or "" to unpatch), type?, mode? }] }. The planner
-- guarantees a consistent final state (unique FIDs, no overlaps), so intermediate overlaps are fine.
-- Order: type/mode (Assign) -> FID/name/patch -> deletes. Everything before the deletes is reverted on failure.
ops["patch.change"] = function(args)
	if type(args.changes) ~= "table" or #args.changes == 0 then fail("bad-args", "changes must be a non-empty array") end
	guardIdle()
	guardPlayback(args)
	local live = ShowData().LivePatch
	for _, c in ipairs(args.changes) do
		if not findFixture(live, c.fid) then fail("not-found", "no fixture with FID " .. tostring(c.fid)) end
		if c.type ~= nil or c.mode ~= nil then
			local ft = live.FixtureTypes[checkName(c.type, "type")]
			if not ft or not ft.DMXModes[checkName(c.mode, "mode")] then fail("not-found", "no mode '" .. tostring(c.mode) .. "' in type '" .. tostring(c.type) .. "'") end
		end
		if c.name ~= nil then checkName(c.name, "name") end
	end

	local backup = backupLivePatch("patch-change")
	enterPatchEdit(nil)
	local edit = ShowData().Patch
	local targets = {}
	for i, c in ipairs(args.changes) do
		local f, stageName, holder = findFixture(edit, c.fid)
		if c.type ~= nil and holder ~= edit.Stages[stageName].Fixtures then
			leavePatchEdit()
			fail("unsupported", "changing the type or mode of a fixture inside a grouping fixture is not supported yet (FID " .. tostring(c.fid) .. ")")
		end
		targets[i] = { change = c, fixture = f, stage = stageName, holder = holder }
	end

	local undo = {} -- functions that restore what was changed, newest last
	local okEdit, err = pcall(function()
		for _, t in ipairs(targets) do
			local c, f = t.change, t.fixture
			if not c.remove and c.type ~= nil then
				local oldType, oldMode = f:Get("FixtureType").name, f:Get("ModeDirect").name
				local oldPatch = display(f, "Patch") or ""
				local function assign(typeName, modeName)
					enterStage(t.stage)
					local index = indexIn(edit.Stages[t.stage].Fixtures, f)
					if not index then fail("change-failed", "lost track of FID " .. tostring(c.fid)) end
					CmdIndirect(string.format('Assign FixtureType "%s"."DMXModes"."%s" At %d', typeName, modeName, index))
					local t0 = socket.gettime()
					repeat
						coroutine.yield(0.05)
						if GetTopModal() ~= nil then failModal("a pop-up opened while changing the mode of FID " .. tostring(c.fid)) end
					until (f:Get("ModeDirect") and f:Get("ModeDirect").name == modeName and f:Get("FixtureType").name == typeName) or socket.gettime() - t0 > 5
					if f:Get("ModeDirect").name ~= modeName then fail("change-failed", "MA did not change FID " .. tostring(c.fid) .. " to " .. typeName .. " / " .. modeName) end
				end
				assign(c.type, c.mode)
				undo[#undo + 1] = function()
					assign(oldType, oldMode)
					f:Set("Patch", oldPatch)
				end
				upToPatch()
			end
		end
		for _, t in ipairs(targets) do
			local c, f = t.change, t.fixture
			if not c.remove then
				for _, field in ipairs({ { "newFid", "FID" }, { "name", "Name" }, { "patch", "Patch" }, { "posX", "PosX" }, { "posY", "PosY" }, { "posZ", "PosZ" }, { "rotX", "RotX" }, { "rotY", "RotY" }, { "rotZ", "RotZ" } }) do
					local value = c[field[1]]
					if value ~= nil then
						local old = display(f, field[2]) or ""
						f:Set(field[2], tostring(value))
						undo[#undo + 1] = function() f:Set(field[2], old) end
					end
				end
			end
		end
	end)
	if not okEdit then
		for i = #undo, 1, -1 do pcall(undo[i]) end
		leavePatchEdit()
		error(err, 0)
	end

	local okDelete, deleteErr = pcall(function()
		for _, t in ipairs(targets) do
			if t.change.remove then
				local holder = t.holder
				local index = indexIn(holder, t.fixture)
				if not index then fail("change-failed", "lost track of FID " .. tostring(t.change.fid) .. " before deleting it") end
				holder:Delete(index)
			end
		end
	end)
	commitPatchEdit()
	if not okDelete then
		fail("partial", "changes were committed but a delete failed (" .. tostring(type(deleteErr) == "table" and deleteErr.message or deleteErr) .. "). Backup: " .. backup)
	end

	local okRead, readBack = pcall(function()
		local current = ShowData().LivePatch
		local results, verified = {}, true
		for i, t in ipairs(targets) do
			local c = t.change
			local row, ok
			if c.remove then
				ok = findFixture(current, c.fid) == nil
			else
				local f, stageName = findFixture(current, c.newFid or c.fid)
				row = f and fixtureRow(f, stageName)
				ok = row ~= nil
					and (c.name == nil or row.name == c.name)
					and (c.patch == nil or (row.patch or "") == c.patch)
					and (function()
						for _, field in ipairs({ { "posX", "PosX" }, { "posY", "PosY" }, { "posZ", "PosZ" }, { "rotX", "RotX" }, { "rotY", "RotY" }, { "rotZ", "RotZ" } }) do
							local want = c[field[1]]
							if want ~= nil then
								local have = tonumber(tostring(display(f, field[2]) or ""):match("(-?[%d%.]+)"))
								if not have or math.abs(have - want) > 0.01 then return false end
							end
						end
						return true
					end)()
					and (c.type == nil or (row.type == c.type and row.mode == c.mode))
					and not row.conflicted
			end
			verified = verified and ok
			results[i] = { fid = c.fid, ok = ok, actual = row }
		end
		return { verified = verified, results = results }
	end)
	if not okRead then
		return { backup = backup, committed = true, verified = false, results = {}, verifyError = tostring(type(readBack) == "table" and readBack.message or readBack) }
	end
	return { backup = backup, committed = true, verified = readBack.verified, results = readBack.results }
end

---------------------------------------------------------------------------
-- Moving fixtures under a grouping fixture (or back to the top level). MA does this with Cut/Paste in the patch and
-- asks on the console whether to keep the absolute 3D position or the offset relative to the parent. That question
-- belongs to the user: patch.move stops and reports it, the user answers on the console, patch.moveFinish completes.
---------------------------------------------------------------------------

local pendingMove -- { stage, fids, parent, backup }

local function waitDestinationChange(from, timeout)
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while navigating the patch") end
	until destination() ~= from or socket.gettime() - t0 > (timeout or 3)
	if destination() == from then fail("timeout", "the command line did not leave " .. tostring(from)) end
end

-- Where each FID sits in a patch object: the parent FID, or false for the top level.
local function parentsOf(patchObj, fids)
	local wanted, out = {}, {}
	for _, fid in ipairs(fids) do wanted[tostring(fid)] = true end
	eachFixture(patchObj, function(f, _, _, _, parentFid)
		local fid = display(f, "FID")
		if wanted[fid] then out[fid] = parentFid or false end
	end)
	return out
end

local function movedAll(patchObj, fids, parent)
	local where = parentsOf(patchObj, fids)
	for _, fid in ipairs(fids) do
		local p = where[tostring(fid)]
		if p == nil or (parent and p ~= tostring(parent)) or (not parent and p ~= false) then return false end
	end
	return true
end

local function finishMove(move)
	pendingMove = nil
	leavePatchEdit()
	local where = parentsOf(ShowData().LivePatch, move.fids)
	local results, verified = {}, true
	for i, fid in ipairs(move.fids) do
		local p = where[tostring(fid)]
		local ok = (move.parent and p == tostring(move.parent)) or (not move.parent and p == false)
		verified = verified and ok
		results[i] = { fid = fid, ok = ok, parent = p or nil }
	end
	return { pending = false, moved = verified, backup = move.backup, results = results }
end

-- args: { fids = [...], parent = <grouping fixture FID> or nil for the stage's top level }
ops["patch.move"] = function(args)
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	if pendingMove then fail("busy", "a move is waiting for an answer on the console; call patch.moveFinish first") end
	guardIdle()
	guardPlayback(args)
	local live = ShowData().LivePatch
	local parent = args.parent ~= nil and math.tointeger(args.parent) or nil

	local stage, sourceParent
	local fids = {}
	for i, value in ipairs(args.fids) do
		local fid = math.tointeger(value)
		local f, stageName = findFixture(live, fid)
		if not f then fail("not-found", "no fixture with FID " .. tostring(value)) end
		if fid == parent then fail("bad-args", "FID " .. fid .. " cannot be moved into itself") end
		local children = childCounts(f)
		if children > 0 then fail("unsupported", "FID " .. fid .. " holds other fixtures; grouping fixtures cannot be nested") end
		local p = parentsOf(live, { fid })[tostring(fid)]
		if i == 1 then
			stage, sourceParent = stageName, p
		elseif stageName ~= stage or p ~= sourceParent then
			fail("bad-args", "all fixtures must currently sit in the same place (same stage and parent)")
		end
		fids[i] = fid
	end
	if (parent and sourceParent == tostring(parent)) or (not parent and sourceParent == false) then
		fail("bad-args", "the fixtures are already there")
	end
	if parent then
		local target, targetStage = findFixture(live, parent)
		if not target or targetStage ~= stage then fail("not-found", "no grouping fixture with FID " .. parent .. " on stage " .. stage) end
		if parentsOf(live, { parent })[tostring(parent)] ~= false then fail("unsupported", "FID " .. parent .. " is inside another grouping fixture") end
		local mode = target:Get("ModeDirect")
		if not mode or tonumber(display(mode, "TotalFootprint")) ~= 0 then fail("bad-args", "FID " .. parent .. " is not a grouping fixture") end
	end

	local backup = backupLivePatch("patch-move")
	enterPatchEdit(stage)
	local stageDest = stage .. ".Fixtures"
	local ok, err = pcall(function()
		local edit = ShowData().Patch
		local stageHolder = edit.Stages[stage].Fixtures
		local sourceHolder = stageHolder
		if sourceParent then
			local sp = findFixture(edit, sourceParent)
			sourceHolder = sp
			CmdIndirect("ChangeDestination " .. indexIn(stageHolder, sp))
			waitDestinationChange(stageDest)
		end
		local positions = {}
		for _, fid in ipairs(fids) do
			local f = findFixture(edit, fid)
			positions[#positions + 1] = tostring(indexIn(sourceHolder, f))
		end
		CmdIndirect("Cut " .. table.concat(positions, " + "))
		coroutine.yield(0.2)
		if sourceParent then
			local here = destination()
			CmdIndirect("ChangeDestination ..")
			waitDestinationChange(here)
		end
		local targetHolder = stageHolder
		if parent then
			targetHolder = findFixture(edit, parent)
			CmdIndirect("ChangeDestination " .. indexIn(stageHolder, targetHolder))
			waitDestinationChange(stageDest)
		end
		CmdIndirect("Paste " .. (targetHolder:Count() + 1))
	end)
	if not ok then
		-- Everything before the paste only marks fixtures (Cut), so leaving the edit copy changes nothing.
		leavePatchEdit()
		error(err, 0)
	end

	local move = { stage = stage, fids = fids, parent = parent, from = sourceParent, backup = backup }
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.1)
		if GetTopModal() ~= nil then
			pendingMove = move
			return { pending = true, dialog = describeModal(GetTopModal()), backup = backup }
		end
	until movedAll(ShowData().Patch, fids, parent) or socket.gettime() - t0 > 3
	return finishMove(move)
end

-- Completes a move after the user answered MA's question on the console. args: { cancel = true } undoes a move the
-- user no longer wants (only possible once the pop-up is closed).
ops["patch.moveFinish"] = function(args)
	local move = pendingMove
	if not move then fail("not-found", "no move is waiting") end
	if GetTopModal() ~= nil then
		return { pending = true, dialog = describeModal(GetTopModal()), backup = move.backup }
	end
	if destination() == "Root" then
		-- Someone left the patch edit already; report what the live patch looks like.
		pendingMove = nil
		local result = finishMove(move)
		result.note = "the patch edit was closed on the console before finishing"
		return result
	end
	if movedAll(ShowData().Patch, move.fids, move.parent) then
		if args.cancel then
			-- Oops undoes the last action on the console: right after the paste that is the paste, but verify.
			CmdIndirect("Oops")
			coroutine.yield(0.5)
			local back = parentsOf(ShowData().Patch, move.fids)
			for _, fid in ipairs(move.fids) do
				if back[tostring(fid)] ~= move.from then
					fail("cancel-failed", "Oops did not move the fixtures back; the patch edit is still open. Discard it in the Patch menu on the console.")
				end
			end
			local result = finishMove(move)
			result.cancelled = true
			return result
		end
		return finishMove(move)
	end
	-- Pop-up answered with Cancel: nothing moved.
	local result = finishMove(move)
	result.cancelled = true
	return result
end

---------------------------------------------------------------------------
-- Groups (selection groups in the current data pool). Read and written as MA's own XML, so the user's
-- programmer and selection are never touched.
---------------------------------------------------------------------------

local function exportText(obj)
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_export.xml"
	if not obj:Export(dir, file) then return nil end
	local f = io.open(dir .. sep .. file, "r")
	local text = f and f:read("a")
	if f then f:close() end
	os.remove(dir .. sep .. file)
	return text
end

local function groupInfo(g)
	local text = exportText(g) or ""
	local fids, other = {}, 0
	for idType, id in text:gmatch('<Item IDType="(%d+)" ID="(%d+)"') do
		if idType == "0" then fids[#fids + 1] = tonumber(id) else other = other + 1 end
	end
	return { no = tonumber(tostring(display(g, "No")):match("^%d+")), name = g.name, fids = fids, otherIds = other }
end

local function xmlEscape(s)
	return (tostring(s):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

local function groupNo(value)
	local no = math.tointeger(value)
	if not no or no < 1 or no > 9999 then fail("bad-args", "group number must be 1-9999") end
	return no
end

local function backupGroup(g, no)
	local sep = GetPathSeparator()
	local dir = GetPath(Enums.PathType.Library) .. sep .. "datapools" .. sep .. "groups"
	CreateDirectoryRecursive(dir)
	local file = string.format("grandmcp-backup-%s-group%d.xml", os.date("%Y%m%d-%H%M%S"), no)
	if not g:Export(dir, file) then fail("backup-failed", "could not export group " .. no) end
	return dir .. sep .. file
end

ops["group.list"] = function()
	local out = {}
	for i, g in ipairs(DataPool().Groups:Children()) do
		out[#out + 1] = groupInfo(g)
		if i % 25 == 0 then coroutine.yield() end
	end
	return out
end

-- args: { no, name, fids, overwrite }. Creates or replaces the group at pool number `no` with exactly these fixtures.
ops["group.store"] = function(args)
	local no = groupNo(args.no)
	local name = args.name -- written as escaped XML, so quotes are fine here
	if type(name) ~= "string" or name == "" or #name > 200 then fail("bad-args", "name must be a non-empty string") end
	if type(args.fids) ~= "table" or #args.fids == 0 then fail("bad-args", "fids must be a non-empty array") end
	local groups = DataPool().Groups
	local existing = groups[no]
	if existing and not args.overwrite then
		fail("exists", string.format("group %d already exists ('%s'); pass overwrite to replace it", no, tostring(existing.name)))
	end
	local backup = existing and backupGroup(existing, no) or nil

	local items = {}
	for i, fid in ipairs(args.fids) do
		local id = math.tointeger(fid)
		if not id or id < 1 then fail("bad-args", "fids must be positive integers") end
		items[i] = string.format('            <Item IDType="0" ID="%d" X="%d" Y="0" Z="0"/>', id, i - 1)
	end
	local xml = table.concat({
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<GMA3 DataVersion="' .. xmlEscape(BuildDetails().BigVersion) .. '">',
		'    <Group Name="' .. xmlEscape(name) .. '">',
		'        <SelectionData Size="' .. #items .. '">',
		table.concat(items, "\n"),
		"        </SelectionData>",
		"    </Group>",
		"</GMA3>",
	}, "\n")
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_group.xml"
	local f = io.open(dir .. sep .. file, "w")
	if not f then fail("write-failed", "cannot write " .. dir .. sep .. file) end
	f:write(xml)
	f:close()

	local g = existing or groups:Create(no)
	local ok, imported = pcall(g.Import, g, dir .. sep, file)
	os.remove(dir .. sep .. file)
	if not ok or not imported then fail("import-failed", "MA could not import the group" .. (ok and "" or (": " .. tostring(imported)))) end
	local info = groupInfo(groups[no])
	info.backup = backup
	return info
end

-- args: { no }
ops["group.delete"] = function(args)
	local no = groupNo(args.no)
	guardIdle()
	local g = DataPool().Groups[no]
	if not g then fail("not-found", "no group " .. no) end
	local backup = backupGroup(g, no)
	CmdIndirect(string.format("Delete Group %d /NoConfirmation", no))
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while deleting group " .. no) end
	until DataPool().Groups[no] == nil or socket.gettime() - t0 > 5
	if DataPool().Groups[no] ~= nil then fail("delete-failed", "group " .. no .. " still exists") end
	return { no = no, backup = backup }
end

---------------------------------------------------------------------------
-- Fixture attributes and presets. Presets are written as MA XML: every value becomes a channel function plus a
-- physical value (AbsolutePhys), which MA imports exactly. ("Absolute" in XML means percent of the whole channel
-- across all its functions, which is not what anyone means by "50 %", so it is avoided.)
---------------------------------------------------------------------------

local function num(text)
	return tonumber((tostring(text or ""):gsub("^%s+", ""):gsub("%s+$", "")))
end

local function hex(text)
	return tonumber(tostring(text or ""):match("%x+") or "", 16)
end

-- attribute -> { functions = [{ name, attribute, dmxFrom, dmxTo, physFrom, physTo, slots = [{ name, dmxFrom, dmxTo }] }] }
local function attributeMap(mode)
	local map, order = {}, {}
	for _, ch in ipairs(mode.DMXChannels:Children()) do
		for _, lc in ipairs(ch:Children()) do
			local attr = display(lc, "Attribute")
			if attr and attr ~= "" then
				local entry = map[attr]
				if not entry then
					entry = { attribute = attr, functions = {} }
					map[attr] = entry
					order[#order + 1] = attr
				end
				for _, cf in ipairs(lc:Children()) do
					local fn = {
						name = (cf.name or ""):match("^%s*(.-)%s*$"),
						attribute = display(cf, "Attribute"),
						dmxFrom = hex(display(cf, "DMXFrom")),
						dmxTo = hex(display(cf, "DMXTo")),
						physFrom = num(display(cf, "PhysicalFrom")),
						physTo = num(display(cf, "PhysicalTo")),
						slots = {},
					}
					for _, cs in ipairs(cf:Children()) do
						local slotName = (cs.name or ""):match("^%s*(.-)%s*$")
						if slotName ~= "" and slotName ~= "No Feature" then
							fn.slots[#fn.slots + 1] = { name = slotName, dmxFrom = hex(display(cs, "DMXFrom")), dmxTo = hex(display(cs, "DMXTo")) }
						end
					end
					entry.functions[#entry.functions + 1] = fn
				end
			end
		end
	end
	return map, order
end

-- "Shutter1Strobe", "Shutter1Strobe 2" and the function's attribute all name the same channel function.
local function fnMatches(fn, wanted)
	wanted = tostring(wanted):lower()
	local name = fn.name:lower()
	return name == wanted or name:gsub("%s+%d+$", "") == wanted or tostring(fn.attribute or ""):lower() == wanted
end

local function physToDmx(fn, phys)
	if fn.physTo == fn.physFrom then return fn.dmxFrom end
	return math.floor(fn.dmxFrom + (phys - fn.physFrom) / (fn.physTo - fn.physFrom) * (fn.dmxTo - fn.dmxFrom) + 0.5)
end

local function dmxToPhys(fn, dmx)
	if fn.dmxTo == fn.dmxFrom then return fn.physFrom end
	return fn.physFrom + (dmx - fn.dmxFrom) / (fn.dmxTo - fn.dmxFrom) * (fn.physTo - fn.physFrom)
end

-- One requested value -> { fn, phys, dmxMin, dmxMax } for a fixture's attribute.
-- value: { slot = "C3" } | { percent = 0..100 } | { physical = number }, optional function = "<function name>".
local function resolveValue(entry, value, label)
	local fns = entry.functions
	if type(value.slot) == "string" then
		local wanted = value.slot:lower()
		for _, fn in ipairs(fns) do
			if value["function"] == nil or fnMatches(fn, value["function"]) then
				for _, slot in ipairs(fn.slots) do
					if slot.name:lower() == wanted then
						local center = (slot.dmxFrom + slot.dmxTo) // 2
						return { fn = fn, phys = dmxToPhys(fn, center), dmxMin = slot.dmxFrom, dmxMax = slot.dmxTo }
					end
				end
			end
		end
		local names = {}
		for _, fn in ipairs(fns) do
			for _, slot in ipairs(fn.slots) do names[#names + 1] = slot.name end
		end
		fail("bad-value", label .. ": no slot '" .. value.slot .. "' (slots: " .. table.concat(names, ", ") .. ")")
	end
	local fn = fns[1]
	if value["function"] ~= nil then
		fn = nil
		for _, f in ipairs(fns) do
			if not fn and fnMatches(f, value["function"]) then fn = f end
		end
		if not fn then fail("bad-value", label .. ": no function '" .. tostring(value["function"]) .. "'") end
	end
	if not fn then fail("bad-value", label .. ": attribute has no channel functions") end
	local phys
	if type(value.percent) == "number" then
		phys = fn.physFrom + math.max(0, math.min(100, value.percent)) / 100 * (fn.physTo - fn.physFrom)
	elseif type(value.physical) == "number" then
		local lo, hi = math.min(fn.physFrom, fn.physTo), math.max(fn.physFrom, fn.physTo)
		if value.physical < lo - 1e-6 or value.physical > hi + 1e-6 then
			fail("bad-value", string.format("%s: %s is outside %s..%s", label, tostring(value.physical), tostring(fn.physFrom), tostring(fn.physTo)))
		end
		phys = value.physical
	else
		fail("bad-value", label .. ": give slot, percent or physical")
	end
	local dmx = physToDmx(fn, phys)
	local tolerance = math.max(0x020202, math.abs(fn.dmxTo - fn.dmxFrom) // 100)
	return { fn = fn, phys = phys, dmxMin = math.max(0, dmx - tolerance), dmxMax = math.min(0xFFFFFF, dmx + tolerance), exact = dmx }
end

local function poolOf(no)
	local pool = DataPool().PresetPools[math.tointeger(no) or -1]
	if not pool then fail("not-found", "no preset pool " .. tostring(no)) end
	return pool
end

-- args: { type, mode? } -> the type's attributes with functions, physical ranges and named slots.
ops["fixture.attributes"] = function(args)
	local ft = ShowData().LivePatch.FixtureTypes[checkName(args.type, "type")]
	if not ft then fail("not-found", "fixture type '" .. tostring(args.type) .. "' is not in the show") end
	local mode = args.mode and ft.DMXModes[args.mode] or ft.DMXModes:Ptr(1)
	if not mode then fail("not-found", "no mode '" .. tostring(args.mode) .. "'") end
	local map, order = attributeMap(mode)
	local out = {}
	for _, attr in ipairs(order) do
		local fns = {}
		for i, fn in ipairs(map[attr].functions) do
			local slots = {}
			for j, slot in ipairs(fn.slots) do slots[j] = slot.name end
			fns[i] = { name = fn.name, attribute = fn.attribute, physFrom = fn.physFrom, physTo = fn.physTo, slots = slots }
		end
		out[#out + 1] = { attribute = attr, functions = fns }
	end
	return { type = ft.name, mode = mode.name, attributes = out }
end

ops["preset.list"] = function(args)
	local out = {}
	for _, pool in ipairs(DataPool().PresetPools:Children()) do
		local poolNo = tonumber(tostring(display(pool, "No")):match("^%d+"))
		if args.pool == nil or poolNo == math.tointeger(args.pool) then
			for _, p in ipairs(pool:Children()) do
				local fixtures, attrs = {}, {}
				local okData, data = pcall(GetPresetData, p)
				if okData and type(data) == "table" and type(data.by_fixtures) == "table" then
					for fid, values in pairs(data.by_fixtures) do
						fixtures[#fixtures + 1] = tonumber(fid)
						for attr in pairs(values) do attrs[attr] = true end
					end
				end
				local attrList = {}
				for attr in pairs(attrs) do attrList[#attrList + 1] = attr end
				table.sort(fixtures)
				table.sort(attrList)
				out[#out + 1] = { pool = poolNo, poolName = pool.name, no = tonumber(tostring(display(p, "No")):match("^%d+")), name = p.name, fixtures = fixtures, attributes = attrList }
			end
		end
	end
	return out
end

-- Where fixture i (0-based) of n sits in a phase pattern, like MAtricks on one axis: blocks (neighbours share a step),
-- groups (every n-th fixture shares a step), wings (the pattern mirrored across n wings), invert (reversed order).
-- Returns the step index and the number of steps.
local function patternIndex(i, n, pattern)
	local idx, count = i, n
	local blocks = math.max(1, math.tointeger(pattern.blocks) or 1)
	if blocks > 1 then
		idx, count = idx // blocks, math.ceil(count / blocks)
	end
	local groups = math.max(1, math.tointeger(pattern.groups) or 1)
	if groups > 1 then
		idx, count = idx % groups, math.min(groups, count)
	end
	local wings = math.max(1, math.tointeger(pattern.wings) or 1)
	if wings > 1 then
		local per = math.ceil(count / wings)
		local wing = idx // per
		local pos = idx % per
		if wing % 2 == 1 then pos = per - 1 - pos end
		idx, count = pos, per
	end
	if pattern.invert then idx = count - 1 - idx end
	return idx, count
end

-- args: { pool, no, name, overwrite, entries = [{ fids = [...], values = { <attribute> = value } }] }
ops["preset.store"] = function(args)
	local pool = poolOf(args.pool)
	local no = groupNo(args.no)
	local name = args.name
	if type(name) ~= "string" or name == "" or #name > 200 then fail("bad-args", "name must be a non-empty string") end
	if type(args.entries) ~= "table" or #args.entries == 0 then fail("bad-args", "entries must be a non-empty array") end
	local existing = pool[no]
	if existing and not args.overwrite then
		fail("exists", string.format("preset %s.%d already exists ('%s'); pass overwrite to replace it", tostring(args.pool), no, tostring(existing.name)))
	end

	local live = ShowData().LivePatch
	local maps, phasers, expected, problems = {}, {}, {}, {}
	local gridPos = 0
	local seenFid = {}
	local effects = {}
	for _, entry in ipairs(args.entries) do
		local entryCount = #(entry.fids or {})
		for entryIndex, value in ipairs(entry.fids or {}) do
			local fid = math.tointeger(value)
			local f = fid and findFixture(live, fid)
			if not f then
				problems[#problems + 1] = "no fixture with FID " .. tostring(value)
				problems[problems[#problems]] = {}
			elseif seenFid[fid] then
				problems[#problems + 1] = "FID " .. fid .. " appears in more than one entry"
				problems[problems[#problems]] = {}
			else
				seenFid[fid] = true
				local mode = f:Get("ModeDirect")
				local key = mode and mode:ToAddr() or "?"
				maps[key] = maps[key] or (mode and attributeMap(mode))
				local map = maps[key] or {}
				local typeName = f:Get("FixtureType") and f:Get("FixtureType").name or "?"
				for attr, v in pairs(entry.values or {}) do
					local label = string.format("%s %s", typeName, attr)
					local function problem(message)
						if not problems[message] then
							problems[message] = {}
							problems[#problems + 1] = message
						end
						table.insert(problems[message], fid)
					end
					if not map[attr] then
						problem(label .. ": this fixture type has no such attribute")
					elseif type(v.effect) == "table" then
						-- An effect (phaser): steps, speed in BPM, phase spread over the entry's fixtures.
						local eff = v.effect
						local ok, built = pcall(function()
							if type(eff.steps) ~= "table" or #eff.steps < 2 or #eff.steps > 48 then fail("bad-value", label .. ": an effect needs 2 to 48 steps") end
							local bpm = tonumber(eff.bpm) or 60
							local master = math.tointeger(eff.speedMaster)
							if eff.speedMaster ~= nil and (not master or master < 1 or master > 16) then fail("bad-value", label .. ": speedMaster must be 1-16") end
							if bpm <= 0 or bpm > 3000 then fail("bad-value", label .. ": bpm must be between 0 and 3000") end
							local spread = type(eff.phase) == "table" and eff.phase or {}
							local from, to = tonumber(spread.from) or 0, tonumber(spread.to) or 0
							local slot, slots = patternIndex(entryIndex - 1, entryCount, type(eff.pattern) == "table" and eff.pattern or {})
							local phase = from + (to - from) * slot / math.max(1, slots)
							local stepXml, stepRanges = {}, {}
							for si, step in ipairs(eff.steps) do
								local r = resolveValue(map[attr], step, label .. " step " .. si)
								local target = r.exact or (r.dmxMin + r.dmxMax) // 2
								stepXml[si] = string.format('<Step Function="%s" Absolute="%.6f" Accel="0" Decel="0" Trans="%s" Width="%s"/>',
									xmlEscape(r.fn.attribute or attr), target / 0xFFFFFF * 100, tostring(tonumber(step.trans) or 100), tostring(tonumber(step.width) or 100))
								stepRanges[si] = { min = r.dmxMin, max = r.dmxMax }
							end
							return {
								-- SpeedMaster is a reference by the master's current name ("Speed1", or its label once renamed);
								-- a bare number is misread as an index.
								xml = string.format('            <Phaser IDType="0" ID="%d" Attribute="%s" Speed="%d" SpeedMaster="%s" Phase="%s" Measure="16777216" GridPos="%d" GridPosMatr="%d" Selective="Selective">%s</Phaser>',
									fid, xmlEscape(attr), math.floor(bpm / 60 * 16777216 + 0.5), master and xmlEscape(MasterPool().Speed[master].name) or "None", string.format("%.4f", phase), gridPos, gridPos, table.concat(stepXml)),
								effect = { fid = fid, attribute = attr, speed = bpm / 60, phase = phase % 360, steps = stepRanges, master = master },
							}
						end)
						if not ok then
							problem(type(built) == "table" and built.message or tostring(built))
						else
							phasers[#phasers + 1] = built.xml
							effects[#effects + 1] = built.effect
						end
					else
						local ok, resolved = pcall(resolveValue, map[attr], v, label)
						if not ok then
							problem(type(resolved) == "table" and resolved.message or tostring(resolved))
						else
							-- "Absolute" is percent of the whole channel, i.e. exact DMX, and MA picks the channel function
							-- from it. (Function + AbsolutePhys is ambiguous when several functions share an attribute.)
							local target = resolved.exact or (resolved.dmxMin + resolved.dmxMax) // 2
							phasers[#phasers + 1] = string.format(
								'            <Phaser IDType="0" ID="%d" Attribute="%s" GridPos="%d" GridPosMatr="%d" Selective="Selective"><Step Function="%s" Absolute="%.6f"/></Phaser>',
								fid, xmlEscape(attr), gridPos, gridPos, xmlEscape(resolved.fn.attribute or attr), target / 0xFFFFFF * 100)
							expected[#expected + 1] = { fid = fid, attribute = attr, min = resolved.dmxMin, max = resolved.dmxMax }
						end
					end
				end
				gridPos = gridPos + 1
			end
		end
	end
	if #problems > 0 then
		local lines = {}
		for i, message in ipairs(problems) do
			local fids = problems[message] or {}
			lines[i] = #fids > 0 and string.format("%s (FID %s)", message, table.concat(fids, ", ")) or message
		end
		fail("bad-value", table.concat(lines, "; "))
	end
	if #phasers == 0 then fail("bad-args", "no values to store") end

	local backup
	if existing then
		local sep = GetPathSeparator()
		local dir = GetPath(Enums.PathType.Library) .. sep .. "datapools" .. sep .. "presets"
		CreateDirectoryRecursive(dir)
		local file = string.format("grandmcp-backup-%s-preset%s.%d.xml", os.date("%Y%m%d-%H%M%S"), tostring(args.pool), no)
		if existing:Export(dir, file) then backup = dir .. sep .. file end
	end

	local xml = table.concat({
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<GMA3 DataVersion="' .. xmlEscape(BuildDetails().BigVersion) .. '">',
		'    <Preset Name="' .. xmlEscape(name) .. '">',
		'        <PresetData Size="' .. #phasers .. '">',
		table.concat(phasers, "\n"),
		"        </PresetData>",
		"    </Preset>",
		"</GMA3>",
	}, "\n")
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_preset.xml"
	local f = io.open(dir .. sep .. file, "w")
	if not f then fail("write-failed", "cannot write " .. dir .. sep .. file) end
	f:write(xml)
	f:close()
	local p = existing or pool:Create(no)
	local scratch
	if not p then
		-- Pools nothing was ever stored in (the All pools 21-25 in a new show) have no slots yet, so Create fails.
		-- Import into a free slot of the Dimmer pool and move it over; that also gives the pool its slots.
		guardIdle()
		local dimmers = DataPool().PresetPools[1]
		for slot = 999, 900, -1 do
			if not dimmers[slot] then
				scratch = slot
				break
			end
		end
		p = scratch and dimmers:Create(scratch)
		if not p then fail("import-failed", "could not create preset " .. tostring(args.pool) .. "." .. no) end
	end
	local okImport, imported = pcall(p.Import, p, dir .. sep, file)
	os.remove(dir .. sep .. file)
	if not okImport or not imported then fail("import-failed", "MA could not import the preset") end
	if scratch then
		CmdIndirect(string.format("Move Preset 1.%d At Preset %d.%d", scratch, math.tointeger(args.pool), no))
		local t0 = socket.gettime()
		repeat
			coroutine.yield(0.05)
			if GetTopModal() ~= nil then failModal("a pop-up opened while moving the preset into pool " .. tostring(args.pool)) end
		until pool[no] ~= nil or socket.gettime() - t0 > 5
		if not pool[no] then fail("import-failed", "could not move the preset into pool " .. tostring(args.pool)) end
	end

	-- Verify what MA made of it, per fixture and attribute.
	p = pool[no]
	local okData, data = pcall(GetPresetData, p)
	local byFixture = okData and type(data) == "table" and data.by_fixtures or {}
	local mismatches = {}
	for _, e in ipairs(expected) do
		local v = byFixture[e.fid] or byFixture[tostring(e.fid)]
		local step = v and v[e.attribute] and v[e.attribute][1]
		local dmx = step and step.absolute_value
		if dmx and dmx > 0xFFFFFF then dmx = 0xFFFFFF end -- MA writes full as 2^24
		if not dmx or dmx < e.min or dmx > e.max then
			mismatches[#mismatches + 1] = string.format("FID %d %s: expected DMX %06X-%06X, got %s", e.fid, e.attribute, e.min, e.max, dmx and string.format("%06X", dmx) or "nothing")
		end
	end
	local exported = #effects > 0 and exportText(p) or ""
	for _, e in ipairs(effects) do
		local masterName = e.master and xmlEscape(MasterPool().Speed[e.master].name):gsub("%p", "%%%0")
		if e.master and not exported:find(string.format('ID="%d" Attribute="%s"[^>]-SpeedMaster="%s"', e.fid, e.attribute, masterName)) then
			mismatches[#mismatches + 1] = string.format("FID %d %s: not linked to speed master %d", e.fid, e.attribute, e.master)
		end
		local v = byFixture[e.fid] or byFixture[tostring(e.fid)]
		local d = v and v[e.attribute]
		if not d then
			mismatches[#mismatches + 1] = string.format("FID %d %s: effect missing", e.fid, e.attribute)
		else
			if math.abs((tonumber(d.speed) or -1) - e.speed) > 0.01 then
				mismatches[#mismatches + 1] = string.format("FID %d %s: speed %s instead of %.3f", e.fid, e.attribute, tostring(d.speed), e.speed)
			end
			local diff = math.abs(((tonumber(d.phase) or 0) - e.phase + 180) % 360 - 180)
			if diff > 0.5 then mismatches[#mismatches + 1] = string.format("FID %d %s: phase %s instead of %.1f", e.fid, e.attribute, tostring(d.phase), e.phase) end
			for si, range in ipairs(e.steps) do
				local dmx = d[si] and d[si].absolute_value
				if dmx and dmx > 0xFFFFFF then dmx = 0xFFFFFF end
				if not dmx or dmx < range.min or dmx > range.max then
					mismatches[#mismatches + 1] = string.format("FID %d %s step %d: expected DMX %06X-%06X, got %s", e.fid, e.attribute, si, range.min, range.max, dmx and string.format("%06X", dmx) or "nothing")
				end
			end
		end
	end
	return { pool = math.tointeger(args.pool), no = no, name = p.name, values = #expected, effects = #effects, verified = #mismatches == 0, mismatches = mismatches, backup = backup }
end

---------------------------------------------------------------------------
-- Sequences and executors. A sequence is written as MA XML: OffCue and CueZero first (MA maps cues by position),
-- names on both Cue and Part, timing on the Part. Looks either reference a preset ("s<pool>.<no>", so the cue follows
-- the preset when it changes) or carry their own values.
---------------------------------------------------------------------------

local TRIGGERS = { go = "Go", follow = "Follow", time = "Time" }

-- The executor whose area covers slot `exec` on a page: wide executors (Width > 1) also cover the slots to their right.
local function coveringExecutor(page, exec)
	local p = DataPool().Pages[page]
	for _, e in ipairs(p and p:Children() or {}) do
		local no = tonumber(tostring(display(e, "No")):match("^%d+"))
		local width = tonumber(display(e, "Width")) or 1
		if no and exec >= no and exec < no + width then return e, no end
	end
	return nil
end

-- Every executor (all pages) that holds this object, with its configuration, so it can be restored.
local function executorsHolding(obj)
	local found = {}
	for _, p in ipairs(DataPool().Pages:Children()) do
		local page = tonumber(tostring(display(p, "No")):match("^%d+"))
		for _, e in ipairs(p:Children()) do
			if e:Get("Object") == obj then
				found[#found + 1] = {
					page = page, exec = tonumber(tostring(display(e, "No")):match("^%d+")),
					Fader = display(e, "Fader"), KeyPress = display(e, "KeyPress"), KeyUnpress = display(e, "KeyUnpress"),
					Width = display(e, "Width"), Height = display(e, "Height"),
				}
			end
		end
	end
	return found
end

local function presetLookPhasers(look, live, maps, problems, phasers)
	local poolNo, presetNo = math.tointeger(look.preset.pool), math.tointeger(look.preset.no)
	local pool = DataPool().PresetPools[poolNo or -1]
	local preset = pool and pool[presetNo or -1]
	if not preset then
		problems[#problems + 1] = string.format("no preset %s.%s", tostring(look.preset.pool), tostring(look.preset.no))
		return
	end
	local okData, data = pcall(GetPresetData, preset)
	local byFixture = okData and type(data) == "table" and data.by_fixtures or {}
	local wanted
	if type(look.fids) == "table" then
		wanted = {}
		for _, fid in ipairs(look.fids) do wanted[math.tointeger(fid) or -1] = true end
	end
	local count = 0
	for fidKey, attrs in pairs(byFixture) do
		local fid = math.tointeger(tonumber(fidKey))
		if fid and (not wanted or wanted[fid]) then
			local f = findFixture(live, fid)
			local mode = f and f:Get("ModeDirect")
			local key = mode and mode:ToAddr() or "?"
			maps[key] = maps[key] or (mode and attributeMap(mode))
			local map = maps[key] or {}
			for attr, v in pairs(attrs) do
				local step = type(v) == "table" and v[1]
				if step and step.absolute_value then
					local fns = map[attr] and map[attr].functions or {}
					local fn = fns[(step.channel_function or 0) + 1] or fns[1]
					local dmx = math.min(step.absolute_value, 0xFFFFFF)
					phasers[#phasers + 1] = string.format(
						'<Phaser IDType="0" ID="%d" Attribute="%s" AbsPreset="s%d.%d" GridPos="*%d" Selective="Selective"><Step Function="%s" Absolute="*%.6f"/></Phaser>',
						fid, xmlEscape(attr), poolNo, presetNo, v.gridpos or 0, xmlEscape(fn and fn.attribute or attr), dmx / 0xFFFFFF * 100)
					count = count + 1
				end
			end
		end
	end
	if count == 0 then problems[#problems + 1] = string.format("preset %d.%d has no values for the given fixtures", poolNo, presetNo) end
end

local function valueLookPhasers(look, live, maps, problems, phasers)
	for i, value in ipairs(look.fids or {}) do
		local fid = math.tointeger(value)
		local f = fid and findFixture(live, fid)
		if not f then
			problems[#problems + 1] = "no fixture with FID " .. tostring(value)
		else
			local mode = f:Get("ModeDirect")
			local key = mode and mode:ToAddr() or "?"
			maps[key] = maps[key] or (mode and attributeMap(mode))
			local map = maps[key] or {}
			local typeName = f:Get("FixtureType") and f:Get("FixtureType").name or "?"
			for attr, v in pairs(look.values or {}) do
				local label = string.format("FID %d (%s) %s", fid, typeName, attr)
				if not map[attr] then
					problems[#problems + 1] = label .. ": this fixture type has no such attribute"
				else
					local ok, resolved = pcall(resolveValue, map[attr], v, label)
					if not ok then
						problems[#problems + 1] = type(resolved) == "table" and resolved.message or tostring(resolved)
					else
						local target = resolved.exact or (resolved.dmxMin + resolved.dmxMax) // 2
						phasers[#phasers + 1] = string.format(
							'<Phaser IDType="0" ID="%d" Attribute="%s" GridPos="%d" Selective="Selective"><Step Function="%s" Absolute="%.6f"/></Phaser>',
							fid, xmlEscape(attr), i - 1, xmlEscape(resolved.fn.attribute or attr), target / 0xFFFFFF * 100)
					end
				end
			end
		end
	end
end

local function cueTiming(cue)
	local part = {}
	for key, prop in pairs({ fade = "CueInFade", outFade = "CueOutFade", delay = "CueInDelay", outDelay = "CueOutDelay" }) do
		if type(cue[key]) == "number" then part[#part + 1] = string.format('%s="%s"', prop, tostring(cue[key])) end
	end
	return table.concat(part, " ")
end

local function cueInfo(c)
	local function g(o, p)
		if not o then return nil end
		local ok, v = pcall(o.Get, o, p, Enums.Roles.Display)
		return ok and v or nil
	end
	local part = c:Ptr(1)
	return {
		no = tonumber((g(c, "No") or ""):match("[%d%.]+") or ""),
		name = c.name,
		trigger = g(c, "TrigType"),
		triggerTime = g(c, "TrigTime"),
		fade = g(part, "CueInFade"),
		outFade = g(part, "CueOutFade"),
	}
end

ops["sequence.list"] = function()
	local out = {}
	for i, s in ipairs(DataPool().Sequences:Children()) do
		local cues = {}
		for _, c in ipairs(s:Children()) do
			local info = cueInfo(c)
			if info.no and info.no > 0 then cues[#cues + 1] = info end
		end
		out[#out + 1] = { no = tonumber(tostring(display(s, "No")):match("^%d+")), name = s.name, cues = cues }
		if i % 25 == 0 then coroutine.yield() end
	end
	return out
end

-- args: { no, name, overwrite, cues = [{ no, name, fade?, outFade?, delay?, outDelay?, trigger?, triggerTime?,
--         looks = [{ preset = { pool, no }, fids? } | { fids, values }] }] }
ops["sequence.store"] = function(args)
	local no = groupNo(args.no)
	local name = args.name
	if type(name) ~= "string" or name == "" or #name > 200 then fail("bad-args", "name must be a non-empty string") end
	if type(args.cues) ~= "table" or #args.cues == 0 then fail("bad-args", "cues must be a non-empty array") end
	local pool = DataPool().Sequences
	local existing = pool[no]
	if existing and not args.overwrite then
		fail("exists", string.format("sequence %d already exists ('%s'); pass overwrite to replace it", no, tostring(existing.name)))
	end

	local live = ShowData().LivePatch
	local maps, problems, cueXml, expectedPhasers = {}, {}, {}, 0
	for i, cue in ipairs(args.cues) do
		local cueNo = tonumber(cue.no) or i
		local cueName = type(cue.name) == "string" and cue.name ~= "" and cue.name or ("Cue " .. tostring(cueNo))
		local phasers = {}
		for _, look in ipairs(cue.looks or {}) do
			if type(look.preset) == "table" then
				presetLookPhasers(look, live, maps, problems, phasers)
			else
				valueLookPhasers(look, live, maps, problems, phasers)
			end
		end
		local trigger = ""
		if cue.trigger ~= nil then
			local t = TRIGGERS[tostring(cue.trigger):lower()]
			if not t then problems[#problems + 1] = "cue " .. tostring(cueNo) .. ": trigger must be go, follow or time" end
			trigger = string.format(' TrigType="%s"', t or "Go")
			if type(cue.triggerTime) == "number" then trigger = trigger .. string.format(' TrigTime="%s"', tostring(cue.triggerTime)) end
		end
		expectedPhasers = expectedPhasers + #phasers
		cueXml[#cueXml + 1] = string.format(
			'        <Cue No="%s" Name="%s"%s>\n            <Part Name="%s" %s>\n                <PresetData Size="%d">\n                    %s\n                </PresetData>\n            </Part>\n        </Cue>',
			tostring(cueNo), xmlEscape(cueName), trigger, xmlEscape(cueName), cueTiming(cue), #phasers, table.concat(phasers, "\n                    "))
	end
	if #problems > 0 then fail("bad-value", table.concat(problems, "; ")) end

	local backup
	local holders = {}
	if existing then
		guardIdle()
		local sep = GetPathSeparator()
		local dir = GetPath(Enums.PathType.Library) .. sep .. "datapools" .. sep .. "sequences"
		CreateDirectoryRecursive(dir)
		local file = string.format("grandmcp-backup-%s-sequence%d.xml", os.date("%Y%m%d-%H%M%S"), no)
		if existing:Export(dir, file) then backup = dir .. sep .. file end
		-- Replace by recreating: importing over an existing sequence merges cue by cue position. Deleting the sequence
		-- also empties the executors holding it, so remember them and put it back afterwards.
		holders = executorsHolding(existing)
		CmdIndirect(string.format("Delete Sequence %d /NoConfirmation", no))
		local t0 = socket.gettime()
		repeat
			coroutine.yield(0.05)
			if GetTopModal() ~= nil then failModal("a pop-up opened while replacing sequence " .. no) end
		until pool[no] == nil or socket.gettime() - t0 > 5
		if pool[no] ~= nil then fail("replace-failed", "could not remove the old sequence " .. no) end
	end

	local xml = table.concat({
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<GMA3 DataVersion="' .. xmlEscape(BuildDetails().BigVersion) .. '">',
		'    <Sequence Name="' .. xmlEscape(name) .. '">',
		'        <Cue Name="OffCue" Release="Yes" Assert="Assert"><Part/></Cue>',
		'        <Cue Name="CueZero" No="0"><Part/></Cue>',
		table.concat(cueXml, "\n"),
		"    </Sequence>",
		"</GMA3>",
	}, "\n")
	local sep = GetPathSeparator()
	local dir, file = GetPath(Enums.PathType.Temp), "grandmcp_sequence.xml"
	local f = io.open(dir .. sep .. file, "w")
	if not f then fail("write-failed", "cannot write " .. dir .. sep .. file) end
	f:write(xml)
	f:close()
	local s = pool:Create(no)
	if not s then fail("import-failed", "could not create sequence " .. no) end
	local okImport, imported = pcall(s.Import, s, dir .. sep, file)
	os.remove(dir .. sep .. file)
	if not okImport or not imported then fail("import-failed", "MA could not import the sequence") end

	s = pool[no]
	local restored = {}
	for _, h in ipairs(holders) do
		CmdIndirect(string.format("Assign Sequence %d At Page %d.%d", no, h.page, h.exec))
		local t0, e = socket.gettime(), nil
		repeat
			coroutine.yield(0.05)
			e = coveringExecutor(h.page, h.exec)
		until (e and e:Get("Object") == pool[no]) or socket.gettime() - t0 > 3
		if e and e:Get("Object") == pool[no] then
			for _, prop in ipairs({ "Width", "Height", "Fader", "KeyPress", "KeyUnpress" }) do
				if h[prop] and h[prop] ~= "" then pcall(e.Set, e, prop, h[prop]) end
			end
			restored[#restored + 1] = string.format("%d.%d", h.page, h.exec)
		end
	end
	local cues = {}
	for _, c in ipairs(s:Children()) do
		local info = cueInfo(c)
		if info.no and info.no > 0 then cues[#cues + 1] = info end
	end
	local text = exportText(s) or ""
	local _, phaserCount = text:gsub("<Phaser ", "")
	local verified = #cues == #args.cues and phaserCount >= expectedPhasers and #restored == #holders
	return { no = no, name = s.name, cues = cues, values = phaserCount, expectedValues = expectedPhasers, verified = verified, backup = backup, executors = restored, executorsLost = #holders - #restored }
end

-- args: { sequence, page, executor }
ops["executor.assign"] = function(args)
	local seqNo, page, exec = math.tointeger(args.sequence), math.tointeger(args.page), math.tointeger(args.executor)
	if not seqNo or not page or not exec then fail("bad-args", "sequence, page and executor must be integers") end
	if not DataPool().Sequences[seqNo] then fail("not-found", "no sequence " .. seqNo) end
	guardIdle()
	-- MA silently replaces whatever is on the executor (or on the wide executor covering this slot), so only when asked.
	local cover, coverNo = coveringExecutor(page, exec)
	local obj = cover and cover:Get("Object")
	if obj and obj ~= DataPool().Sequences[seqNo] and not args.overwrite then
		local where = coverNo ~= exec and string.format(" (slot %d is part of the wide executor %d)", exec, coverNo) or ""
		fail("exists", string.format("executor %d.%d already holds %s '%s'%s; pass overwrite to replace it", page, coverNo, obj:GetClass(), tostring(obj.name), where))
	end
	CmdIndirect(string.format("Assign Sequence %d At Page %d.%d", seqNo, page, exec))
	local function assigned()
		local e = coveringExecutor(page, exec)
		local o = e and e:Get("Object")
		return o ~= nil and o == DataPool().Sequences[seqNo]
	end
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while assigning the executor") end
	until assigned() or socket.gettime() - t0 > 5
	if not assigned() then fail("assign-failed", string.format("executor %d.%d does not show sequence %d", page, exec, seqNo)) end
	return { sequence = seqNo, page = page, executor = exec, name = DataPool().Sequences[seqNo].name }
end

local function findExecutor(page, exec)
	local p = DataPool().Pages[page]
	for _, e in ipairs(p and p:Children() or {}) do
		if tonumber(tostring(display(e, "No")):match("^%d+")) == exec then return e end
	end
	return nil
end

local function executorInfo(e)
	local obj = e:Get("Object")
	return {
		executor = tonumber(tostring(display(e, "No")):match("^%d+")),
		class = obj and obj:GetClass() or nil,
		name = obj and obj.name or nil,
		no = obj and tonumber(tostring(display(obj, "No") or ""):match("^%d+")) or nil,
		fader = display(e, "Fader"),
		button = display(e, "KeyPress"),
		release = display(e, "KeyUnpress"),
		width = tonumber(display(e, "Width")),
		height = tonumber(display(e, "Height")),
	}
end

-- args: { page } -> executors on the page that have something assigned.
ops["executor.list"] = function(args)
	local page = math.tointeger(args.page) or 1
	local p = DataPool().Pages[page]
	if not p then fail("not-found", "no page " .. page) end
	local out = {}
	for _, e in ipairs(p:Children()) do
		if e:Get("Object") then out[#out + 1] = executorInfo(e) end
	end
	return { page = page, name = p.name, executors = out }
end

-- args: { page, executor, fader?, button?, release?, width?, height? }
ops["executor.configure"] = function(args)
	local page, exec = math.tointeger(args.page) or 1, math.tointeger(args.executor)
	local e = exec and findExecutor(page, exec)
	if not e or not e:Get("Object") then fail("not-found", string.format("executor %d.%s has nothing assigned", page, tostring(args.executor))) end
	local problems = {}
	for key, prop in pairs({ fader = "Fader", button = "KeyPress", release = "KeyUnpress", width = "Width", height = "Height" }) do
		local value = args[key]
		if value ~= nil then
			local old = display(e, prop)
			local ok = pcall(e.Set, e, prop, tostring(value))
			local now = display(e, prop)
			if not ok or tostring(now):lower() ~= tostring(value):lower() then
				problems[#problems + 1] = string.format("%s '%s' was not accepted (still '%s')", key, tostring(value), tostring(now))
				pcall(e.Set, e, prop, old)
			end
		end
	end
	if #problems > 0 then fail("bad-value", table.concat(problems, "; ")) end
	return executorInfo(e)
end

-- args: { master (1-16), bpm?, label?, page?, executor?, overwrite? } -> sets a speed master and optionally puts it on
-- an executor (grandMA3 then makes its button a tap: LearnSpeed).
ops["speedmaster.set"] = function(args)
	local no = math.tointeger(args.master)
	if not no or no < 1 or no > 16 then fail("bad-args", "master must be 1-16") end
	local sm = MasterPool().Speed[no]
	guardIdle()
	local function run(command)
		CmdIndirect(command)
		local t0, last = socket.gettime(), nil
		repeat
			coroutine.yield(0.05)
			if GetTopModal() ~= nil then failModal("a pop-up opened during: " .. command) end
			last = display(CmdObj(), "LastCommand") or ""
		until last:find(command, 1, true) or socket.gettime() - t0 > 3
		if not last:find("^OK") then fail("command-failed", command .. ": " .. tostring(last)) end
	end
	if args.bpm ~= nil then
		local bpm = tonumber(args.bpm)
		if not bpm or bpm <= 0 or bpm > 3000 then fail("bad-args", "bpm must be between 0 and 3000") end
		run(string.format("Master 3.%d At BPM %s", no, tostring(bpm)))
	end
	if args.label ~= nil then
		if type(args.label) ~= "string" or args.label == "" or args.label:find('"', 1, true) then fail("bad-args", "label must be a non-empty string without quotes") end
		run(string.format('Label Master 3.%d "%s"', no, args.label))
	end
	local placed
	if args.executor ~= nil then
		local page, exec = math.tointeger(args.page) or 1, math.tointeger(args.executor)
		local e, coverNo = coveringExecutor(page, exec)
		local current = e and e:Get("Object")
		if current and current ~= sm and not args.overwrite then
			local where = coverNo ~= exec and string.format(" (slot %d is part of the wide executor %d)", exec, coverNo) or ""
			fail("exists", string.format("executor %d.%d already holds %s '%s'%s; pass overwrite to replace it", page, coverNo, current:GetClass(), tostring(current.name), where))
		end
		run(string.format("Assign Master 3.%d At Page %d.%d", no, page, exec))
		e = coveringExecutor(page, exec)
		placed = e and executorInfo(e)
	end
	return { master = no, name = sm.name, fader = display(sm, "NormedValue"), executor = placed }
end

-- args: { no, name } -> creates the page if needed and names it.
ops["page.store"] = function(args)
	local no = math.tointeger(args.no)
	if not no or no < 1 or no > 9999 then fail("bad-args", "page must be 1-9999") end
	if type(args.name) ~= "string" or args.name == "" or args.name:find('"', 1, true) then fail("bad-args", "name must be a non-empty string without quotes") end
	guardIdle()
	if not DataPool().Pages[no] then CmdIndirect(string.format("Store Page %d", no)) end
	CmdIndirect(string.format('Label Page %d "%s"', no, args.name))
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while storing page " .. no) end
	until (DataPool().Pages[no] and DataPool().Pages[no].name == args.name) or socket.gettime() - t0 > 3
	local p = DataPool().Pages[no]
	if not p or p.name ~= args.name then fail("page-failed", "page " .. no .. " was not created or named") end
	return { no = no, name = p.name }
end

---------------------------------------------------------------------------
-- Screenshots, taken by grandMA3 itself ("Store Image ... /Screen"), so they work on any OS and over the network.
-- The image lands in the show's image pool, is exported (PNG as base64 blocks) and deleted again.
---------------------------------------------------------------------------

-- args: { screen = 1, full = false }
ops["screen.capture"] = function(args)
	local screen = math.tointeger(args.screen) or 1
	if screen < 1 or screen > 16 then fail("bad-args", "screen must be 1-16") end
	guardIdle()
	local images = ShowData().MediaPools.Images
	local slot
	for n = 999, 900, -1 do
		if not images[n] then
			slot = n
			break
		end
	end
	if not slot then fail("busy", "no free scratch slot in the image pool (900-999)") end
	CmdIndirect(string.format('Store Image 3.%d /Screen "%d" /ScreenOnly "%s"', slot, screen, args.full and "No" or "Yes"))
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened while taking the screenshot") end
	until images[slot] ~= nil or socket.gettime() - t0 > 5
	if not images[slot] then fail("capture-failed", "grandMA3 did not store a screenshot of screen " .. screen .. " (does that screen exist?)") end
	local text = exportText(images[slot]) or ""
	CmdIndirect(string.format("Delete Image 3.%d /NoConfirmation", slot))
	local blocks = {}
	for b64 in text:gmatch('Base64="([^"]*)"') do blocks[#blocks + 1] = b64 end
	t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
	until images[slot] == nil or socket.gettime() - t0 > 3
	if #blocks == 0 then fail("capture-failed", "the screenshot could not be read back") end
	return { screen = screen, blocks = blocks }
end

local function find3dSettings(screen)
	local d = GetDisplayByIndex(screen)
	if not d then return nil end
	local view
	local function walk(h, depth)
		if depth > 10 or view then return end
		for _, c in ipairs(h:Children()) do
			if c:GetClass() == "View3D" then
				view = c
				return
			end
			walk(c, depth + 1)
		end
	end
	walk(d, 0)
	local window = view and view:Parent() and view:Parent():Parent() and view:Parent():Parent():Parent()
	return window and window.WindowSettings
end

-- args: { screen = 1, camera = "Front" } -> makes sure a 3D window is on the screen and picks the camera.
ops["view3d"] = function(args)
	local screen = math.tointeger(args.screen) or 1
	local cameras = {}
	for _, cam in ipairs(CurrentProfile().Cameras:Children()) do cameras[#cameras + 1] = cam.name end
	local settings = find3dSettings(screen)
	local created = false
	if not settings then
		guardIdle()
		-- The same command grandMA3's own Add Window dialog uses.
		CmdIndirect(string.format('Store ScreenContent %d "Window3D" /NC', screen))
		local t0 = socket.gettime()
		repeat
			coroutine.yield(0.1)
			if GetTopModal() ~= nil then failModal("a pop-up opened while adding the 3D window") end
			settings = find3dSettings(screen)
		until settings or socket.gettime() - t0 > 5
		if not settings then fail("view-failed", "could not add a 3D window to screen " .. screen) end
		created = true
	end
	if args.camera ~= nil then
		local wanted, cam = tostring(args.camera):lower(), nil
		for _, c in ipairs(CurrentProfile().Cameras:Children()) do
			if c.name:lower() == wanted then cam = c end
		end
		if not cam then fail("not-found", "no camera '" .. tostring(args.camera) .. "' (cameras: " .. table.concat(cameras, ", ") .. ")") end
		settings.Camera = cam -- a reference property: assign the object, a string is ignored
	end
	return { screen = screen, created = created, camera = display(settings, "Camera"), cameras = cameras }
end

local MATRICKS_FIELDS = {
	block = "XBlock", group = "XGroup", wings = "XWings", width = "XWidth", shift = "XShift",
	phaseFrom = "PhaseFromX", phaseTo = "PhaseToX", fadeFrom = "FadeFromX", fadeTo = "FadeToX",
	delayFrom = "DelayFromX", delayTo = "DelayToX",
}

local function matricksInfo(m)
	local info = { no = tonumber(tostring(display(m, "No")):match("^%d+")), name = m.name }
	for key, prop in pairs(MATRICKS_FIELDS) do
		local v = display(m, prop)
		if v and v ~= "" and v ~= "None" then info[key] = tonumber(tostring(v):match("(-?[%d%.]+)")) end
	end
	info.invert = display(m, "XInv") == "Yes"
	return info
end

ops["matricks.list"] = function()
	local out = {}
	for _, m in ipairs(DataPool().MAtricks:Children()) do out[#out + 1] = matricksInfo(m) end
	return out
end

-- args: { no, name, overwrite, block?, group?, wings?, width?, shift?, invert?, phaseFrom?, phaseTo?, fadeFrom?, ... }
ops["matricks.store"] = function(args)
	local no = groupNo(args.no)
	if type(args.name) ~= "string" or args.name == "" or #args.name > 100 then fail("bad-args", "name must be a non-empty string") end
	local pool = DataPool().MAtricks
	local m = pool[no]
	if m and not args.overwrite then fail("exists", string.format("MAtricks %d already exists ('%s'); pass overwrite to replace it", no, tostring(m.name))) end
	m = m or pool:Create(no)
	if not m then fail("store-failed", "could not create MAtricks " .. no) end
	-- Start from a clean MAtricks so earlier settings do not linger.
	for _, prop in pairs(MATRICKS_FIELDS) do pcall(m.Set, m, prop, "None") end
	pcall(m.Set, m, "XInv", "No")
	pcall(m.Set, m, "Name", args.name)
	local problems = {}
	for key, prop in pairs(MATRICKS_FIELDS) do
		if args[key] ~= nil then
			pcall(m.Set, m, prop, tostring(args[key]))
			local have = tonumber(tostring(display(m, prop) or ""):match("(-?[%d%.]+)"))
			if have == nil or math.abs(have - tonumber(args[key])) > 0.01 then
				problems[#problems + 1] = string.format("%s %s was not accepted (now %s)", key, tostring(args[key]), tostring(display(m, prop)))
			end
		end
	end
	if args.invert then pcall(m.Set, m, "XInv", "Yes") end
	if #problems > 0 then fail("bad-value", table.concat(problems, "; ")) end
	return matricksInfo(pool[no])
end

---------------------------------------------------------------------------
-- Editing existing objects: single cues, delete / copy / rename, and reading contents back in readable form.
---------------------------------------------------------------------------

local function runCommand(command, done, timeout)
	CmdIndirect(command)
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.05)
		if GetTopModal() ~= nil then failModal("a pop-up opened during: " .. command) end
	until done() or socket.gettime() - t0 > (timeout or 4)
	if not done() then fail("command-failed", command .. " (" .. tostring(display(CmdObj(), "LastCommand")) .. ")") end
end

local function findCue(seq, cueNo)
	for _, c in ipairs(seq:Children()) do
		local no = tonumber((display(c, "No") or ""):match("[%d%.]+") or "")
		if no and math.abs(no - cueNo) < 0.0005 then return c end
	end
	return nil
end

local function exportBackup(obj, folder, label)
	local sep = GetPathSeparator()
	local dir = GetPath(Enums.PathType.Library) .. sep .. "datapools" .. sep .. folder
	CreateDirectoryRecursive(dir)
	local file = string.format("grandmcp-backup-%s-%s.xml", os.date("%Y%m%d-%H%M%S"), label)
	if obj:Export(dir, file) then return dir .. sep .. file end
	return nil
end

-- args: { sequence, cue = <cue as in sequence.store>, overwrite } -> builds the cue in a scratch sequence and copies it
-- into place, so the target sequence keeps its identity (and its executors).
ops["cue.store"] = function(args)
	local seqNo = math.tointeger(args.sequence)
	local seq = seqNo and DataPool().Sequences[seqNo]
	if not seq then fail("not-found", "no sequence " .. tostring(args.sequence)) end
	if type(args.cue) ~= "table" then fail("bad-args", "cue must be an object") end
	local cueNo = tonumber(args.cue.no)
	if not cueNo or cueNo <= 0 then fail("bad-args", "cue.no must be a positive number") end
	local existing = findCue(seq, cueNo)
	if existing and not args.overwrite then fail("exists", string.format("sequence %d already has cue %s ('%s'); pass overwrite to replace it", seqNo, tostring(cueNo), tostring(existing.name))) end
	guardIdle()
	local pool = DataPool().Sequences
	local scratch
	for n = 999, 900, -1 do
		if not pool[n] then
			scratch = n
			break
		end
	end
	if not scratch then fail("busy", "no free scratch sequence slot (900-999)") end
	local backup = existing and exportBackup(seq, "sequences", "sequence" .. seqNo)
	ops["sequence.store"]({ no = scratch, name = "grandmcp scratch", cues = { args.cue } })
	local ok, err = pcall(runCommand, string.format("Copy Sequence %d Cue %s At Sequence %d Cue %s /Overwrite /NoConfirmation", scratch, tostring(cueNo), seqNo, tostring(cueNo)),
		function() return (display(CmdObj(), "LastCommand") or ""):find("^OK: Copy") ~= nil end)
	pcall(runCommand, string.format("Delete Sequence %d /NoConfirmation", scratch), function() return pool[scratch] == nil end)
	if not ok then error(err, 0) end
	local cue = findCue(DataPool().Sequences[seqNo], cueNo)
	if not cue then fail("verify-failed", "cue " .. tostring(cueNo) .. " is not in sequence " .. seqNo .. " after the copy") end
	return { sequence = seqNo, cue = cueInfo(cue), replaced = existing ~= nil, backup = backup }
end

-- args: { sequence, cue }
ops["cue.delete"] = function(args)
	local seqNo, cueNo = math.tointeger(args.sequence), tonumber(args.cue)
	local seq = seqNo and DataPool().Sequences[seqNo]
	if not seq then fail("not-found", "no sequence " .. tostring(args.sequence)) end
	if not cueNo or not findCue(seq, cueNo) then fail("not-found", "sequence " .. seqNo .. " has no cue " .. tostring(args.cue)) end
	guardIdle()
	local backup = exportBackup(seq, "sequences", "sequence" .. seqNo)
	runCommand(string.format("Delete Sequence %d Cue %s /NoConfirmation", seqNo, tostring(cueNo)), function() return findCue(DataPool().Sequences[seqNo], cueNo) == nil end)
	return { sequence = seqNo, cue = cueNo, backup = backup }
end

-- kind = preset | sequence | group | matricks; preset addresses are "<pool>.<no>".
local POOL_KINDS = {
	preset = { keyword = "Preset", folder = "presets", get = function(a) local p = DataPool().PresetPools[math.tointeger(a.pool) or -1]; return p and p[math.tointeger(a.no) or -1] end },
	sequence = { keyword = "Sequence", folder = "sequences", get = function(a) return DataPool().Sequences[math.tointeger(a.no) or -1] end },
	group = { keyword = "Group", folder = "groups", get = function(a) return DataPool().Groups[math.tointeger(a.no) or -1] end },
	matricks = { keyword = "MAtricks", folder = "matricks", get = function(a) return DataPool().MAtricks[math.tointeger(a.no) or -1] end },
	layout = { keyword = "Layout", folder = "layouts", get = function(a) return DataPool().Layouts[math.tointeger(a.no) or -1] end },
	appearance = { keyword = "Appearance", folder = "appearances", get = function(a) return ShowData().Appearances[math.tointeger(a.no) or -1] end },
}

local function poolRef(kind, a, no)
	local k = POOL_KINDS[kind]
	if not k then fail("bad-args", "kind must be preset, sequence, group, matricks, layout or appearance") end
	if kind == "preset" then return string.format("%s %d.%d", k.keyword, math.tointeger(a.pool) or 0, math.tointeger(no) or 0), k end
	return string.format("%s %d", k.keyword, math.tointeger(no) or 0), k
end

-- args: { kind, pool?, no }
ops["pool.delete"] = function(args)
	local ref, k = poolRef(args.kind, args, args.no)
	local obj = k.get(args)
	if not obj then fail("not-found", "no " .. ref) end
	guardIdle()
	local name = obj.name
	local backup = exportBackup(obj, k.folder, (ref:gsub("%s", ""):gsub("%.", "-")))
	runCommand("Delete " .. ref .. " /NoConfirmation", function() return k.get(args) == nil end)
	return { deleted = ref, name = name, backup = backup }
end

-- args: { kind, pool?, from, to, overwrite }
ops["pool.copy"] = function(args)
	local fromRef, k = poolRef(args.kind, args, args.from)
	local toRef = poolRef(args.kind, args, args.to)
	local src = k.get({ pool = args.pool, no = args.from })
	if not src then fail("not-found", "no " .. fromRef) end
	local dst = k.get({ pool = args.pool, no = args.to })
	if dst and not args.overwrite then fail("exists", toRef .. " already exists ('" .. tostring(dst.name) .. "'); pass overwrite to replace it") end
	guardIdle()
	local backup = dst and exportBackup(dst, k.folder, (toRef:gsub("%s", ""):gsub("%.", "-")))
	runCommand(string.format("Copy %s At %s /Overwrite /NoConfirmation", fromRef, toRef), function() return k.get({ pool = args.pool, no = args.to }) ~= nil and (display(CmdObj(), "LastCommand") or ""):find("^OK") ~= nil end)
	return { copied = fromRef, to = toRef, name = k.get({ pool = args.pool, no = args.to }).name, backup = backup }
end

-- args: { kind, pool?, no, name }
ops["pool.rename"] = function(args)
	local ref, k = poolRef(args.kind, args, args.no)
	if not k.get(args) then fail("not-found", "no " .. ref) end
	if type(args.name) ~= "string" or args.name == "" or args.name:find('"', 1, true) then fail("bad-args", "name must be a non-empty string without quotes") end
	guardIdle()
	runCommand(string.format('Label %s "%s"', ref, args.name), function() return k.get(args) and k.get(args).name == args.name end)
	return { renamed = ref, name = k.get(args).name }
end

-- DMX value of one attribute -> readable: the slot it falls in, else percent of its function (and physical value).
local function describeDmx(map, attr, dmx, fnIndex)
	local entry = map[attr]
	if not entry then return { dmx = dmx } end
	local fn = entry.functions[(fnIndex or 0) + 1] or entry.functions[1]
	for _, f in ipairs(entry.functions) do
		for _, slot in ipairs(f.slots) do
			if dmx >= slot.dmxFrom and dmx <= slot.dmxTo and slot.dmxFrom ~= slot.dmxTo then return { slot = slot.name, ["function"] = f.name } end
		end
		if dmx >= (f.dmxFrom or 0) and dmx <= (f.dmxTo or 0) then fn = f end
	end
	if not fn then return { dmx = dmx } end
	local span = (fn.dmxTo or 0) - (fn.dmxFrom or 0)
	local pct = span > 0 and (dmx - fn.dmxFrom) / span * 100 or 0
	return { percent = math.floor(pct * 10 + 0.5) / 10, physical = math.floor(dmxToPhys(fn, dmx) * 1000 + 0.5) / 1000, ["function"] = fn.name }
end

-- args: { pool, no } -> per fixture and attribute: value, or effect steps/speed/phase.
ops["preset.read"] = function(args)
	local pool = poolOf(args.pool)
	local p = pool[math.tointeger(args.no) or -1]
	if not p then fail("not-found", "no preset " .. tostring(args.pool) .. "." .. tostring(args.no)) end
	local okData, data = pcall(GetPresetData, p)
	local byFixture = okData and type(data) == "table" and data.by_fixtures or {}
	local live, maps, out = ShowData().LivePatch, {}, {}
	for fidKey, attrs in pairs(byFixture) do
		local fid = math.tointeger(tonumber(fidKey))
		local f = fid and findFixture(live, fid)
		local mode = f and f:Get("ModeDirect")
		local key = mode and mode:ToAddr() or "?"
		maps[key] = maps[key] or (mode and attributeMap(mode)) or {}
		local values = {}
		for attr, v in pairs(attrs) do
			if type(v) == "table" and v[1] then
				local steps = {}
				for i = 1, 48 do
					if type(v[i]) ~= "table" then break end
					steps[i] = describeDmx(maps[key], attr, math.min(v[i].absolute_value or 0, 0xFFFFFF), v[i].channel_function)
					if v[i + 1] then steps[i].width = v[i].width; steps[i].trans = v[i].trans end
				end
				if #steps > 1 then
					values[attr] = { effect = { steps = steps, bpm = math.floor((tonumber(v.speed) or 0) * 600 + 0.5) / 10, phase = math.floor((tonumber(v.phase) or 0) * 10 + 0.5) / 10 } }
				else
					values[attr] = steps[1]
				end
			end
		end
		out[#out + 1] = { fid = fid, type = f and f:Get("FixtureType") and f:Get("FixtureType").name, values = values }
	end
	table.sort(out, function(a, b) return (a.fid or 0) < (b.fid or 0) end)
	return { pool = math.tointeger(args.pool), no = math.tointeger(args.no), name = p.name, fixtures = out }
end

-- args: { no } -> cues with timing and what they contain: referenced presets and fixtures with own values.
ops["sequence.read"] = function(args)
	local no = math.tointeger(args.no)
	local seq = no and DataPool().Sequences[no]
	if not seq then fail("not-found", "no sequence " .. tostring(args.no)) end
	local text = exportText(seq) or ""
	local cues = {}
	-- Cue elements in export order: OffCue, CueZero, then the real cues.
	for cueXml in text:gmatch("<Cue .-</Cue>") do
		local cueNo = tonumber(cueXml:match('^<Cue[^>]-No="%s*([%d%.]+)"') or "")
		if cueNo and cueNo > 0 then
			-- Skip embedded preset copies (DependencyExport): only the cue's own PresetData counts.
			local own = cueXml:gsub("<DependencyExport.-</DependencyExport>", "")
			local presets, fixtures, ownValues = {}, {}, 0
			for phaser in own:gmatch("<Phaser [^>]*>") do
				local ref = phaser:match('AbsPreset="([^"]*)"')
				local fid = tonumber(phaser:match('ID="(%d+)"') or "")
				if ref then
					presets[ref:gsub("&apos;", "'")] = true
				elseif fid then
					fixtures[fid] = true
					ownValues = ownValues + 1
				end
			end
			local presetList, fidList = {}, {}
			for ref in pairs(presets) do presetList[#presetList + 1] = ref end
			for fid in pairs(fixtures) do fidList[#fidList + 1] = fid end
			table.sort(presetList)
			table.sort(fidList)
			local info = cueInfo(findCue(seq, cueNo) or seq)
			info.no = cueNo
			info.presets = presetList
			info.ownValueFixtures = fidList
			info.ownValues = ownValues
			cues[#cues + 1] = info
		end
	end
	return { no = no, name = seq.name, cues = cues, executors = (function()
		local list = {}
		for _, h in ipairs(executorsHolding(seq)) do list[#list + 1] = string.format("%d.%d", h.page, h.exec) end
		return list
	end)() }
end

---------------------------------------------------------------------------
-- Appearances: button colours for pool objects, so a busking layout reads at a glance.
---------------------------------------------------------------------------

local function appearanceInfo(a)
	return { no = tonumber(tostring(display(a, "No")):match("^%d+")), name = a.name, color = "#" .. tostring(display(a, "BackRGBA") or ""):sub(1, 6) }
end

ops["appearance.list"] = function()
	local out = {}
	for _, a in ipairs(ShowData().Appearances:Children()) do out[#out + 1] = appearanceInfo(a) end
	return out
end

-- args: { no, name, color = "#RRGGBB", overwrite, assign = [{ kind, pool?, no }] }
ops["appearance.store"] = function(args)
	local no = groupNo(args.no)
	if type(args.name) ~= "string" or args.name == "" or #args.name > 100 then fail("bad-args", "name must be a non-empty string") end
	local hexColor = tostring(args.color or ""):match("^#?(%x%x%x%x%x%x)$")
	if not hexColor then fail("bad-args", 'color must be "#RRGGBB"') end
	local pool = ShowData().Appearances
	local a = pool[no]
	if a and not args.overwrite then fail("exists", string.format("appearance %d already exists ('%s'); pass overwrite to replace it", no, tostring(a.name))) end
	a = a or pool:Create(no)
	if not a then fail("store-failed", "could not create appearance " .. no) end
	a:Set("Name", args.name)
	a:Set("BackR", tostring(tonumber(hexColor:sub(1, 2), 16)))
	a:Set("BackG", tostring(tonumber(hexColor:sub(3, 4), 16)))
	a:Set("BackB", tostring(tonumber(hexColor:sub(5, 6), 16)))
	a:Set("BackAlpha", "255")
	local assigned, problems = {}, {}
	for _, target in ipairs(type(args.assign) == "table" and args.assign or {}) do
		local okRef, ref, k = pcall(poolRef, target.kind, target, target.no)
		local obj = okRef and k.get(target)
		if not obj then
			problems[#problems + 1] = "no " .. (okRef and ref or tostring(target.kind))
		else
			obj.Appearance = a -- a reference property: assign the object
			if obj:Get("Appearance") == a then assigned[#assigned + 1] = ref else problems[#problems + 1] = "could not assign to " .. ref end
		end
	end
	local info = appearanceInfo(pool[no])
	info.assigned = assigned
	info.problems = problems
	return info
end

---------------------------------------------------------------------------
-- Layouts: a 2D map of fixtures (clickable, drives selection), placed explicitly or from the 3D positions.
---------------------------------------------------------------------------

local function layoutInfo(l)
	local elements = {}
	for _, e in ipairs(l:Children()) do
		local obj = e:Get("Object")
		elements[#elements + 1] = {
			fid = obj and tonumber(display(obj, "FID") or ""),
			x = tonumber(display(e, "PosX")), y = tonumber(display(e, "PosY")),
			width = tonumber(display(e, "Width")), height = tonumber(display(e, "Height")),
		}
	end
	return { no = tonumber(tostring(display(l, "No")):match("^%d+")), name = l.name, elements = elements }
end

ops["layout.list"] = function()
	local out = {}
	for _, l in ipairs(DataPool().Layouts:Children()) do
		out[#out + 1] = { no = tonumber(tostring(display(l, "No")):match("^%d+")), name = l.name, elements = l:Count() }
	end
	return out
end

-- args: { no, name, overwrite, elements = [{ fid, x?, y?, width?, height? }], scale? } -> elements without x/y are
-- placed from the fixture's 3D position seen from above (x = PosX, y = PosY, scale layout units per metre).
ops["layout.store"] = function(args)
	local no = groupNo(args.no)
	if type(args.name) ~= "string" or args.name == "" or args.name:find('"', 1, true) then fail("bad-args", "name must be a non-empty string without quotes") end
	if type(args.elements) ~= "table" or #args.elements == 0 then fail("bad-args", "elements must be a non-empty array") end
	local live = ShowData().LivePatch
	local wanted, fids = {}, {}
	for _, el in ipairs(args.elements) do
		local fid = math.tointeger(el.fid)
		if not fid or not findFixture(live, fid) then fail("not-found", "no fixture with FID " .. tostring(el.fid)) end
		if wanted[fid] then fail("bad-args", "FID " .. fid .. " is listed twice") end
		wanted[fid] = el
		fids[#fids + 1] = tostring(fid)
	end
	local pool = DataPool().Layouts
	local existing = pool[no]
	if existing and not args.overwrite then fail("exists", string.format("layout %d already exists ('%s'); pass overwrite to replace it", no, tostring(existing.name))) end
	guardIdle()
	local backup
	if existing then
		backup = exportBackup(existing, "layouts", "layout" .. no)
		runCommand(string.format("Delete Layout %d /NoConfirmation", no), function() return pool[no] == nil end)
	end
	runCommand(string.format("Store Layout %d", no), function() return pool[no] ~= nil end)
	runCommand(string.format('Label Layout %d "%s"', no, args.name), function() return pool[no].name == args.name end)
	runCommand(string.format("Assign Fixture %s At Layout %d", table.concat(fids, " + "), no), function() return pool[no]:Count() >= #fids end, 6)

	local scale = tonumber(args.scale) or 100
	local placed, problems = 0, {}
	for _, e in ipairs(pool[no]:Children()) do
		local obj = e:Get("Object")
		local fid = obj and math.tointeger(tonumber(display(obj, "FID") or ""))
		local el = fid and wanted[fid]
		if el then
			local x, y = tonumber(el.x), tonumber(el.y)
			if x == nil or y == nil then
				x = (tonumber(tostring(display(obj, "PosX") or ""):match("(-?[%d%.]+)")) or 0) * scale
				y = (tonumber(tostring(display(obj, "PosY") or ""):match("(-?[%d%.]+)")) or 0) * scale
			end
			e:Set("PosX", tostring(math.floor(x + 0.5)))
			e:Set("PosY", tostring(math.floor(y + 0.5)))
			if el.width then e:Set("Width", tostring(math.tointeger(el.width) or 50)) end
			if el.height then e:Set("Height", tostring(math.tointeger(el.height) or 50)) end
			if math.abs((tonumber(display(e, "PosX")) or 1e9) - math.floor(x + 0.5)) > 0.5 then problems[#problems + 1] = "FID " .. fid .. " was not placed" else placed = placed + 1 end
		end
	end
	local info = layoutInfo(pool[no])
	info.placed = placed
	info.problems = problems
	info.backup = backup
	return info
end

---------------------------------------------------------------------------
-- Saving the show. grandMA3 can ask before saving (e.g. "Change show file name?" when saving under a new name);
-- like moves, show.save then reports the question and show.saveFinish checks what happened once it is answered.
---------------------------------------------------------------------------

local pendingSave -- { name, startedAt }

local function showFileName()
	local name = blankToNil(display(Root().MAnetSocket, "ShowFile"))
	return name
end

-- The newest file written for a show since `since` (epoch seconds), or nil.
local function savedFile(name, since)
	local dir = GetPath(Enums.PathType.Showfiles)
	for _, entry in ipairs(DirList(dir, "*.show") or {}) do
		local base = entry.name:gsub("%.show$", "")
		if (not name or base == name) and (entry.time or 0) >= since - 1 then
			return { file = dir .. GetPathSeparator() .. entry.name, size = entry.size, time = entry.time }
		end
	end
	return nil
end

ops["show.status"] = function()
	return {
		name = showFileName(),
		status = GetShowFileStatus(),
		folder = GetPath(Enums.PathType.Showfiles),
		dialog = describeModal(GetTopModal()),
		pendingSave = pendingSave and pendingSave.name or nil,
	}
end

local function finishSave(save)
	pendingSave = nil
	local file = savedFile(save.name, save.startedAt)
	return { pending = false, saved = file ~= nil, name = showFileName(), file = file and file.file, size = file and file.size }
end

-- args: { name? } -> saves under the current name, or under a new one.
ops["show.save"] = function(args)
	if pendingSave then fail("busy", "a save is waiting for an answer on the console; call show.saveFinish") end
	guardIdle()
	local name = args.name
	if name ~= nil and (type(name) ~= "string" or name == "" or name:find('["/\\]')) then fail("bad-args", "name must be a file name without quotes or slashes") end
	local target = name or showFileName()
	local save = { name = target, startedAt = os.time() }
	CmdIndirect(name and string.format('SaveShow "%s"', name) or "SaveShow")
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.1)
		if GetTopModal() ~= nil then
			pendingSave = save
			return { pending = true, dialog = describeModal(GetTopModal()) }
		end
	until (savedFile(target, save.startedAt) and GetShowFileStatus() == "ShowLoaded") or socket.gettime() - t0 > 20
	return finishSave(save)
end

ops["show.saveFinish"] = function()
	local save = pendingSave
	if not save then fail("not-found", "no save is waiting") end
	if GetTopModal() ~= nil then return { pending = true, dialog = describeModal(GetTopModal()) } end
	local t0 = socket.gettime()
	repeat
		coroutine.yield(0.1)
	until GetShowFileStatus() == "ShowLoaded" or socket.gettime() - t0 > 20
	return finishSave(save)
end

-- Probe ops for development; disabled unless started with "dev".
ops.cmd = function(args)
	requireDev()
	if type(args.command) ~= "string" then fail("bad-args", "command must be a string") end
	if GetTopModal() ~= nil then failModal("a pop-up is open on the console") end
	return { feedback = Cmd(args.command) }
end

ops.lua = function(args)
	requireDev()
	if type(args.code) ~= "string" then fail("bad-args", "code must be a string") end
	local env = setmetatable({}, { __index = _G })
	local chunk, err = load("return " .. args.code, "=probe", "t", env)
	if not chunk then chunk, err = load(args.code, "=probe", "t", env) end
	if not chunk then fail("lua-syntax", err) end
	local results = table.pack(chunk())
	local out = {}
	for i = 1, results.n do out[i] = sanitize(results[i]) end
	return out
end

---------------------------------------------------------------------------
-- Transport
---------------------------------------------------------------------------

local function sendAll(cl, data)
	local i, tries = 1, 0
	while i <= #data do
		local last, err, partialLast = cl.sock:send(data, i)
		if last then
			i = last + 1
		elseif err == "timeout" then
			i = (partialLast or (i - 1)) + 1
			tries = tries + 1
			if tries > 2000 then return false end
			coroutine.yield()
		else
			return false
		end
	end
	return true
end

local function reply(cl, response)
	local ok, encoded = pcall(json.encode, sanitize(response))
	if not ok then
		encoded = json.encode({ id = sanitize(response.id), ok = false, code = "encode-error", error = tostring(encoded) })
	end
	if not sendAll(cl, encoded .. "\n") then cl.dead = true end
end

local function onError(e)
	if type(e) == "table" and e.code then return e end
	return { code = "lua-error", message = tostring(e), traceback = debug.traceback("", 2) }
end

ops.hello = function() return {} end -- handled in handleLine; listed so it is a known op

local function handleLine(cl, line)
	local okDecode, req = pcall(json.decode, line)
	if not okDecode or type(req) ~= "table" then
		return reply(cl, { ok = false, code = "bad-request", error = "invalid JSON request" })
	end
	local op = ops[req.op]
	if not op then
		return reply(cl, { id = req.id, ok = false, code = "unknown-op", error = "unknown op '" .. tostring(req.op) .. "'" })
	end
	local args = type(req.args) == "table" and req.args or {}
	if req.op == "hello" then
		local inst = shared.current
		if cl.authenticated or (inst and inst.token and args.token == inst.token) then
			cl.authenticated = true
			return reply(cl, { id = req.id, ok = true, result = { authenticated = true, plugin = VERSION } })
		end
		reply(cl, { id = req.id, ok = false, code = "unauthorized", error = "wrong or missing token" })
		cl.dead = true
		return
	end
	if not cl.authenticated then
		reply(cl, { id = req.id, ok = false, code = "unauthorized", error = "send hello with the token first (gma3_library/" .. TOKEN_FILE .. " on the console)" })
		cl.dead = true
		return
	end
	activeClient = cl
	local ok, result = xpcall(op, onError, args)
	activeClient = nil
	if ok then
		reply(cl, { id = req.id, ok = true, result = result })
	else
		reply(cl, { id = req.id, ok = false, code = result.code, error = tostring(result.message), detail = result.detail, traceback = result.traceback })
	end
end

local function serviceClient(cl)
	for _ = 1, MAX_LINES_PER_TICK do
		local line, err, partial = cl.sock:receive("*l")
		if line then
			local full = cl.buf .. line
			cl.buf = ""
			handleLine(cl, full)
			if cl.dead then return end
		elseif err == "timeout" then
			cl.buf = cl.buf .. (partial or "")
			if #cl.buf > MAX_LINE_BYTES then cl.dead = true end
			return
		else
			cl.dead = true
			return
		end
	end
end

local function stopListening(inst)
	if inst.server then pcall(function() inst.server:close() end) end
	inst.server = nil
	inst.stopRequested = true
	if shared.current == inst then shared.current = nil end
end

local function closeInstance(inst)
	stopListening(inst)
	for _, cl in ipairs(inst.clients) do pcall(function() cl.sock:close() end) end
	inst.clients = {}
end

local function isAlive(inst)
	return inst.server ~= nil and not inst.stopRequested and socket.gettime() - inst.lastTick <= STALE_AFTER_S
end

local function tokenPath()
	return GetPath(Enums.PathType.Library) .. GetPathSeparator() .. TOKEN_FILE
end

-- The token network clients must send; created once and kept in gma3_library so it survives restarts.
local function loadOrCreateToken()
	local path = tokenPath()
	local f = io.open(path, "r")
	local token = f and (f:read("l") or ""):match("^%s*(%x+)%s*$")
	if f then f:close() end
	if token and #token >= 32 then return token end
	token = nil
	local random = io.open("/dev/urandom", "rb")
	if random then
		local raw = random:read(16) or ""
		random:close()
		if #raw == 16 then token = raw:gsub(".", function(c) return string.format("%02x", c:byte()) end) end
	end
	if not token and io.popen then
		-- Windows has no /dev/urandom; .NET GUIDs come from the system's cryptographic generator.
		local p = io.popen([[powershell -NoProfile -NonInteractive -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')"]])
		if p then
			token = (p:read("a") or ""):match("^%s*(%x+)%s*$")
			p:close()
			if token and #token < 32 then token = nil end
		end
	end
	if not token then
		error("no secure random source for the network token; put 32 or more hex characters in " .. path .. " and start again")
	end
	f = io.open(path, "w")
	if not f then error("cannot write " .. path) end
	f:write(token, "\n")
	f:close()
	return token
end

local function serve(opts)
	local host = opts.lan and "*" or LOCAL_HOST
	local token
	if opts.lan then
		local okToken, result = pcall(loadOrCreateToken)
		if not okToken then
			ErrPrintf("grandmcp: %s", tostring(result))
			return
		end
		token = result
	end
	local server, err = socket.bind(host, PORT)
	if not server then
		ErrPrintf("grandmcp: cannot listen on %s:%d (%s)", host, PORT, tostring(err))
		return
	end
	server:settimeout(0)
	local inst = { server = server, clients = {}, dev = opts.dev, lan = opts.lan, host = host, token = token, stopRequested = false, lastTick = socket.gettime() }
	mine = inst
	shared.current = inst
	if opts.lan then
		Printf("grandmcp %s listening on all interfaces, port %d%s. Network clients need the token in %s", VERSION, PORT, opts.dev and " (dev ops for local clients)" or "", tokenPath())
	else
		Printf("grandmcp %s listening on %s:%d%s", VERSION, host, PORT, opts.dev and " (dev ops enabled)" or "")
	end

	local ok, loopErr = xpcall(function()
		while not inst.stopRequested do
			inst.lastTick = socket.gettime()
			local c = inst.server and inst.server:accept()
			if c then
				c:settimeout(0)
				pcall(function() c:setoption("tcp-nodelay", true) end)
				local peer = c:getpeername()
				local loopback = peer == "127.0.0.1" or peer == "::1"
				table.insert(inst.clients, { sock = c, buf = "", loopback = loopback, authenticated = loopback, peer = peer })
			end
			for i = #inst.clients, 1, -1 do
				local cl = inst.clients[i]
				serviceClient(cl)
				if cl.dead then
					pcall(function() cl.sock:close() end)
					table.remove(inst.clients, i)
				end
			end
			coroutine.yield()
		end
	end, debug.traceback)
	if not ok then ErrPrintf("grandmcp: loop crashed: %s", tostring(loopErr)) end
	closeInstance(inst)
	Printf("grandmcp stopped")
end

-- Dev: re-import this plugin from gma3_library/datapools/plugins and restart it, all queued on the
-- main task so it runs after this reply is sent.
ops.reload = function()
	requireDev()
	local plugin = myHandle and myHandle:Parent()
	local slot = plugin and tonumber(tostring(plugin:Get("No", Enums.Roles.Display)):match("^%d+"))
	if not slot then fail("not-found", "cannot find this plugin's pool slot") end
	local lan = shared.current and shared.current.lan
	stopListening(shared.current)
	CmdIndirect(string.format("Delete Plugin %d /NoConfirmation", slot))
	CmdIndirect(string.format('Import Plugin Library "grandmcp.xml" At Plugin %d', slot))
	CmdIndirect(string.format('Plugin %d "dev%s"', slot, lan and " lan" or ""))
	return { slot = slot, reloading = true }
end

---------------------------------------------------------------------------
-- Plugin entry points
---------------------------------------------------------------------------

local function statusLine(inst)
	if not inst then return string.format("grandmcp %s: stopped", VERSION) end
	return string.format("grandmcp %s: running on %s:%d (%s), %d client(s), dev ops %s", VERSION, inst.host, PORT, inst.lan and "network, token required" or "local only", #inst.clients, inst.dev and "on" or "off")
end

local function Main(_, argument)
	local arg = string.lower(tostring(argument or "")):match("^%s*(.-)%s*$")
	local current = shared.current
	-- A loop that stopped ticking without a Cleanup (e.g. a crash) is treated as gone.
	if current and not isAlive(current) then
		closeInstance(current)
		current = nil
	end

	if current or arg == "stop" or arg == "status" then
		pendingControlCleanups = pendingControlCleanups + 1 -- this call's Cleanup must not stop the server
		if not current then
			Printf("%s", statusLine(nil))
		elseif arg == "stop" then
			current.stopRequested = true
			Printf("grandmcp: stopping")
		elseif arg == "dev" or arg == "dev on" then
			current.dev = true
			Printf("grandmcp: dev ops on")
		elseif arg == "dev off" then
			current.dev = false
			Printf("grandmcp: dev ops off")
		else
			Printf("%s", statusLine(current))
		end
		return
	end
	local words = {}
	for word in arg:gmatch("%S+") do words[word] = true end
	serve({ dev = words.dev == true, lan = words.lan == true })
end

local function Cleanup()
	if pendingControlCleanups > 0 then
		pendingControlCleanups = pendingControlCleanups - 1
		return
	end
	if mine then closeInstance(mine) end
end

return Main, Cleanup
