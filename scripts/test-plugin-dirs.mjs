/**
 * Where the installer looks for Studio's plugins folder.
 *
 * The Linux cases are the reason this exists: a machine with two Vinegar
 * installs (native and Flatpak) was installed into one and run from the other,
 * so every session reported a stale plugin that had "just" been installed.
 *
 * Usage: node scripts/test-plugin-dirs.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginDirs } from "./plugin-dirs.mjs";

const tail = join("AppData", "Local", "Roblox", "Plugins");
const roblox = join("AppData", "Local", "Roblox");

const home = mkdtempSync(join(tmpdir(), "studio-mcp-dirs-"));
const native = join(home, ".local", "share", "vinegar", "prefixes", "studio", "drive_c", "users", "steamuser");
const flatpak = join(home, ".var", "app", "org.vinegarhq.Vinegar", "data", "vinegar", "prefixes", "studio", "drive_c", "users", "steamuser");
for (const user of [native, flatpak]) mkdirSync(join(user, roblox), { recursive: true });
// Wine's shared profile and a user Studio never ran under are not plugin folders.
mkdirSync(join(native, "..", "Public", roblox), { recursive: true });
mkdirSync(join(native, "..", "nobody"), { recursive: true });

const found = pluginDirs({ platform: "linux", env: {}, home }).map((entry) => entry.dir);
assert.deepEqual(found, [join(native, tail), join(flatpak, tail)], "native and Flatpak Vinegar are both found");

// XDG_DATA_HOME moves the native install; the same folder is never listed twice.
const moved = join(home, "xdg");
mkdirSync(join(moved, "vinegar", "prefixes", "studio", "drive_c", "users", "steamuser", roblox), { recursive: true });
const withXdg = pluginDirs({ platform: "linux", env: { XDG_DATA_HOME: moved }, home }).map((entry) => entry.dir);
assert.ok(withXdg.includes(join(moved, "vinegar", "prefixes", "studio", "drive_c", "users", "steamuser", tail)));
assert.equal(new Set(withXdg).size, withXdg.length);

// A machine with nothing installed reports nothing rather than guessing.
assert.deepEqual(pluginDirs({ platform: "linux", env: {}, home: mkdtempSync(join(tmpdir(), "studio-mcp-empty-")) }), []);

// The override wins outright and may name several folders.
const sep = process.platform === "win32" ? ";" : ":";
assert.deepEqual(
  pluginDirs({ platform: "linux", env: { STUDIO_MCP_PLUGINS_DIR: `/a${sep}/b` }, home }).map((entry) => entry.dir),
  ["/a", "/b"],
);

assert.deepEqual(
  pluginDirs({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home }).map((entry) => entry.label),
  ["Windows"],
);
assert.equal(pluginDirs({ platform: "darwin", env: {}, home })[0].dir, join(home, "Documents", "Roblox", "Plugins"));

process.stdout.write("plugin dirs: linux prefixes, override, windows, macos ok\n");
