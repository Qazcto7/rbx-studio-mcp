/**
 * Runs the animation-play relay's real Luau source (CLIENT_PLAY_SOURCE,
 * embedded in handlers/Anim.luau) against a fake KeyframeSequenceProvider and
 * a fake DataModel.
 *
 * This is the logic `animation op="play"` replaced: four lines of client Luau
 * the agent used to have to paste into `execute_luau target="client"` --
 * find the sequence, find the right Animator, register, load, play, and say
 * plainly what went wrong at each step. It only ever executes in a playtest
 * client, so nothing else exercises it (tests/anim.luau covers the server
 * side: what `Anim.play` hands the relay, not what the relay does with it).
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
 * @param scene describes the fake DataModel: `sequence` (the KeyframeSequence
 *   at "Workspace.Seq", or a wrong-class instance, or omitted entirely),
 *   `rig` attribute to send (or undefined for "fall back to the character"),
 *   `character` (a fake model with a Humanoid, or null for "not spawned"),
 *   `otherRig` (a fake model at "Workspace.OtherRig", for the explicit-rig
 *   case), and `hasAnimator` (whether the Humanoid already has one).
 */
function run({ sequenceClass = "KeyframeSequence", rig, character = true, hasAnimator = true, registerFails = false, loadFails = false } = {}) {
  const harness = `
local reported
local Report = { FireServer = function(_, payload) reported = payload end }
local script = {
  GetAttribute = function(_, name)
    if name == "Sequence" then return "Workspace.Seq" end
    if name == "Rig" then return ${rig === undefined ? "nil" : JSON.stringify(rig)} end
    return nil
  end,
  WaitForChild = function(_, name)
    if name == "Report" then return Report end
    if name == "Paths" then return "PathsModule" end
    return nil
  end,
}

local function humanoid(name, withAnimator)
  local animator = nil
  local self
  self = {
    ClassName = "Humanoid",
    FindFirstChildOfClass = function(_, class)
      if class == "Animator" and withAnimator then return animator end
      return nil
    end,
  }
  if withAnimator then
    animator = {
      ClassName = "Animator",
      LoadAnimation = function(_, anim)
        if ${loadFails} then error("LoadAnimation refused") end
        return {
          Play = function() end,
          Length = 2.5,
          Looped = false,
          Priority = "Action",
        }
      end,
    }
  end
  return self
end

local sequenceInstance = nil
${
  sequenceClass === null
    ? ""
    : `sequenceInstance = { ClassName = ${JSON.stringify(sequenceClass)} }
sequenceInstance.IsA = function(self, class) return self.ClassName == class end`
}

local characterModel = nil
${character ? `characterModel = { GetFullName = function() return "Players.P1.Character" end, FindFirstChildOfClass = function(_, class) if class == "Humanoid" then return humanoid("H", ${hasAnimator}) end return nil end }` : ""}

local otherRigModel = { GetFullName = function() return "Workspace.OtherRig" end, FindFirstChildOfClass = function(_, class) if class == "Humanoid" then return humanoid("H2", true) end return nil end }

local paths = {
  resolve = function(path)
    if path == "Workspace.Seq" then
      if sequenceInstance == nil then error({ code = "NOT_FOUND", message = "Workspace.Seq does not exist" }) end
      return sequenceInstance
    end
    if path == "Workspace.OtherRig" then return otherRigModel end
    error({ code = "NOT_FOUND", message = path .. " does not exist" })
  end,
}
local function require(name)
  if name == "PathsModule" then return paths end
  error("unknown module")
end

local KeyframeSequenceProvider = {
  RegisterKeyframeSequence = function(_, seq)
    if ${registerFails} then error("cannot register this sequence") end
    return "session-hash"
  end,
}
local Players = { LocalPlayer = { Character = characterModel } }
local game = {
  GetService = function(_, name)
    if name == "KeyframeSequenceProvider" then return KeyframeSequenceProvider end
    if name == "Players" then return Players end
  end,
}
local Instance = {
  new = function(class)
    if class == "Animation" then return { AnimationId = nil } end
    if class == "Animator" then
      -- A freshly-created Animator (the "no Animator yet" case) has to be
      -- just as usable as one a Humanoid already carried -- the relay treats
      -- them identically, so the stub must too.
      return {
        ClassName = "Animator",
        Parent = nil,
        LoadAnimation = function(_, anim)
          if ${loadFails} then error("LoadAnimation refused") end
          return { Play = function() end, Length = 2.5, Looped = false, Priority = "Action" }
        end,
      }
    end
  end,
}

-- Wrapped so the relay's own early \`return\`s (every failure branch) only
-- leave this function, not the whole harness -- the relay is a standalone
-- chunk in Anim.luau, and splicing it in unwrapped would let a \`return\`
-- exit before the report below ever runs.
;(function()
${relay}
end)()

if reported.ok then
  print("ok|" .. tostring(reported.animationId) .. "|" .. tostring(reported.length))
else
  print("fail|" .. tostring(reported.reason))
end
`;
  const path = join(mkdtempSync(join(tmpdir(), "studio-mcp-anim-play-")), "relay.luau");
  writeFileSync(path, harness);
  const result = spawnSync(luau, [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `relay crashed: ${result.stderr}${result.stdout}`);
  const [status, ...rest] = result.stdout.trim().split("|");
  return { status, detail: rest.join("|") };
}

// The common case: no rig given, plays on the local player's own character,
// which already has an Animator.
let outcome = run({});
assert.equal(outcome.status, "ok");
assert.match(outcome.detail, /^session-hash\|2\.5$/);

// An explicit rig is resolved and used instead of the character.
outcome = run({ rig: "Workspace.OtherRig" });
assert.equal(outcome.status, "ok");

// No rig given and no character spawned yet: a specific reason, not a nil
// index crash.
outcome = run({ character: false });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /no character yet/);

// The sequence path does not resolve.
outcome = run({ sequenceClass: null });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /sequence.*does not exist/);

// The path resolves to something that is not a KeyframeSequence at all --
// the id `build` returns without `parent`, say.
outcome = run({ sequenceClass: "Folder" });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /is a Folder, not a KeyframeSequence/);

// A Humanoid with no Animator yet gets one created rather than failing --
// ordinary for a rig that has never played anything.
outcome = run({ hasAnimator: false });
assert.equal(outcome.status, "ok");

// Registration or loading refusing is reported, not swallowed.
outcome = run({ registerFails: true });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /could not register/);

outcome = run({ loadFails: true });
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /could not load/);

process.stdout.write("anim play relay: sequence/rig resolution and failure reporting ok\n");
