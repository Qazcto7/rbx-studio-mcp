/**
 * Where Roblox Studio looks for plugins, on every platform this project runs on.
 *
 * One copy of this knowledge, shared by `install-plugin.mjs` (which writes to
 * these folders) and `doctor` (which reads them). It used to live in both, and
 * the two agreed only on Windows and macOS -- which is the whole reason a Linux
 * install could go stale without anyone being told.
 *
 * Linux is the interesting case. Studio does not run natively there; it runs
 * under Wine, usually through Vinegar, and one machine can have SEVERAL Wine
 * prefixes that each contain a complete `Roblox/Plugins` folder:
 *
 *   - a native Vinegar install:  ~/.local/share/vinegar/prefixes/studio/...
 *   - a Flatpak Vinegar install: ~/.var/app/org.vinegarhq.Vinegar/data/vinegar/...
 *   - a plain Wine prefix:       ~/.wine/...
 *
 * Measured: a machine had the first two at once. The plugin was installed into
 * the Flatpak prefix, Studio was launched from the native one, and every
 * `studio_status` reported a build mismatch against a plugin that had in fact
 * just been "installed". Which prefix Studio uses is not something this script
 * can know, so on Linux it writes to every one it finds.
 *
 * Nothing here has side effects; callers decide what to do with the list.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Relative path from a Wine `users/<name>` directory to the plugins folder. */
const PLUGINS_UNDER_USER = join("AppData", "Local", "Roblox", "Plugins");

/** Lists subdirectories, or nothing if the directory cannot be read. */
function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Where a prefix's registry says `Local AppData` is, as a host path -- or null
 * when it says nothing, and the profile folder inside the prefix applies.
 *
 * Vinegar moves it. When it creates a prefix it writes
 * `User Shell Folders\Local AppData = Z:\home\<you>\.local\share\vinegar\appdata`,
 * so Studio's `%LOCALAPPDATA%` -- and with it `Roblox\Plugins` -- is a folder
 * OUTSIDE the prefix, shared by every prefix Vinegar makes. Looking only under
 * `drive_c/users/<name>/AppData/Local`, as this file first did, finds nothing on
 * a prefix made that way (or worse, an empty leftover folder that Studio never
 * reads). The registry is what Studio itself asks, so it is what is read here.
 *
 * Only an absolute drive-letter path is trusted. Anything with `%VAR%` in it
 * needs Wine to expand it, and guessing wrong is worse than using the default.
 */
/**
 * A string value from a Wine .reg file, unescaped the way Wine reads it back.
 *
 * Wine writes every character above 127 as `\x` and hex (`\x00e2` for "â",
 * `\x131` for "ı" -- up to four digits), control characters as `\n`, `\t`,
 * ... or octal, and `\\` / `\"` for backslash and quote. Treating every
 * escape as "the next character, literally" turned `K\x00e2z\x0131m` into
 * `Kx00e2zx0131m`: a home folder with any non-ASCII letter lost the redirect.
 */
const CONTROL_ESCAPES = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
export function unescapeRegString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== "\\" || i + 1 >= raw.length) {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    const hex = next === "x" ? /^[0-9a-fA-F]{1,4}/.exec(raw.slice(i + 2)) : null;
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
    if (hex) {
      out += String.fromCharCode(parseInt(hex[0], 16));
      i += 1 + hex[0].length;
    } else if (octal) {
      out += String.fromCharCode(parseInt(octal[0], 8));
      i += octal[0].length;
    } else {
      out += CONTROL_ESCAPES[next] ?? next;
      i += 1;
    }
  }
  return out;
}

function registeredLocalAppData(prefix) {
  let reg;
  try {
    reg = readFileSync(join(prefix, "user.reg"), "utf8");
  } catch {
    return null;
  }
  const wanted = ["user shell folders", "shell folders"];
  const found = {};
  let section = null;
  for (const line of reg.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      const name = line.slice(1, line.indexOf("]")).replace(/\\\\/g, "\\").toLowerCase();
      section = wanted.find((tail) => name.endsWith(`\\explorer\\${tail}`)) ?? null;
      continue;
    }
    if (section === null) continue;
    const match = /^"Local AppData"=(?:str\(\d+\):)?"((?:[^"\\]|\\.)*)"\s*$/i.exec(line);
    if (match) found[section] = unescapeRegString(match[1]);
  }
  // `User Shell Folders` usually holds `%USERPROFILE%\...`, which needs Wine to
  // expand; `Shell Folders` holds the same thing already expanded. The first
  // one that is a plain path wins -- a `%VAR%` in the override used to stop the
  // search instead of falling through to the resolved key.
  const windows = [found["user shell folders"], found["shell folders"]].find(
    (value) => value !== undefined && !value.includes("%"),
  );
  if (windows === undefined) return null;

  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(windows);
  if (drive === null) return null;
  const letter = drive[1].toLowerCase();
  const rest = drive[2].split(/[\\/]+/).filter(Boolean);

  let root;
  if (letter === "z") {
    root = "/";
  } else {
    try {
      root = readlinkSync(join(prefix, "dosdevices", `${letter}:`));
      if (!isAbsolute(root)) root = resolve(join(prefix, "dosdevices"), root);
    } catch {
      if (letter !== "c") return null;
      root = join(prefix, "drive_c");
    }
  }
  return join(root, ...rest);
}

/**
 * Plugin folders inside one Wine prefix.
 *
 * A folder counts when Studio has been run there -- `Local/Roblox` exists -- even
 * if `Plugins` does not yet, because a fresh install has no plugins folder until
 * the first plugin is dropped in. `Public` is skipped: it is Wine's shared
 * profile and Studio never writes there.
 */
function inPrefix(prefix, label) {
  const found = [];
  const redirected = registeredLocalAppData(prefix);
  // Held to the same test as the in-prefix folders below: Studio has run there.
  // A prefix made for some other program can point Local AppData anywhere, and
  // installing would create Roblox/Plugins in it.
  if (redirected !== null && existsSync(join(redirected, "Roblox"))) {
    found.push({ dir: join(redirected, "Roblox", "Plugins"), label: `${label}, Local AppData redirect` });
  }
  const users = join(prefix, "drive_c", "users");
  for (const user of children(users)) {
    if (user === "Public") continue;
    const roblox = join(users, user, "AppData", "Local", "Roblox");
    if (!existsSync(roblox)) continue;
    found.push({ dir: join(users, user, PLUGINS_UNDER_USER), label: `${label} (${user})` });
  }
  return found;
}

/** Every Vinegar prefix under one Vinegar data directory. */
function inVinegarData(dataDir, label) {
  const found = [];
  // `prefixes/<name>` on current Vinegar, `prefix` on the versions before it.
  const prefixesDir = join(dataDir, "prefixes");
  for (const name of children(prefixesDir)) {
    found.push(...inPrefix(join(prefixesDir, name), `${label} ${name} prefix`));
  }
  found.push(...inPrefix(join(dataDir, "prefix"), `${label} prefix`));
  return found;
}

/**
 * Every plugins folder Studio might be reading, best guess first.
 *
 * `STUDIO_MCP_PLUGINS_DIR` wins outright and may hold several folders separated
 * by the platform's path delimiter: somebody who set it means it, and a layout
 * this file has never heard of is exactly when they need to.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ dir: string, label: string }[]}
 */
export function pluginDirs(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const override = env.STUDIO_MCP_PLUGINS_DIR;
  if (override) {
    return override
      .split(delimiter)
      .filter((dir) => dir !== "")
      .map((dir) => ({ dir, label: "STUDIO_MCP_PLUGINS_DIR" }));
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [{ dir: join(local, "Roblox", "Plugins"), label: "Windows" }];
  }
  if (platform === "darwin") {
    return [{ dir: join(home, "Documents", "Roblox", "Plugins"), label: "macOS" }];
  }

  const found = [];
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  found.push(...inVinegarData(join(dataHome, "vinegar"), "Vinegar"));
  found.push(...inVinegarData(join(home, ".var", "app", "org.vinegarhq.Vinegar", "data", "vinegar"), "Vinegar (Flatpak)"));
  if (env.WINEPREFIX) found.push(...inPrefix(env.WINEPREFIX, "WINEPREFIX"));
  found.push(...inPrefix(join(home, ".wine"), "Wine default prefix"));

  // The same folder can be reached by two routes (a symlinked data directory is
  // common); listing it twice would install into it twice, and make `doctor`
  // report one install as two. Compared by where it really is, not by spelling.
  const seen = new Set();
  return found.filter(({ dir }) => {
    const real = canonical(dir);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/**
 * The real location of a folder that may not exist yet (`Plugins` often does
 * not): its nearest existing ancestor with symlinks resolved, plus the rest.
 */
function canonical(dir) {
  const rest = [];
  let at = resolve(dir);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(dir);
      rest.push(basename(at));
      at = parent;
    }
  }
}

/** What to say when there is nowhere to install, per platform. */
export function noPluginsDirMessage(platform = process.platform) {
  if (platform === "linux") {
    return (
      "Could not find a Wine prefix with Roblox Studio in it. Looked under " +
      "~/.local/share/vinegar, ~/.var/app/org.vinegarhq.Vinegar/data/vinegar, " +
      "$WINEPREFIX and ~/.wine.\n" +
      "Run Studio once so it creates its folders, or name the plugins folder yourself:\n" +
      "  STUDIO_MCP_PLUGINS_DIR=<prefix>/drive_c/users/<user>/AppData/Local/Roblox/Plugins " +
      "npx -y @el4cteo/rbx-studio-mcp --install-plugin"
    );
  }
  return (
    "Roblox Studio's plugins folder is unknown on this platform. Build with " +
    "`npm run build:plugin` and copy build/StudioMCP.rbxmx into it, or set " +
    "STUDIO_MCP_PLUGINS_DIR."
  );
}
