local Input = ...

local function check(condition, message)
	if not condition then
		error(message, 2)
	end
end

local press = { steps = { { kind = "click", x = 1, y = 1, button = "MouseButton1", action = "press" } } }
local tap = { steps = { { kind = "key", key = "W" } } }

-- First call: nothing held yet, so the relay is told so.
nextRelayAnswer = { ok = true, held = { "MouseButton1" } }
local first = Input.send(press)
check(relayCalls[1].attributes.Held == "[]", "a first call hands over no holds, got " .. tostring(relayCalls[1].attributes.Held))
check(first.held ~= nil and first.held[1] == "MouseButton1", "the reply names the button the press left down")

-- Second call: the hold the first call reported is handed to the next relay,
-- so its up-front release leaves it alone.
nextRelayAnswer = { ok = true, held = { "MouseButton1" } }
Input.send(tap)
check(relayCalls[2].attributes.Held == '["MouseButton1"]', "the hold carries into the next call, got " .. tostring(relayCalls[2].attributes.Held))

-- A relay that failed says nothing about what is held, so the previous answer
-- stands rather than forgetting a hold it never touched.
nextRelayAnswer = { ok = false, reason = "the client refused the plan" }
local ok, err = pcall(Input.send, tap)
check(not ok and typeof(err) == "table" and err.code == "INPUT_FAILED", "a failed relay is still reported as INPUT_FAILED")
nextRelayAnswer = { ok = true, held = { "MouseButton1" } }
Input.send(tap)
check(relayCalls[4].attributes.Held == '["MouseButton1"]', "a failed call does not forget the hold")

-- Released: an empty answer clears it, and the reply omits `held`.
nextRelayAnswer = { ok = true }
local released = Input.send(tap)
check(released.held == nil, "nothing held, nothing reported")
nextRelayAnswer = { ok = true }
Input.send(tap)
check(relayCalls[6].attributes.Held == "[]", "the release is remembered, got " .. tostring(relayCalls[6].attributes.Held))

-- Holds are per player: a second player's call does not inherit the first's.
nextRelayAnswer = { ok = true, held = { "MouseButton2" } }
Input.send({ steps = press.steps, player = "Alice" })
nextRelayAnswer = { ok = true }
Input.send({ steps = tap.steps, player = "Bob" })
check(relayCalls[8].attributes.Held == "[]", "Bob does not get Alice's hold")

-- And per playtest: a new playtest makes new Player objects, which start clean.
newPlaytest()
nextRelayAnswer = { ok = true }
Input.send({ steps = tap.steps, player = "Alice" })
check(relayCalls[9].attributes.Held == "[]", "a new playtest starts with nothing held")

print("input send: holds carried between calls, per player and per playtest ok")
