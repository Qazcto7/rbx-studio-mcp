local Exec = ...

local function call(params)
	params.target = "client"
	params.source = params.source or "return 1"
	local before = #calls
	local result = Exec.run(params)
	assert(#calls == before + 1, "the relay was called exactly once")
	assert(result.ok == true, "the relay's result is returned unchanged")
	return calls[#calls]
end

-- Defaults: no settle, the usual 30s budget plus the 5s margin for the round trip.
local plain = call({})
assert(plain.attributes.Timeout == 30, "default timeout")
assert(plain.attributes.Settle == 0, "settle defaults to none")
assert(plain.timeout == 35, "relay budget is timeout + settle + 5")
assert(plain.name == "MCPExecRelay")

-- Settle is added to the relay's own deadline, or the relay is killed mid-settle.
local settled = call({ timeoutSeconds = 20, settleSeconds = 10 })
assert(settled.attributes.Timeout == 20 and settled.attributes.Settle == 10, "both reach the LocalScript")
assert(settled.timeout == 35, "20 + 10 + 5")

-- Out-of-range and malformed values are clamped rather than trusted.
assert(call({ settleSeconds = 9999 }).attributes.Settle == 120, "settle is capped at 120")
assert(call({ settleSeconds = -5 }).attributes.Settle == 0, "negative settle is 0")
assert(call({ settleSeconds = "soon" }).attributes.Settle == 0, "non-numeric settle is 0")
assert(call({ timeoutSeconds = 9999 }).attributes.Timeout == 300, "timeout is capped at 300")

-- The LocalScript must actually read what was set.
assert(string.find(plain.source, 'GetAttribute("Settle")', 1, true), "the relay reads Settle")
assert(string.find(plain.source, 'GetAttribute("Timeout")', 1, true), "the relay reads Timeout")

-- The prepare step copies the four modules and wraps the user's code.
local relay = { children = {} }
plain.prepare(relay)
local chunk
for _, child in relay.children do
	if child.ClassName == "ModuleScript" then chunk = child end
end
assert(chunk ~= nil, "a Chunk module is created")
assert(chunk.Source == "return function(...) return 1\nend", "the source is wrapped as a function")
assert(#relay.children == 5, "four cloned modules plus the chunk")
print("exec client: settle, clamping and relay setup pass")
