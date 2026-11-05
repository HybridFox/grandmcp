-- grandmcp bridge: serves newline-delimited JSON over TCP from inside grandMA3.
--
--   request   {"id": <any>, "op": "<name>", "args": {...}}
--   response  {"id": <any>, "ok": true,  "result": <any>}
--             {"id": <any>, "ok": false, "code": "<code>", "error": "<message>"}
--
-- Start:    Plugin "grandmcp"            (or Plugin "grandmcp" "dev" to enable the probe ops)
-- Control:  Plugin "grandmcp" "stop" | "status" | "dev on" | "dev off"

local socket = require("socket")
local json = require("json")

local VERSION = "0.1.0"
local HOST = "127.0.0.1" -- unauthenticated: never bind beyond loopback
local PORT = 9810
local MAX_LINES_PER_TICK = 32
local MAX_LINE_BYTES = 4 * 1024 * 1024
local STALE_AFTER_S = 3

-- Survives between plugin calls, so a control call can reach the running loop.
_G.__grandmcp = _G.__grandmcp or {}
local state = _G.__grandmcp

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
	if depth >= 8 then return "<max depth>" end
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

local function fail(code, message)
	error({ code = code, message = message }, 0)
end

local function requireDev()
	if not state.dev then fail("dev-disabled", 'start the plugin with Plugin "grandmcp" "dev on"') end
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
		dev = state.dev == true,
	}
end

-- Probe ops for development; disabled unless started with "dev".
ops.cmd = function(args)
	requireDev()
	if type(args.command) ~= "string" then fail("bad-args", "command must be a string") end
	if GetTopModal() ~= nil then fail("modal-open", "a pop-up is open on the console") end
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
	local ok, result = xpcall(op, onError, args)
	if ok then
		reply(cl, { id = req.id, ok = true, result = result })
	else
		reply(cl, { id = req.id, ok = false, code = result.code, error = tostring(result.message), traceback = result.traceback })
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

local function closeAll()
	for _, cl in ipairs(state.clients or {}) do pcall(function() cl.sock:close() end) end
	state.clients = {}
	if state.server then pcall(function() state.server:close() end) end
	state.server = nil
	state.running = false
end

local function serve()
	local server, err = socket.bind(HOST, PORT)
	if not server then
		ErrPrintf("grandmcp: cannot listen on %s:%d (%s)", HOST, PORT, tostring(err))
		return
	end
	server:settimeout(0)
	state.server = server
	state.clients = {}
	state.running = true
	state.stopRequested = false
	Printf("grandmcp %s listening on %s:%d%s", VERSION, HOST, PORT, state.dev and " (dev ops enabled)" or "")

	local ok, loopErr = xpcall(function()
		while not state.stopRequested do
			state.lastTick = socket.gettime()
			local c = server:accept()
			if c then
				c:settimeout(0)
				pcall(function() c:setoption("tcp-nodelay", true) end)
				table.insert(state.clients, { sock = c, buf = "" })
			end
			for i = #state.clients, 1, -1 do
				local cl = state.clients[i]
				serviceClient(cl)
				if cl.dead then
					pcall(function() cl.sock:close() end)
					table.remove(state.clients, i)
				end
			end
			coroutine.yield()
		end
	end, debug.traceback)
	if not ok then ErrPrintf("grandmcp: loop crashed: %s", tostring(loopErr)) end
	closeAll()
	Printf("grandmcp stopped")
end

---------------------------------------------------------------------------
-- Plugin entry points
---------------------------------------------------------------------------

local function statusLine()
	return string.format("grandmcp %s: %s on %s:%d, %d client(s), dev ops %s", VERSION,
		state.running and "running" or "stopped", HOST, PORT, #(state.clients or {}), state.dev and "on" or "off")
end

local function Main(_, argument)
	local arg = string.lower(tostring(argument or "")):match("^%s*(.-)%s*$")

	-- A loop that stopped ticking without a Cleanup (e.g. a crash) is treated as gone.
	if state.running and socket.gettime() - (state.lastTick or 0) > STALE_AFTER_S then closeAll() end

	if state.running then
		state.ignoreNextCleanup = true -- this call's Cleanup must not stop the running loop
		if arg == "stop" then
			state.stopRequested = true
			Printf("grandmcp: stopping")
		elseif arg == "dev" or arg == "dev on" then
			state.dev = true
			Printf("grandmcp: dev ops on")
		elseif arg == "dev off" then
			state.dev = false
			Printf("grandmcp: dev ops off")
		else
			Printf("%s", statusLine())
		end
		return
	end

	if arg == "stop" or arg == "status" then
		Printf("%s", statusLine())
		return
	end
	state.dev = (arg == "dev" or arg == "dev on")
	serve()
end

local function Cleanup()
	if state.ignoreNextCleanup then
		state.ignoreNextCleanup = false
		return
	end
	state.stopRequested = true
	closeAll()
end

return Main, Cleanup
