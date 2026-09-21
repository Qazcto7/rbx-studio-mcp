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

function run(plan, { stuck = false, deliver = true } = {}) {
  const harness = `
local log = {}
local down = { MouseButton1 = ${stuck}, MouseButton2 = false, MouseButton3 = false }
local keysDown = {}
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
    if down[name] == isDown then error("duplicate button state") end
    down[name] = isDown; table.insert(log, name .. (isDown and " down" or " up"))
    -- The engine reads a delivered press as InputBegan; a release is InputEnded.
    if isDown and ${deliver} and began then began({ UserInputType = button, Position = { X = at.X, Y = at.Y } }) end
  end,
  SendMousePosition = function() end,
}
local reported
local function conn() return { Disconnect = function() end } end
local services = {
  UserInputService = { CreateVirtualInput = function() return virtual end, InputBegan = { Connect = function(_, fn) began = fn; return { Disconnect = function() end } end }, GetFocusedTextBox = function() end },
  HttpService = { JSONDecode = function() return ${lua(plan)} end },
  Players = { LocalPlayer = {} },
  GuiService = {},
}
game = { GetService = function(_, name) return services[name] end }
local report = { FireServer = function(_, payload) reported = payload end }
script = {
  WaitForChild = function() return report end,
  GetAttribute = function(_, name) if name == "Cursor" then return false elseif name == "Budget" then return 20 end return "x" end,
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
print(out.log .. "|" .. out.held .. "|" .. out.notes .. "|" .. out.performed .. "|" .. out.released .. "|" .. out.landed)
`;
  const path = join(mkdtempSync(join(tmpdir(), "studio-mcp-input-")), "relay.luau");
  writeFileSync(path, harness);
  const result = spawnSync(luau, [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `relay crashed: ${result.stderr}${result.stdout}`);
  const [log, held, notes, performed, released, landed] = result.stdout.trim().split("|");
  return { log, held, notes, performed, released, landed };
}

// A normal tap is one press and one release, and nothing is left down.
let outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "tap" }]);
assert.equal(outcome.log, "MouseButton1 down,MouseButton1 up");
assert.equal(outcome.held, "");

// A tap on a button already stuck down recovers instead of failing the step.
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "tap" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up,MouseButton1 down,MouseButton1 up");
assert.equal(outcome.held, "");
assert.match(outcome.notes, /recovered from a stuck press/);
assert.equal(outcome.performed, "click");

// `release` releases and does NOT press first (it used to press, then release).
outcome = run([{ kind: "click", x: 5, y: 5, button: "MouseButton1", action: "release" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up");
assert.equal(outcome.held, "");

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

// `release_all` clears a stuck button and reports each one.
outcome = run([{ kind: "release_all" }], { stuck: true });
assert.equal(outcome.log, "MouseButton1 up");
assert.equal(outcome.held, "");
assert.equal(outcome.released, "MouseButton1:sent,MouseButton2:already up,MouseButton3:already up");

// A held `press` survives the plan; it was asked to stay down.
outcome = run([{ kind: "click", x: 1, y: 1, button: "MouseButton1", action: "press" }]);
assert.equal(outcome.held, "MouseButton1");

// A key tap presses and releases.
outcome = run([{ kind: "key", key: "W", action: "tap", hold: 0.01 }]);
assert.equal(outcome.log, "key true,key false");

process.stdout.write("input relay: stuck-button recovery ok\n");
