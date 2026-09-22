/**
 * Offline checks for doctor's install-matching logic.
 *
 * `matchInstalls` is the piece that ties a connected Studio session's build id
 * back to which installed copy on disk it most likely loaded -- the thing a
 * two-Vinegar-install machine used to be unable to tell you at all: a stale
 * buildId said *that* something was wrong, never *which folder* to fix.
 *
 * Usage: node scripts/test-doctor.mjs
 */
import assert from "node:assert/strict";
import { matchInstalls } from "../dist/doctor.js";

const copy = (label, id, dir = `/prefixes/${label}`) => ({ dir, label, file: `${dir}/StudioMCP.rbxmx`, id });

// No installs found on the machine at all: nothing to say beyond "found none".
assert.equal(matchInstalls("abc123", []), "");

// Exactly one on-disk copy carries this build id: name it.
{
  const copies = [copy("native", "abc123"), copy("flatpak", "def456")];
  const detail = matchInstalls("abc123", copies);
  assert.match(detail, /Loaded from: native \(\/prefixes\/native\)/);
}

// The running session's build id matches neither install on disk (both are a
// different, presumably older, build) -- distinct from "no installs exist".
{
  const copies = [copy("native", "def456"), copy("flatpak", "def456")];
  const detail = matchInstalls("abc123", copies);
  assert.match(detail, /matches none of the installed copies/);
}

// Two prefixes share the same (current) build id: named as a narrowed set,
// not a false single answer.
{
  const copies = [copy("native", "abc123"), copy("flatpak", "abc123")];
  const detail = matchInstalls("abc123", copies);
  assert.match(detail, /Loaded from one of: native, flatpak/);
}

// A copy with no readable build id (truncated/missing file) never matches.
{
  const copies = [copy("native", null), copy("flatpak", "abc123")];
  const detail = matchInstalls("abc123", copies);
  assert.match(detail, /Loaded from: flatpak/);
}

process.stdout.write("doctor: install matching ok\n");
