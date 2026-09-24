/**
 * Runs the animation-play relay's real Luau source (CLIENT_PLAY_SOURCE,
 * embedded in handlers/Anim.luau) against a fake, stateful client DataModel.
 *
 * This is the logic `animation op="play"` (and `stop` in a playtest) runs on
 * the client: find the sequence, wait for the character, Humanoid and
 * Animator a playtest makes shortly after it starts, stop what an earlier
 * `play` left so tracks do not stack, register, load, play -- and say plainly
 * what went wrong at each step. It only ever executes in a playtest client, so
 * nothing else exercises it (tests/anim.luau covers the server side: what
 * `Anim.play` hands the relay, not what the relay does with it).
 *
 * Time is simulated: `task.wait` advances a fake clock, and anything "late"
 * appears once that clock passes 1s -- so the waits are exercised without
 * the test actually waiting.
 *
 * Usage: node scripts/test-anim-play-relay.mjs
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

const animSource = readFileSync(join(root, "plugin/src/handlers/Anim.luau"), "utf8");
const relay = animSource.match(/local CLIENT_PLAY_SOURCE = \[==\[([\s\S]*?)\]==\]/)?.[1];
assert.ok(relay, "CLIENT_PLAY_SOURCE found");

/**
 * @param scene the fake client:
 *   mode: "play" | "stop" (the relay's Mode attribute)
 *   sequenceClass: class at "Workspace.Seq", or null for "does not exist"
 *   rig: the Rig attribute, or undefined for "the player's own character"
 *   character / humanoid / animator: "present" | "late" | "never"
 *     ("late" = appears once the fake clock passes 1s)
 *   playing: names of tracks already playing on the Animator
 *   attributes: FadeTime / Weight / Speed to pass
 */
function run({
  mode = "play",
  sequenceClass = "KeyframeSequence",
  rig,
  character = "present",
  humanoid = "present",
  animator = "present",
  playing = [],
  registerFails = false,
  loadFails = false,
  attributes = {},
} = {}) {
  const available = (state) =>
    state === "present" ? "true" : state === "late" ? "clock >= 1" : "false";
  const harness = `
local clock = 0
local os = { clock = function() return clock end }
local task = { wait = function(seconds) clock += (seconds or 0.03); return seconds end }

local attributes = ${JSON.stringify(JSON.stringify({ Mode: mode, Sequence: "Workspace.Seq", Rig: rig ?? null, ...attributes }))}
local reported
local Report = { FireServer = function(_, payload) reported = payload end }
local attr = {}
for key, value in string.gmatch(attributes, '"(%w+)":([^,}]+)') do
  if value == "null" then attr[key] = nil
  elseif string.sub(value, 1, 1) == '"' then attr[key] = string.sub(value, 2, -2)
  else attr[key] = tonumber(value) end
end
local script = {
  GetAttribute = function(_, name) return attr[name] end,
  WaitForChild = function(_, name)
    if name == "Report" then return Report end
    if name == "Paths" then return "PathsModule" end
    return nil
  end,
}

local destroyed = {}
local created = 0
local function makeTrack(owner, anim)
  local track = { Animation = anim, Length = 2.5, Looped = false, Priority = "Action" }
  function track:Play(fade, weight, speed)
    track.args = tostring(fade) .. "/" .. tostring(weight) .. "/" .. tostring(speed)
    table.insert(owner.playing, track)
  end
  function track:Stop()
    for index, other in owner.playing do
      if other == track then table.remove(owner.playing, index) break end
    end
  end
  function track:Destroy() table.insert(destroyed, track.Animation.Name) end
  return track
end
local function makeAnimator()
  local self = { ClassName = "Animator", playing = {} }
  function self:GetPlayingAnimationTracks()
    local out = {}
    for _, track in self.playing do table.insert(out, track) end
    return out
  end
  function self:LoadAnimation(anim)
    if ${loadFails} then error("LoadAnimation refused") end
    return makeTrack(self, anim)
  end
  return self
end

local theAnimator = makeAnimator()
for _, name in ${"{" + playing.map((name) => JSON.stringify(name)).join(",") + "}"} do
  table.insert(theAnimator.playing, makeTrack(theAnimator, { Name = name }))
end

local function makeHumanoid(animatorState)
  return {
    ClassName = "Humanoid",
    FindFirstChildOfClass = function(_, class)
      if class == "Animator" and animatorState() then return theAnimator end
      return nil
    end,
  }
end
local characterHumanoid = makeHumanoid(function() return ${available(animator)} end)
local characterModel = {
  GetFullName = function() return "Workspace.P1" end,
  FindFirstChildOfClass = function(_, class)
    if class == "Humanoid" and ${available(humanoid)} then return characterHumanoid end
    return nil
  end,
}
local otherRig = {
  GetFullName = function() return "Workspace.OtherRig" end,
  FindFirstChildOfClass = function(_, class)
    if class == "Humanoid" then return makeHumanoid(function() return true end) end
    return nil
  end,
}

local sequenceInstance = nil
${
  sequenceClass === null
    ? ""
    : `sequenceInstance = { ClassName = ${JSON.stringify(sequenceClass)} }
sequenceInstance.IsA = function(self, class) return self.ClassName == class end`
}
local paths = {
  resolve = function(path)
    if path == "Workspace.Seq" then
      if sequenceInstance == nil then error({ code = "NOT_FOUND", message = "Workspace.Seq does not exist" }) end
      return sequenceInstance
    end
    if path == "Workspace.OtherRig" then return otherRig end
    error({ code = "NOT_FOUND", message = path .. " does not exist" })
  end,
}
local function require(name)
  if name == "PathsModule" then return paths end
  error("unknown module")
end

local KeyframeSequenceProvider = {
  RegisterKeyframeSequence = function()
    if ${registerFails} then error("cannot register this sequence") end
    return "session-hash"
  end,
}
local LocalPlayer = setmetatable({}, { __index = function(_, key)
  if key == "Character" and ${available(character)} then return characterModel end
  return nil
end })
local Players = { LocalPlayer = LocalPlayer }
local game = {
  GetService = function(_, name)
    if name == "KeyframeSequenceProvider" then return KeyframeSequenceProvider end
    if name == "Players" then return Players end
  end,
}
local Instance = {
  new = function(class)
    if class == "Animation" then return { Name = "Animation" } end
    if class == "Animator" then
      created += 1
      return makeAnimator()
    end
  end,
}

-- Wrapped so the relay's own early \`return\`s (every failure branch) only
-- leave this function, not the whole harness.
;(function()
${relay}
end)()

local names = {}
for _, track in theAnimator.playing do table.insert(names, track.Animation.Name) end
local lastArgs = "none"
for _, track in theAnimator.playing do if track.args then lastArgs = track.args end end
print(table.concat({
  if reported.ok then "ok" else "fail",
  tostring(reported.reason or reported.animationId),
  tostring(reported.replaced or reported.stopped or 0),
  table.concat(destroyed, ","),
  table.concat(names, ","),
  tostring(created),
  lastArgs,
}, "|"))
`;
  const path = join(mkdtempSync(join(tmpdir(), "studio-mcp-anim-play-")), "relay.luau");
  writeFileSync(path, harness);
  const result = spawnSync(luau, [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `relay crashed: ${result.stderr}${result.stdout}`);
  const [status, detail, count, destroyed, playingNow, created, args] = result.stdout.trim().split("|");
  return { status, detail, count: Number(count), destroyed, playing: playingNow, created: Number(created), args };
}

// The common case: plays on the player's own character, tagged so a later
// play or stop can find it.
let outcome = run();
assert.equal(outcome.status, "ok");
assert.equal(outcome.detail, "session-hash");
assert.equal(outcome.playing, "MCPPlay");
assert.equal(outcome.count, 0, "nothing to replace");

// Fade, weight and speed reach Play.
outcome = run({ attributes: { FadeTime: 0.2, Weight: 1, Speed: 1.5 } });
assert.equal(outcome.args, "0.2/1/1.5");

// An explicit rig is used instead of the character.
outcome = run({ rig: "Workspace.OtherRig", character: "never" });
assert.equal(outcome.status, "ok");

// --- Things a playtest makes shortly after it starts are waited for ---------

outcome = run({ character: "late" });
assert.equal(outcome.status, "ok", "a character that spawns a moment later is waited for");
outcome = run({ humanoid: "late" });
assert.equal(outcome.status, "ok", "a Humanoid that replicates after its character is waited for");
outcome = run({ character: "never" });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /no character \(waited 8s\)/);

// The Animator the server makes is waited for, not duplicated: a client-made
// second Animator breaks replication to other players.
outcome = run({ animator: "late" });
assert.equal(outcome.status, "ok");
assert.equal(outcome.created, 0, "waited for the server's Animator instead of making one");
// A rig that really has none gets one, as before.
outcome = run({ animator: "never" });
assert.equal(outcome.status, "ok");
assert.equal(outcome.created, 1);

// --- Repeated plays replace, not stack --------------------------------------

outcome = run({ playing: ["MCPPlay", "Walk"] });
assert.equal(outcome.status, "ok");
assert.equal(outcome.count, 1, "the earlier MCP track is reported as replaced");
assert.equal(outcome.destroyed, "MCPPlay", "and destroyed, not just stopped");
assert.equal(outcome.playing, "Walk,MCPPlay", "the game's own Walk carries on; one MCP track, not two");

// --- stop mode ---------------------------------------------------------------

outcome = run({ mode: "stop", playing: ["MCPPlay", "Idle"], sequenceClass: null });
assert.equal(outcome.status, "ok", "stop needs no sequence");
assert.equal(outcome.count, 1);
assert.equal(outcome.playing, "Idle", "only the MCP track stops");
outcome = run({ mode: "stop", animator: "never" });
assert.equal(outcome.status, "ok");
assert.equal(outcome.count, 0);
assert.equal(outcome.created, 0, "stop never creates an Animator just to find nothing on it");

// --- Failures are specific, not swallowed ------------------------------------

outcome = run({ sequenceClass: null });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /sequence.*does not exist/);
outcome = run({ sequenceClass: "Folder" });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /is a Folder, not a KeyframeSequence/);
outcome = run({ humanoid: "never" });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /no Humanoid or AnimationController/);
outcome = run({ registerFails: true });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /could not register/);
outcome = run({ loadFails: true });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /could not load/);

process.stdout.write("anim play relay: waits, replacement, stop and failure reporting ok\n");
