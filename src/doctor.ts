import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLIENT_HEADER, PROTOCOL_VERSION } from "./lib/protocol.js";
import type { StudioSession } from "./lib/protocol.js";
import { probeOwner } from "./bridge/remote.js";
import { expectedPluginBuildId } from "./lib/pluginbuild.js";

/**
 * Answers "why is this not working" without anyone having to guess.
 *
 * Every failure this checks for has been reported at least once, and every one
 * of them looked like something else at the time: a plugin that never loaded
 * reads as a bridge problem, a stale plugin reads as a broken tool, and a
 * second server holding the port reads as nothing at all. Each check therefore
 * ends in an instruction rather than a verdict -- "not connected" is where the
 * old confusion started, not where it ended.
 */

export type Status = "ok" | "warn" | "bad";

export interface Check {
  status: Status;
  title: string;
  detail: string;
}

const MARK: Record<Status, string> = { ok: "PASS", warn: "WARN", bad: "FAIL" };

interface PluginDir {
  dir: string;
  label: string;
}

/**
 * Every folder Studio might load plugins from.
 *
 * Read from `scripts/plugin-dirs.mjs`, the same module the installer writes
 * through, so the two cannot disagree about where a plugin lives -- which is
 * how a Linux machine ended up with the plugin freshly installed in one Wine
 * prefix and Studio running from another.
 */
async function pluginDirs(): Promise<PluginDir[]> {
  const module = (await import(pathToFileURL(join(root(), "scripts", "plugin-dirs.mjs")).href)) as {
    pluginDirs: () => PluginDir[];
  };
  return module.pluginDirs();
}

function root(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * What this package would install, so an installed copy can be compared to it.
 *
 * The plugin sources are hashed directly, the same way `studio_status` does.
 * `build/plugin-build-id.txt` is only what the LAST build stamped: after a
 * `git pull` that has not been followed by a rebuild it still holds the old id,
 * so preferring it made `doctor` say "up to date" for a checkout `studio_status`
 * correctly called stale. The stamp is the fallback for a package that ships
 * without plugin sources.
 */
function builtBuildId(): string | null {
  const fromSources = expectedPluginBuildId();
  if (fromSources !== "unknown") return fromSources;
  const stamp = join(root(), "build", "plugin-build-id.txt");
  if (!existsSync(stamp)) return null;
  return readFileSync(stamp, "utf8").trim();
}

/**
 * The build id stamped into an installed plugin, read from the file itself.
 *
 * The plugin carries it as a literal (`Config.BUILD_ID = "..."`), so a file on
 * disk can be judged stale without Studio running at all.
 */
function installedBuildId(file: string): string | null {
  try {
    return /Config\.BUILD_ID = "([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every installed copy, with the build id read off it (or null if it is
 * missing or unreadable). Split out of `checkPluginFiles` so a connected
 * Studio session's own `buildId` can be matched against these -- see
 * `matchInstalls` -- without re-reading every file a second time.
 */
interface InstalledCopy {
  dir: string;
  label: string;
  file: string;
  id: string | null;
}

async function installedCopies(): Promise<InstalledCopy[]> {
  const dirs = await pluginDirs();
  return dirs.map(({ dir, label }) => {
    const file = join(dir, "StudioMCP.rbxmx");
    return { dir, label, file, id: existsSync(file) ? installedBuildId(file) : null };
  });
}

function checkPluginFiles(copies: InstalledCopy[]): Check[] {
  if (copies.length === 0) {
    return [
      {
        status: "warn",
        title: "Studio plugin",
        detail:
          "No Roblox Studio plugins folder found on this machine.\n" +
          "  Run Studio once, or point at the folder with STUDIO_MCP_PLUGINS_DIR.",
      },
    ];
  }

  const expected = builtBuildId();
  return copies.map(({ dir, label, file, id }): Check => {
    const title = copies.length > 1 ? `Studio plugin [${label}]` : "Studio plugin";
    if (!existsSync(file)) {
      return {
        status: copies.length > 1 ? "warn" : "bad",
        title,
        detail: `Not installed. No file at ${file}.\n  Fix: npx -y @el4cteo/rbx-studio-mcp --install-plugin`,
      };
    }
    const age = statSync(file).mtime.toISOString().slice(0, 16).replace("T", " ");
    if (id === null) {
      return {
        status: "bad",
        title,
        detail:
          `${file} carries no build id, so it is truncated or not a StudioMCP build (file dated ${age}).\n` +
          "  Fix: npx -y @el4cteo/rbx-studio-mcp --install-plugin, then QUIT Studio and start it again.",
      };
    }
    if (expected !== null && id !== expected) {
      return {
        status: "bad",
        title,
        detail:
          `Stale: ${file} is build ${id}, this package is ${expected} (file dated ${age}).\n` +
          "  Fix: npx -y @el4cteo/rbx-studio-mcp --install-plugin, then QUIT Studio " +
          "completely and start it again. Focusing the window does not reload it.",
      };
    }
    return { status: "ok", title, detail: `Installed ${age} at ${file}` };
  });
}

/**
 * Which installed copy (or copies) a connected session's build id matches.
 *
 * A running Studio cannot say which folder it loaded its plugin from -- Luau
 * has no notion of its own file path -- so this is a match by build id, not
 * proof. On one prefix that is exact; on a machine with several prefixes
 * carrying the same (current) build, it narrows the field instead of naming
 * one, which is still more than "no Studio is connected" leaves you with.
 * This is the piece that used to be missing on a two-Vinegar-install machine:
 * a buildId mismatch on the session told you *that* something was stale, not
 * *which folder* to reinstall into.
 */
export function matchInstalls(buildId: string, copies: InstalledCopy[]): string {
  const matches = copies.filter((copy) => copy.id === buildId);
  if (matches.length === 0) {
    return copies.length === 0
      ? ""
      : "\n  Loaded plugin matches none of the installed copies on this machine " +
        "(all of them are a different build, or it was installed somewhere " +
        "STUDIO_MCP_PLUGINS_DIR/the default search does not look).";
  }
  if (matches.length === 1) {
    return `\n  Loaded from: ${matches[0]!.label} (${matches[0]!.dir})`;
  }
  return `\n  Loaded from one of: ${matches.map((copy) => copy.label).join(", ")} (same build id, cannot tell which)`;
}

/**
 * Whether something is on the port, and whether it is one of us.
 *
 * The distinction is the whole value of this check. Nothing listening and a
 * stranger listening produce the same symptom in Studio -- a console that will
 * not connect -- and opposite fixes.
 */
async function checkPort(port: number): Promise<Check> {
  const owner = await probeOwner(port);
  if (owner === null) {
    return {
      status: "warn",
      title: `Bridge on 127.0.0.1:${port}`,
      detail:
        "Nothing answering, or something that is not this server.\n" +
        "  That is normal if no agent is running: the server starts when your " +
        "MCP client launches it.\n" +
        "  If an agent IS running, something else holds the port. Start with " +
        "--port <other> and set the same port in the Studio panel.",
    };
  }
  const drift =
    owner.protocolVersion === PROTOCOL_VERSION
      ? ""
      : `\n  Protocol ${owner.protocolVersion} vs this build's ${PROTOCOL_VERSION}.`;
  return {
    status: "ok",
    title: `Bridge on 127.0.0.1:${port}`,
    detail: `Answering, owned by pid ${owner.pid}.${drift}`,
  };
}

/** Asks the running bridge which Studios it can see, and whether they are current. */
async function checkStudios(port: number, built: string | null, copies: InstalledCopy[]): Promise<Check[]> {
  let sessions: StudioSession[];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { [CLIENT_HEADER]: "doctor" },
      signal: AbortSignal.timeout(5_000),
    });
    sessions = ((await response.json()) as { list: StudioSession[] }).list;
  } catch {
    return [];
  }

  if (sessions.length === 0) {
    return [
      {
        status: "bad",
        title: "Studio sessions",
        detail:
          "The bridge is up but no Studio is connected.\n" +
          "  Open Studio. If it is already open, click the Studio MCP toolbar " +
          "button and check the console panel; use its reconnect button.\n" +
          "  If Studio asked for permission to reach 127.0.0.1, it must be allowed.",
      },
    ];
  }

  // Which folder(s) this actually is only matters when there is more than one
  // to choose between -- on a single-prefix machine, "the plugin" already
  // names it.
  const locate = copies.length > 1;

  return sessions.map((session) => {
    // A plugin built from different sources answers with older handlers and no
    // other symptom, which is the hardest failure here to recognise from inside.
    const stale = built !== null && session.buildId !== built;
    return {
      status: stale ? "warn" : "ok",
      title: `Studio: ${session.placeName}`,
      detail:
        (stale
          ? `Plugin build ${session.buildId} does not match this package's ${built}.\n` +
            "  Fix: npx -y @el4cteo/rbx-studio-mcp --install-plugin, then QUIT Studio and start it again."
          : `${session.context ?? "edit"}, over ${session.transport}, plugin ${session.pluginVersion}`) +
        (locate ? matchInstalls(session.buildId, copies) : ""),
    };
  });
}

function checkNode(): Check {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const enough = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 15);
  return {
    status: enough ? "ok" : "bad",
    title: "Node",
    detail: enough
      ? `v${process.versions.node}`
      : `v${process.versions.node} is below the required 22.15.`,
  };
}

/**
 * Confirms the Luau toolchain the plugin build needs, without failing over it.
 *
 * Presence is checked by looking, not by running: `luau --version` is not a
 * flag it accepts, so asking cost a line of error output and a warning that was
 * simply wrong. What this needs to know is whether the file is there.
 */
function checkLuau(): Check {
  const exe = process.platform === "win32" ? ".exe" : "";
  const missing = ["luau", "luau-analyze"].filter(
    (tool) => !existsSync(join(root(), "tools", tool + exe)),
  );
  if (missing.length === 0) {
    return { status: "ok", title: "Luau tools", detail: "Present, so the plugin can be rebuilt." };
  }
  return {
    status: "warn",
    title: "Luau tools",
    detail:
      `Missing from ./tools: ${missing.join(", ")}. Only needed to rebuild the ` +
      "plugin from source; installing the published build does not use them.",
  };
}

/**
 * The checks themselves, with no opinion about where they are printed.
 *
 * Split out of `runDoctor` because the console panel runs the same diagnosis
 * and cannot use stdout: the bridge's stdout is the MCP transport. Two copies
 * of this list would drift, and a `doctor` that disagrees with itself depending
 * on where you typed it is worse than no `doctor` at all.
 */
export async function collectChecks(port: number): Promise<Check[]> {
  const built = builtBuildId();
  const copies = await installedCopies();
  const checks: Check[] = [checkNode(), checkLuau(), ...checkPluginFiles(copies), await checkPort(port)];
  checks.push(...(await checkStudios(port, built, copies)));
  return checks;
}

export async function runDoctor(port: number): Promise<void> {
  const checks = await collectChecks(port);

  const lines = checks.map((check) => `[${MARK[check.status]}] ${check.title}\n  ${check.detail}`);
  const bad = checks.filter((check) => check.status === "bad").length;
  const warn = checks.filter((check) => check.status === "warn").length;

  // stdout, not stderr: this is the command's output, and unlike every other
  // path in this process there is no MCP transport here to keep it clear for.
  process.stdout.write(
    `${lines.join("\n\n")}\n\n${checks.length - bad - warn} passed, ${warn} warning(s), ${bad} failure(s)\n`,
  );
  process.exitCode = bad > 0 ? 1 : 0;
}
