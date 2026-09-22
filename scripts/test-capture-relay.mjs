/**
 * Runs the screenshot relay's real Luau source (CLIENT_SOURCE, embedded in
 * handlers/Capture.luau) against a fake CaptureService.
 *
 * The relay only ever executes in a playtest client, so nothing else exercises
 * it. This covers the one-retry behaviour: a `CaptureScreenshot` callback that
 * never fires, or that is refused outright, is retried once before the client
 * gives up and reports failure -- the same shape as the editor-side
 * `attemptCapture`/`takeScreenshot` in Capture.luau, which scripts/test-plugin.mjs
 * does not reach because it only bundles modules loaded with `require`, and this
 * source is a string, not a module.
 *
 * Usage: node scripts/test-capture-relay.mjs
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

const captureSource = readFileSync(join(root, "plugin/src/handlers/Capture.luau"), "utf8");

const captureTimeout = captureSource.match(/local CAPTURE_TIMEOUT = (\d+)/)?.[1];
assert.ok(captureTimeout, "CAPTURE_TIMEOUT found");

const template = captureSource.match(/local CLIENT_SOURCE = \(\[==\[([\s\S]*?)\]==\]\)/)?.[1];
assert.ok(template, "CLIENT_SOURCE template found");
// Mirrors the `:gsub` the real module applies at runtime, so the harness runs
// exactly what a playtest client would.
const relay = template.split("CLIENT_CAPTURE_TIMEOUT").join(captureTimeout);
assert.ok(!relay.includes("CLIENT_CAPTURE_TIMEOUT"), "placeholder substituted");

const lua = (value) => JSON.stringify(value);

/**
 * @param attempts one entry per `CaptureScreenshot` call the relay is expected
 *   to make: "id:<x>" answers with that content id, "throw:<msg>" makes the
 *   pcall around the call fail, and "hang" never calls back at all (the relay's
 *   own poll loop is what gives up on it).
 */
function run(attempts) {
  const branches = attempts
    .map((attempt, index) => {
      let body;
      if (attempt.startsWith("id:")) {
        body = `callback(${lua(attempt.slice(3))})`;
      } else if (attempt.startsWith("throw:")) {
        body = `error(${lua(attempt.slice(6))}, 0)`;
      } else if (attempt === "hang") {
        body = "-- never calls back";
      } else {
        throw new Error(`unknown attempt: ${attempt}`);
      }
      return `calls == ${index + 1} then\n\t\t${body}`;
    })
    .join("\n\telseif ");

  const harness = `
local calls = 0
local services = {
  CaptureService = {
    CaptureScreenshot = function(_, callback)
      calls += 1
      if ${branches}
      end
    end,
  },
  RunService = { PreRender = { Wait = function() end } },
}
game = { GetService = function(_, name) return services[name] end }
local reported
local remote = { FireServer = function(_, payload) reported = payload end }
script = { WaitForChild = function() return remote end }
task = { wait = function() return 0.05 end }
-- Wrapped so the relay's own early \`return\`s (on failure) only leave this
-- function, not the whole harness -- the relay is a standalone chunk in
-- Capture.luau, and concatenating it in unwrapped would let its \`return\`
-- exit before the assert/print below ever run.
;(function()
${relay}
end)()
assert(reported ~= nil, "relay never reported")
if reported.ok then
  print("ok|" .. tostring(reported.contentId))
else
  print("fail|" .. tostring(reported.reason))
end
`;
  const path = join(mkdtempSync(join(tmpdir(), "studio-mcp-capture-")), "relay.luau");
  writeFileSync(path, harness);
  const result = spawnSync(luau, [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `relay crashed: ${result.stderr}${result.stdout}`);
  const [status, detail] = result.stdout.trim().split("|");
  return { status, detail };
}

// The common case: the first attempt succeeds and there is no retry at all.
let outcome = run(["id:abc"]);
assert.equal(outcome.status, "ok");
assert.equal(outcome.detail, "abc");

// A callback that never fires is retried once, and the retry succeeding is
// reported as an ordinary success -- the agent never sees the first failure.
outcome = run(["hang", "id:xyz"]);
assert.equal(outcome.status, "ok");
assert.equal(outcome.detail, "xyz");

// `CaptureScreenshot` refusing outright is retried the same as a hang.
outcome = run(["throw:not now", "id:xyz"]);
assert.equal(outcome.status, "ok");
assert.equal(outcome.detail, "xyz");

// Two hangs in a row is reported as failure, with both attempts in the reason
// so a stuck client and an occasional miss don't look identical.
outcome = run(["hang", "hang"]);
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /no callback within \d+s/);
assert.match(outcome.detail, /retry.*no callback within \d+s/);

// A refusal followed by a timeout (or the reverse) keeps both reasons, not
// just the last one.
outcome = run(["throw:not now", "hang"]);
assert.equal(outcome.status, "fail");
assert.match(outcome.detail, /refused: not now/);
assert.match(outcome.detail, /retry no callback within \d+s/);

process.stdout.write("capture relay: retry ok\n");
