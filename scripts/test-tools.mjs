/**
 * Offline checks for tool output shaping that needs no Studio.
 *
 * Usage: node scripts/test-tools.mjs
 */
import assert from "node:assert/strict";
import { CHARACTER_LIMIT } from "../dist/lib/format.js";
import { clipListing, numbered } from "../dist/tools/scripts.js";

const item = (path, lineCount) => ({ path, className: "ModuleScript", lineCount, startLine: 1, source: "" });
const listing = (path, lines) =>
  `${path}  (ModuleScript, ${lines} lines)\n` +
  numbered(Array.from({ length: lines }, (_, index) => `local v${index} = ${index}`).join("\n"), 1);

// Small reads pass through untouched.
{
  const blocks = [listing("A", 3)];
  assert.equal(clipListing(blocks, [item("A", 3)], null), blocks[0]);
}

// A big read is cut on a whole line and names the exact next window.
{
  const out = clipListing([listing("Big", 5000), listing("After", 5)], [item("Big", 5000), item("After", 5)], null);
  assert.ok(out.length <= CHARACTER_LIMIT, "fits the limit");
  const match = /Big stops at line (\d+) of 5000\. Continue with \{ path: "Big", startLine: (\d+) \}/.exec(out);
  assert.ok(match, "names where to continue");
  assert.equal(Number(match[2]), Number(match[1]) + 1);
  const lastShown = out.split("\n\n[clipped")[0].split("\n").pop();
  assert.match(lastShown, new RegExp(`^\s*${match[1]}│ local v${Number(match[1]) - 1} = ${Number(match[1]) - 1}$`), "last line is whole");
  assert.match(out, /1 more script\(s\) after it were not shown/);
}

// Failures are never the part that gets clipped away.
{
  const out = clipListing([listing("Big", 5000)], [item("Big", 5000)], "Could not read 1 path(s):\n  - Nope");
  assert.ok(out.startsWith("Could not read 1 path(s)"));
}

process.stdout.write("tools: ok\n");

// Exercise the public schemas and forwarding through the real tool handlers.
const { z } = await import("zod");
const { registerExecTools } = await import("../dist/tools/exec.js");
const { registerInputTools } = await import("../dist/tools/input.js");
const registered = new Map();
const calls = [];
let nextInputReply = null;
const context = {
  server: { registerTool(name, spec, handler) { registered.set(name, { spec, handler }); } },
  bridge: { async call(op, params, options) {
    calls.push({op, params, options});
    return op === "exec.run" ? {ok:true,returned:["nil",{answer:42}],output:[],milliseconds:1} : (nextInputReply ?? {delivered:true,steps:1,player:"Alice"});
  } },
};
registerExecTools(context);
registerInputTools(context);
const execute = registered.get("execute_luau");
const parsed = z.object(execute.spec.inputSchema).parse({source:"return nil",target:"client",player:"Alice",timeoutSeconds:2});
await execute.handler(parsed);
assert.equal(calls.at(-1).params.target, "client");
assert.equal(calls.at(-1).params.player, "Alice");
assert.equal(calls.at(-1).options.timeoutMs, 12000);
await execute.handler(z.object(execute.spec.inputSchema).parse({source:"return 1"}));
assert.equal(calls.at(-1).params.target, "studio");
assert.equal(calls.at(-1).options.timeoutMs, 60000);
const input = registered.get("input");
for (const step of [{kind:"click",target:"PlayerGui.HUD.BuyButton"},{kind:"text",target:"PlayerGui.HUD.NameBox",text:"hello"},{kind:"click",x:100,y:200}]) {
 await input.handler(z.object(input.spec.inputSchema).parse({steps:[step]}));
 assert.deepEqual(calls.at(-1).params.steps[0], step);
}
// Issue #4: ordinary decimal holds/waits retain padding and yield whole milliseconds.
for (const steps of [
 [{kind:"key",key:"E",hold:0.1,after:4.1}, ...Array.from({length:24}, () => ({kind:"key",key:"Left",hold:0.05,after:1.065}))],
 [{kind:"key",key:"E",hold:0.05,after:1.0651}],
]) {
 await input.handler(z.object(input.spec.inputSchema).parse({steps}));
 const raw = (35 + steps.reduce((sum, step) => sum + step.hold + step.after + 0.5, 0)) * 1000;
 assert.equal(calls.at(-1).options.timeoutMs, Math.ceil(raw));
 assert.ok(Number.isInteger(calls.at(-1).options.timeoutMs));
 assert.deepEqual(calls.at(-1).params.steps, steps, "step timing itself is unchanged");
}
assert.deepEqual([...registered.keys()].sort(), ["execute_luau", "input", "viewport"]);
process.stdout.write("client tool schemas: ok\n");

// `release_all` is a step kind, and it survives the strict schema untouched.
{
 const releaseStep = {kind:"release_all"};
 await input.handler(z.object(input.spec.inputSchema).parse({steps:[releaseStep]}));
 assert.deepEqual(calls.at(-1).params.steps[0], releaseStep);
 const withKey = {kind:"release_all", key:"W"};
 await input.handler(z.object(input.spec.inputSchema).parse({steps:[withKey]}));
 assert.deepEqual(calls.at(-1).params.steps[0], withKey);
}

// "The client read no pointer event" is for a press that went unread. A plan that
// only releases has nothing to read, and a right click that was read reports where
// it landed instead of being called a failure.
{
 const parse = (steps) => z.object(input.spec.inputSchema).parse({steps});
 const text = (result) => result.content[0].text;
 const sent = {delivered:true,steps:1,player:"Alice",performed:["click"]};
 nextInputReply = sent;
 assert.match(text(await input.handler(parse([{kind:"click",x:1,y:1,button:"MouseButton2",action:"tap"}]))), /read no pointer event/, "an unread press still warns");
 assert.doesNotMatch(text(await input.handler(parse([{kind:"click",x:1,y:1,button:"MouseButton2",action:"release"}]))), /read no pointer event/, "a release has nothing to read");
 nextInputReply = {...sent, landed:{sent:{x:1,y:1},seen:{x:1,y:-57}}};
 assert.doesNotMatch(text(await input.handler(parse([{kind:"click",x:1,y:1,button:"MouseButton2",action:"tap"}]))), /read no pointer event/, "a read right click is not a failure");
 nextInputReply = null;
}

// Client relay threads die with the call: `settleSeconds` is forwarded, extends the
// deadline, and a spawn without it is called out in the reply.
{
 const settled = await execute.handler(z.object(execute.spec.inputSchema).parse({source:"return 1",target:"client",timeoutSeconds:2,settleSeconds:5}));
 assert.equal(calls.at(-1).params.settleSeconds, 5);
 assert.equal(calls.at(-1).options.timeoutMs, (2 + 5 + 10) * 1000);
 assert.ok(!settled.content[0].text.includes("background threads"));
 const spawned = await execute.handler(z.object(execute.spec.inputSchema).parse({source:"task.spawn(function() task.wait(3) end)",target:"client"}));
 assert.match(spawned.content[0].text, /background threads/);
 const waitedInline = await execute.handler(z.object(execute.spec.inputSchema).parse({source:"task.spawn(function() end)",target:"client",settleSeconds:3}));
 assert.ok(!waitedInline.content[0].text.includes("background threads"));
 const studioSpawn = await execute.handler(z.object(execute.spec.inputSchema).parse({source:"task.spawn(function() end)"}));
 assert.ok(!studioSpawn.content[0].text.includes("background threads"), "the warning is for the client relay only");
}

const { registerDebugTools } = await import("../dist/tools/debug.js");
registerDebugTools(context);
const debug = registered.get("debug");
const remoteArgs = z.object(debug.spec.inputSchema).parse({op:"remotes",path:"ReplicatedStorage",player:"Alice",seconds:3});
await debug.handler(remoteArgs);
assert.equal(calls.at(-1).op, "debug.remotes");
assert.deepEqual(calls.at(-1).params, {path:"ReplicatedStorage",player:"Alice",seconds:3});
assert.equal(calls.at(-1).options.timeoutMs, 18000);
assert.throws(() => z.object(debug.spec.inputSchema).parse({op:"remotes",seconds:16}));
assert.deepEqual([...registered.keys()].sort(), ["debug", "execute_luau", "input", "viewport"]);
process.stdout.write("remote trace schema: ok\n");

const { registerPlaytestTools } = await import("../dist/tools/playtest.js");
registerPlaytestTools(context);
const playtest = registered.get("playtest");
for (const guidance of ["AGENTS.md", "CLAUDE.md", "user instructions", "project guidance", "even when ON", "Do not bypass"]) {
 assert.ok(playtest.spec.description.includes(guidance), `playtest guidance preserves ${guidance}`);
}
const normalCall = context.bridge.call;
context.bridge.call = async (op, params) => {
 if (["play", "run", "multiplayer"].includes(params.op)) {
  const { ToolError } = await import("../dist/lib/errors.js");
  throw new ToolError("PLAYTEST_DISABLED", "Playtests are disabled by the user.", "Do not start or simulate a playtest. Continue using edit-mode tools and static inspection where possible.\nRun `playtests on` in the Studio MCP panel to re-enable playtesting.");
 }
 return {changed:false,state:{playtestsAllowed:false}};
};
// The Linux/Wine multiplayer guard sits ahead of the plugin call, so the lock
// behaviour is exercised with it opted out, and the guard itself is checked below.
const priorAllow = process.env.STUDIO_MCP_ALLOW_MULTIPLAYER;
process.env.STUDIO_MCP_ALLOW_MULTIPLAYER = "1";
for (const op of ["play", "run", "multiplayer"]) {
 const result = await playtest.handler(z.object(playtest.spec.inputSchema).parse({op}));
 assert.equal(result.isError, true);
 assert.match(result.content[0].text, /PLAYTEST_DISABLED/);
 assert.match(result.content[0].text, /playtests on/);
}
if (priorAllow === undefined) delete process.env.STUDIO_MCP_ALLOW_MULTIPLAYER;
else process.env.STUDIO_MCP_ALLOW_MULTIPLAYER = priorAllow;
if (process.platform === "linux") {
 delete process.env.STUDIO_MCP_ALLOW_MULTIPLAYER;
 let sent = false;
 context.bridge.call = async () => { sent = true; return {changed:true,state:{}}; };
 const refused = await playtest.handler(z.object(playtest.spec.inputSchema).parse({op:"multiplayer"}));
 assert.equal(refused.isError, true);
 assert.match(refused.content[0].text, /MULTIPLAYER_UNSAFE/);
 assert.equal(sent, false, "the refused multiplayer call must never reach Studio");
 if (priorAllow !== undefined) process.env.STUDIO_MCP_ALLOW_MULTIPLAYER = priorAllow;
}
const stateResult = await playtest.handler(z.object(playtest.spec.inputSchema).parse({op:"state"}));
assert.ok(!stateResult.isError);
context.bridge.call = normalCall;
process.stdout.write("playtest lock errors and instruction precedence: ok\n");

// OFF affects simulation starts, not the ordinary edit-mode tool paths.
const { registerDiscoverTools } = await import("../dist/tools/discover.js");
const { registerScriptTools } = await import("../dist/tools/scripts.js");
const { registerScreenshotTools } = await import("../dist/tools/screenshot.js");
registerDiscoverTools(context);
registerScriptTools(context);
registerScreenshotTools(context);
const editOps = [];
context.bridge.sessions = async () => ({list:[{studioId:"edit",context:"edit"}],activeId:"edit"});
context.bridge.call = async (op, params) => {
 editOps.push(op);
 if (op === "playtest.control") {
  if (["play", "run", "multiplayer"].includes(params.op)) throw new Error("PLAYTEST_DISABLED");
  return {changed:false,state:{playtestsAllowed:false}};
 }
 const results = {
  "exec.run": {ok:true,returned:[42],output:[],milliseconds:1},
  "discover.tree": {items:[],total:0,offset:0},
  "discover.inspect": {items:[],failures:[]},
  "script.read": {items:[],failures:[]},
  "viewport.ui": {findings:[],checked:0,hidden:0,root:"StarterGui",screen:"800x600"},
  "capture.screenshot": {encoding:"png",data:"AA==",width:1,height:1,sourceWidth:1,sourceHeight:1,bytes:1,context:"edit"},
 };
 assert.ok(op in results, `unexpected edit-mode operation ${op}`);
 return results[op];
};
for (const [name, args, expected] of [
 ["execute_luau",{source:"return 42",target:"studio"},"exec.run"],
 ["tree",{},"discover.tree"],
 ["inspect",{paths:["Workspace"],detail:"concise"},"discover.inspect"],
 ["script_read",{paths:["ServerScriptService.Example"]},"script.read"],
 ["viewport",{op:"ui",path:"StarterGui"},"viewport.ui"],
 ["screenshot",{},"capture.screenshot"],
]) {
 const tool = registered.get(name);
 const result = await tool.handler(z.object(tool.spec.inputSchema).parse(args));
 assert.ok(!result.isError, `${name} remains usable with playtests OFF: ${JSON.stringify(result)}`);
 assert.equal(editOps.at(-1),expected);
}
assert.ok(!editOps.includes("playtest.control"), "edit-mode tools never start or probe a simulation");
context.bridge.call = normalCall;
process.stdout.write("playtest lock leaves edit-mode tools available: ok\n");

// Animation: the build reply labels the id preview-only, and `parent` reaches the plugin.
{
 const { registerAnimTools } = await import("../dist/tools/anim.js");
 const { registerInstanceTools } = await import("../dist/tools/instances.js");
 const tools = new Map();
 const seen = [];
 const animContext = {
  server: { registerTool(name, spec, handler) { tools.set(name, { spec, handler }); } },
  bridge: { async call(op, params) {
   seen.push({op, params});
   if (op === "anim.build") return {animationId:"a".repeat(32), keyframeCount:2, poseCount:1, hierarchy:"R6", instance:"Workspace.Rig.Tool.MCPAnimation", scope:"preview-only"};
   if (op === "instances.modify" || op === "instances.create") return {items:[{path:"Workspace.Anim",className:"Animation",changed:["AnimationId"]}], undoStep:"MCP modify"};
   throw new Error("unexpected " + op);
  } },
 };
 registerAnimTools(animContext);
 registerInstanceTools(animContext);
 const anim = tools.get("animation");
 const built = await anim.handler(z.object(anim.spec.inputSchema).parse({op:"build",parent:"Workspace.Rig.Tool",keyframes:[{time:0,poses:{"Right Arm":"0, 1, 0"}},{time:0.5}]}));
 assert.equal(seen.at(-1).params.parent, "Workspace.Rig.Tool");
 assert.match(built.content[0].text, /PREVIEW ONLY/);
 assert.match(built.content[0].text, /op="play" sequence="Workspace\.Rig\.Tool\.MCPAnimation"/);
 assert.match(built.content[0].text, /Workspace\.Rig\.Tool\.MCPAnimation/);
 assert.match(anim.spec.description, /NEVER put a `build` id in the AnimationId/);

 // `play` needs `sequence`, and passes rig/player/fadeTime/weight/speed through untouched.
 const noSequence = await anim.handler(z.object(anim.spec.inputSchema).parse({op:"play"}));
 assert.match(noSequence.content[0].text, /needs `sequence`/);

 seen.length = 0;
 animContext.bridge.call = async (op, params) => {
  seen.push({op, params});
  if (op === "anim.play") return {played:true, player:"Player1", animationId:"session-hash", length:2.5, looped:false, priority:"Action"};
  throw new Error("unexpected " + op);
 };
 const played = await anim.handler(z.object(anim.spec.inputSchema).parse({
  op:"play", sequence:"Workspace.Rig.Tool.MCPAnimation", rig:"Workspace.OtherRig", player:"P2", fadeTime:0.2, weight:1, speed:1.5,
 }));
 assert.deepEqual(seen.at(-1).params, {
  sequence:"Workspace.Rig.Tool.MCPAnimation", rig:"Workspace.OtherRig", player:"P2", fadeTime:0.2, weight:1, speed:1.5,
 });
 assert.match(played.content[0].text, /"played": true/);
 assert.match(played.content[0].text, /"animationId": "session-hash"/);

 // A bare hash written to AnimationId is called out (also when nested under
 // `children`); a real asset id and unrelated properties are not.
 const { bareAnimationHashNote } = await import("../dist/tools/instances.js");
 const hashed = "0123456789abcdef0123456789abcdef";
 const warned = bareAnimationHashNote([{paths:["Workspace.Anim"],properties:{AnimationId:hashed}}]);
 assert.match(warned, /bare hash/);
 assert.match(warned, /T-pose/);
 assert.match(bareAnimationHashNote([{className:"Tool",children:[{className:"Animation",properties:{AnimationId:hashed}}]}]), /bare hash/);
 assert.equal(bareAnimationHashNote([{properties:{AnimationId:"rbxassetid://12345"}}]), undefined);
 assert.equal(bareAnimationHashNote([{properties:{Name:hashed}}]), undefined);
}
process.stdout.write("animation: preview-only labelling and warnings ok\n");
