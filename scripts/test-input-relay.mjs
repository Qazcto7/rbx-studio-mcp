/**
 * Runs the input relay's real Luau source against a fake VirtualInput.
 *
 * The relay is a string inside handlers/Input.luau that only ever executes in a
 * playtest client, so nothing else exercises it. This one exists for the stuck
 * mouse-button failures: a button left down makes every later press fail with
 * "duplicate button state", and each of these scenarios is a way that used to
 * end the step (or, for `release`, press the button instead of releasing it).
 *
 * The fake input system throws exactly when a real one does: on any transition
 * to the state a button or key is already in.
 *
 * Usage: node scripts/test-input-relay.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locateLuau, missingLuau } from "./locate-luau.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const luau = locateLuau("LUAU", ["luau.exe", "luau"]);
if (luau === null) {
  process.stderr.write(missingLuau("luau", "LUAU"));
  process.exit(1);
}

const relay = readFileSync(join(root, "plugin/src/handlers/Input.luau"), "utf8").match(/\[==\[([\s\S]*?)\]==\]/)?.[1];
assert.ok(relay, "input relay source found");

const lua = (value) =>
  Array.isArray(value)
    ? `{${value.map(lua).join(",")}}`
    : value && typeof value === "object"
      ? `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(",")}}`
      : JSON.stringify(value);

function run(plan, { stuck = false, stuckButtons = stuck ? ["MouseButton1"] : [], deliver = true, heldAttr = [], pressedApi = "accurate", lenientRelease = false, keysDownAtStart = [], brokenButton = null } = {}) {
  const isStuck = (name) => stuckButtons.includes(name);
  const harness = `
local log = {}
local down = { MouseButton1 = ${isStuck("MouseButton1")}, MouseButton2 = ${isStuck("MouseButton2")}, MouseButton3 = ${isStuck("MouseButton3")} }
local keysDown = {}
for _, code in ${lua(keysDownAtStart.map((key) => "KeyCode." + key))} do keysDown[code] = true end
local function mkEnum(prefix) return setmetatable({}, { __index = function(_, k) return prefix .. "." .. k end }) end
Enum = { KeyCode = mkEnum("KeyCode"), UserInputType = mkEnum("UIT") }
Color3 = { fromRGB = function() end }
Vector2 = { new = function(x, y) return { X = x, Y = y } end }
local began
local virtual = {
  SendKey = function(_, isDown, code)
    if (keysDown[code] or false) == isDown then error("duplicate key state") end
    keysDown[code] = isDown; table.insert(log, "key " .. tostring(isDown))
  end,
  SendMouseButton = function(_, at, button, isDown)
    local name = string.gsub(button, "UIT%.", "")
    if name == ${JSON.stringify(brokenButton)} then error("input system unavailable") end
    -- Whether the engine throws on releasing a button that is already up is
    -- not known for certain; \`lenientRelease\` models an engine that accepts it.
    if down[name] == isDown then
      if not isDown and ${lenientRelease} then return end
      error("duplicate button state")
    end
    down[name] = isDown; table.insert(log, name .. (isDown and " down" or " up"))
    -- The engine reads a delivered press as InputBegan; a release is InputEnded.
    if isDown and ${deliver} and began then began({ UserInputType = button, Position = { X = at.X, Y = at.Y } }) end
  end,
  SendMousePosition = function() end,
}
local reported
local function conn() return { Disconnect = function() end } end
local services = {
  UserInputService = { CreateVirtualInput = function() return virtual end,
    IsMouseButtonPressed = function(_, button)
      local mode = ${JSON.stringify(pressedApi)}
      if mode == "missing" then error("IsMouseButtonPressed is not available") end
      if mode == "false" then return false end
      return down[(string.gsub(button, "UIT%.", ""))] == true
    end,
    InputBegan = { Connect = function(_, fn) began = fn; return { Disconnect = function() end } end }, GetFocusedTextBox = function() end },
  HttpService = { JSONDecode = function(_, text) if text == "HELD" then return ${lua(heldAttr)} end return ${lua(plan)} end },
  Players = { LocalPlayer = {} },
  GuiService = {},
}
game = { GetService = function(_, name) return services[name] end }
local report = { FireServer = function(_, payload) reported = payload end }
script = {
  WaitForChild = function() return report end,
  GetAttribute = function(_, name) if name == "Cursor" then return false elseif name == "Budget" then return 20 elseif name == "Held" then return "HELD" end return "PLAN" end,
  Destroying = { Connect = conn },
}
task = { delay = function() return {} end, cancel = function() end, wait = function() return 0 end }
${relay}
local out = { log = table.concat(log, ","), notes = reported.notes and table.concat(reported.notes, " | ") or "", performed = table.concat(reported.performed, ",") }
local held = {}
for name, value in pairs(down) do if value then table.insert(held, name) end end
table.sort(held)
out.held = table.concat(held, ",")
local released = {}
for name, value in pairs(reported.released or {}) do table.insert(released, name .. ":" .. value) end
table.sort(released)
out.released = table.concat(released, ",")
out.landed = reported.landed and (reported.landed.seen.x .. "," .. reported.landed.seen.y) or "none"
out.mcpHeld = table.concat(reported.held or {}, ",")
print(out.log .. "|" .. out.held .. "|" .. out.notes .. "|" .. out.performed .. "|" .. out.released .. "|" .. out.landed .. "|" .. out.mcpHeld)
`;
  const path = join(mkdtempSync(join(tmpdir(), "studio-mcp-input-")), "relay.luau");
  writeFileSync(path, harness);
  const result = spawnSync(luau, [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `relay crashed: ${result.stderr}${result.stdout}`);
  // `held` is what the fake engine still has down; `mcpHeld` is what the relay
  // reports as deliberately held for the next call.
  const [log, held, notes, performed, released, landed, mcpHeld] = result.stdout.trim().split("|");
  return { log, held, notes, performed, released, landed, mcpHeld };
}

// A normal tap is one press and one release, and nothing is left down.
let outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "tap" }]);
assert.equal(outcome.log, "MouseButton1 down,MouseButton1 up");
assert.equal(outcome.held, "");
assert.equal(outcome.notes, "", "nothing to clear, nothing to say");

// A relay that starts with a button already stuck down (left over from an
// earlier call whose own cleanup never ran) clears it before its own plan
// runs at all -- not just when a step happens to collide with it. The tap
// that follows is then an ordinary press, not a mid-click recovery.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "tap" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up,MouseButton1 down,MouseButton1 up");
assert.equal(outcome.held, "");
assert.match(outcome.notes, /MouseButton1 was left down from an earlier call/);
assert.equal(outcome.performed, "click");

// `release` releases and does NOT press first (it used to press, then release).
// The stuck button is already gone by the time this step runs -- the release
// it asks for was already done at start -- so the log has just the one entry.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "release" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up");
assert.equal(outcome.held, "");
assert.match(outcome.notes, /MouseButton1 was left down from an earlier call/);

// Nothing stuck at all: the proactive check finds every button already up and
// says nothing about it.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton3", action: "tap" }]);
assert.equal(outcome.notes, "", "no earlier button was down, so no note");

// Releasing a button that is already up is the state that was asked for.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton2", action: "release" }]);
assert.equal(outcome.log, "");
assert.equal(outcome.notes, "");
assert.equal(outcome.performed, "click");

// Every pointer button is read back, not just the left one. A right click that
// is delivered must report where it landed; it used to report nothing, which the
// tool then called "did not register at all".
for (const button of ["MouseButton1", "MouseButton2", "MouseButton3"]) {
  outcome = run([{ kind: "click", x: 7, y: 9, button, action: "tap" }]);
  assert.equal(outcome.landed, "7,9", `${button} landing is read back`);
}
// And when nothing is delivered at all, nothing is reported -- that is the case
// the tool's "did not register" warning is for.
outcome = run([{ kind: "click", x: 7, y: 9, button: "MouseButton2", action: "tap" }], { deliver: false });
assert.equal(outcome.landed, "none", "an undelivered click reports no landing");

// `release_all` on a relay that starts stuck: the up-front release stands
// aside for it, so the step itself finds the stuck button and says so in its
// per-button report -- which used to read "already up" for everything, since
// the up-front release had quietly cleared it a moment earlier.
outcome = run([{ kind: "release_all" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up");
assert.equal(outcome.held, "");
assert.equal(outcome.released, "MouseButton1:sent,MouseButton2:already up,MouseButton3:already up");
assert.equal(outcome.notes, "", "release_all reports it itself; no second, up-front note");

// A held `press` survives the plan; it was asked to stay down.
outcome = run([{ kind: "click", x: 1, y: 1, button: "MouseButton1", action: "press" }]);
assert.equal(outcome.held, "MouseButton1");

// A button stuck DURING this plan (a `press` with nothing to release it) is
// not something the start-of-relay check could have known about -- it is
// only stuck once the plan is already running -- so `release_all` still
// finds and reports it the way it always did.
outcome = run([
  { kind: "click", x: 1, y: 1, button: "MouseButton1", action: "press" },
  { kind: "release_all" },
]);
assert.equal(outcome.released, "MouseButton1:sent,MouseButton2:already up,MouseButton3:already up");

// A key tap presses and releases.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }]);
assert.equal(outcome.log, "key true,key false");

// release_all with a key reports the key the way it reports buttons: a key
// that was up is "already up" (it used to say "sent" no matter what), a key
// that was down is "sent".
outcome = run([{ kind: "release_all", key: "W" }]);
assert.match(outcome.released, /W:already up/);
outcome = run([{ kind: "release_all", key: "W" }], { keysDownAtStart: ["W"] });
assert.match(outcome.released, /W:sent/);
// A button whose release throws something other than "duplicate" is reported
// as a failure, not folded into "already up".
outcome = run([{ kind: "release_all" }], { brokenButton: "MouseButton2" });
assert.match(outcome.released, /MouseButton2:failed: [^,]*input system unavailable/);

// --- Holds that span calls -------------------------------------------------

// A `press` is reported back as held, so the next call knows.
outcome = run([{ kind: "click", x: 1, y: 1, button: "MouseButton1", action: "press" }]);
assert.equal(outcome.mcpHeld, "MouseButton1");

// A drag split across two calls: call 1 pressed, call 2 moves and releases.
// The deliberately held button is NOT let go at (0,0) before the move, and is
// not called "stuck" -- the only release is the one the plan asked for.
outcome = run(
  [{ kind: "move", x: 50, y: 60 }, { kind: "click", x: 50, y: 60, button: "MouseButton1", action: "release" }],
  { stuck: true, heldAttr: ["MouseButton1"] },
);
assert.equal(outcome.log, "MouseButton1 up", "released once, by the step, not up front");
assert.equal(outcome.notes, "", "a requested hold is not a stuck button");
assert.equal(outcome.held, "");
assert.equal(outcome.mcpHeld, "", "released, so no longer held");

// A hold that carries on through a call that does something else stays down.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], { stuck: true, heldAttr: ["MouseButton1"] });
assert.equal(outcome.held, "MouseButton1", "still down in the engine");
assert.equal(outcome.mcpHeld, "MouseButton1", "and still reported as held");
assert.equal(outcome.notes, "");

// Holding one button does not stop a genuinely stuck OTHER one from being cleared.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], {
  stuckButtons: ["MouseButton1", "MouseButton2"], heldAttr: ["MouseButton1"],
});
assert.equal(outcome.held, "MouseButton1");
assert.match(outcome.notes, /MouseButton2 was left down from an earlier call/);
assert.doesNotMatch(outcome.notes, /MouseButton1/);

// A tap on a held button ends with it up, and no longer held.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "tap" }], {
  stuck: true, heldAttr: ["MouseButton1"],
});
assert.equal(outcome.held, "");
assert.equal(outcome.mcpHeld, "");

// release_all clears holds too.
outcome = run([{ kind: "release_all" }], { stuck: true, heldAttr: ["MouseButton1"] });
assert.equal(outcome.mcpHeld, "");
assert.equal(outcome.held, "");

// --- The "stuck" warning must not cry wolf -------------------------------------

// An engine that silently accepts releasing an up button: every up-front
// release "goes through", but IsMouseButtonPressed says nothing was down, so
// nothing is reported stuck. (Previously: three false warnings on every call.)
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton3", action: "tap" }], { lenientRelease: true });
assert.equal(outcome.notes, "", "no false stuck-button warnings");
// ...and a real stuck button on that engine is still caught and named.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], { lenientRelease: true, stuckButtons: ["MouseButton2"] });
assert.match(outcome.notes, /MouseButton2 was left down/);
assert.equal(outcome.held, "");

// If IsMouseButtonPressed does not track synthetic input (always false), a
// stuck button is still released -- the protection stays -- just silently.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], { pressedApi: "false", stuckButtons: ["MouseButton2"] });
assert.equal(outcome.held, "", "released anyway");
assert.equal(outcome.notes, "");

// If it cannot be called at all, the release's own outcome decides, as before.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], { pressedApi: "missing", stuckButtons: ["MouseButton2"] });
assert.match(outcome.notes, /MouseButton2 was left down/);
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }], { pressedApi: "missing" });
assert.equal(outcome.notes, "");

process.stdout.write("input relay: stuck-button recovery ok\n");
