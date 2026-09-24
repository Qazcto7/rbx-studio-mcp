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
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginDirs, unescapeRegString } from "./plugin-dirs.mjs";

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

// Wine's .reg escapes, read back the way Wine reads them.
assert.equal(unescapeRegString("a\\\\b"), "a\\b", "an escaped backslash");
assert.equal(unescapeRegString('say \\"hi\\"'), 'say "hi"', "an escaped quote");
assert.equal(unescapeRegString("K\\x00e2z\\x131m"), "Kâzım", "non-ASCII as \\x and 1-4 hex digits");
assert.equal(unescapeRegString("x\\x0131a"), "xıa", "four digits when a hex letter follows");
assert.equal(unescapeRegString("line\\nnext\\ttab"), "line\nnext\ttab", "control characters");
assert.equal(unescapeRegString("\\101"), "A", "octal");

{
  const machine = mkdtempSync(join(tmpdir(), "studio-mcp-redirect2-"));
  const prefix = join(machine, ".local", "share", "vinegar", "prefixes", "studio");
  mkdirSync(join(prefix, "drive_c", "users", "steamuser"), { recursive: true });
  const reg = (entries) =>
    `WINE REGISTRY Version 2\n\n${entries
      .map(([section, value]) => `[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\${section}] 1712345678\n${value}\n`)
      .join("\n")}`;
  // As Wine writes a path: backslashes doubled, anything above 127 as \x.
  const asWine = (path) =>
    "Z:" + [...path].map((c) => (c === "/" ? "\\\\" : c.charCodeAt(0) > 127 ? "\\x" + c.charCodeAt(0).toString(16).padStart(4, "0") : c)).join("");
  const dirs = () => pluginDirs({ platform: "linux", env: {}, home: machine }).map((e) => e.dir);

  // A home folder with Turkish letters: the redirect is still found.
  const turkish = join(machine, "Kâzım", "appdata");
  mkdirSync(join(turkish, "Roblox"), { recursive: true });
  writeFileSync(join(prefix, "user.reg"), reg([["User Shell Folders", `"Local AppData"="${asWine(turkish)}"`]]));
  assert.deepEqual(dirs(), [join(turkish, "Roblox", "Plugins")], "a non-ASCII redirect is decoded, not dropped");

  // `User Shell Folders` holding %VAR% no longer stops the search: the resolved
  // `Shell Folders` value is used.
  writeFileSync(
    join(prefix, "user.reg"),
    reg([
      ["User Shell Folders", `"Local AppData"=str(2):"%USERPROFILE%\\\\AppData\\\\Local"`],
      ["Shell Folders", `"Local AppData"="${asWine(turkish)}"`],
    ]),
  );
  assert.deepEqual(dirs(), [join(turkish, "Roblox", "Plugins")], "falls through to Shell Folders past a %VAR%");

  // A redirect to a folder Studio never ran in (no Roblox inside) is not offered.
  const foreign = join(machine, "other-app-data");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(prefix, "user.reg"), reg([["User Shell Folders", `"Local AppData"="${asWine(foreign)}"`]]));
  assert.deepEqual(dirs(), [], "a redirect without Roblox in it is skipped, like an in-prefix folder");
}

// An ordinary prefix: Wine always writes the default, already-expanded path
// under `Shell Folders`. That is the in-prefix profile folder, not a redirect,
// and must keep its ordinary label rather than be reported as one.
{
  const machine = mkdtempSync(join(tmpdir(), "studio-mcp-plainwine-"));
  const prefix = join(machine, ".wine");
  mkdirSync(join(prefix, "drive_c", "users", "kazim", roblox), { recursive: true });
  writeFileSync(
    join(prefix, "user.reg"),
    `WINE REGISTRY Version 2\n\n[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders] 1712345678\n"Local AppData"="C:\\\\users\\\\kazim\\\\AppData\\\\Local"\n\n[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\User Shell Folders] 1712345678\n"Local AppData"=str(2):"%USERPROFILE%\\\\AppData\\\\Local"\n`,
  );
  const listed = pluginDirs({ platform: "linux", env: {}, home: machine });
  assert.deepEqual(
    listed.map((e) => [e.dir, e.label]),
    [[join(prefix, "drive_c", "users", "kazim", tail), "Wine default prefix (kazim)"]],
    "the default Local AppData is the profile folder, labelled as such",
  );
}

// One install reached by two routes -- the Flatpak data folder symlinked to the
// native one -- is listed once, not twice.
{
  const machine = mkdtempSync(join(tmpdir(), "studio-mcp-symlink-"));
  const nativeData = join(machine, ".local", "share", "vinegar");
  mkdirSync(join(nativeData, "prefixes", "studio", "drive_c", "users", "steamuser", roblox), { recursive: true });
  const flatpakParent = join(machine, ".var", "app", "org.vinegarhq.Vinegar", "data");
  mkdirSync(flatpakParent, { recursive: true });
  symlinkSync(nativeData, join(flatpakParent, "vinegar"));
  const listed = pluginDirs({ platform: "linux", env: {}, home: machine });
  assert.equal(listed.length, 1, `one folder, reached twice, listed once: ${JSON.stringify(listed)}`);
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
