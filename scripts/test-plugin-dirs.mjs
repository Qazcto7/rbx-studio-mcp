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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// Vinegar points Studio's Local AppData at a folder OUTSIDE the prefix, so the
// plugins live there and the profile folder inside the prefix is never read. The
// registry is what says so.
{
  const machine = mkdtempSync(join(tmpdir(), "studio-mcp-redirect-"));
  const prefix = join(machine, ".local", "share", "vinegar", "prefixes", "studio");
  const appdata = join(machine, ".local", "share", "vinegar", "appdata");
  mkdirSync(join(prefix, "drive_c", "users", "steamuser"), { recursive: true });
  mkdirSync(join(appdata, "Roblox"), { recursive: true });
  const reg = (section, value) =>
    `WINE REGISTRY Version 2\n\n[Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\${section}] 1712345678\n#time=1da\n${value}\n\n[Other]\n"Local AppData"="Z:\\\\nowhere"\n`;
  const windows = "Z:" + appdata.replaceAll("/", "\\\\");
  const dirs = () => pluginDirs({ platform: "linux", env: {}, home: machine });

  // REG_SZ, as Vinegar writes it.
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"="${windows}"`));
  assert.deepEqual(dirs().map((e) => e.dir), [join(appdata, "Roblox", "Plugins")], "the redirected folder is found");
  assert.match(dirs()[0].label, /Local AppData redirect/);

  // REG_EXPAND_SZ carries a type tag; same answer.
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"=str(2):"${windows}"`));
  assert.deepEqual(dirs().map((e) => e.dir), [join(appdata, "Roblox", "Plugins")], "a typed value is read too");

  // The resolved `Shell Folders` key is the fallback when there is no override.
  writeFileSync(join(prefix, "user.reg"), reg("Shell Folders", `"Local AppData"="${windows}"`));
  assert.deepEqual(dirs().map((e) => e.dir), [join(appdata, "Roblox", "Plugins")], "Shell Folders is the fallback");

  // A section that merely contains the words, or another key, is not it.
  writeFileSync(join(prefix, "user.reg"), `[Elsewhere\\User Shell Folders]\n"Local AppData"="${windows}"\n`);
  assert.deepEqual(dirs(), [], "only the Explorer key counts");

  // Unexpanded variables are not guessed at.
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"=str(2):"%USERPROFILE%\\\\AppData\\\\Local"`));
  assert.deepEqual(dirs(), [], "a %VAR% path falls back to the default folders");

  // A redirect to a folder that does not exist is not offered as a place to install.
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"="Z:\\\\no\\\\such\\\\dir"`));
  assert.deepEqual(dirs(), [], "a missing redirect target is skipped");

  // A C: path resolves inside the prefix.
  mkdirSync(join(prefix, "drive_c", "appdata", "Roblox"), { recursive: true });
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"="C:\\\\appdata"`));
  assert.deepEqual(dirs().map((e) => e.dir), [join(prefix, "drive_c", "appdata", "Roblox", "Plugins")], "C: maps to drive_c");

  // The redirect and the default folder are both offered when both exist.
  mkdirSync(join(prefix, "drive_c", "users", "steamuser", roblox), { recursive: true });
  writeFileSync(join(prefix, "user.reg"), reg("User Shell Folders", `"Local AppData"="${windows}"`));
  assert.deepEqual(
    dirs().map((e) => e.dir),
    [join(appdata, "Roblox", "Plugins"), join(prefix, "drive_c", "users", "steamuser", tail)],
    "redirect first, then the in-prefix profile",
  );
}

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
