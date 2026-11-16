// Release-tag auto-update for an install that is a git checkout of armorCopilot (what
// install_armorcopilot.sh creates and Copilot loads in place). A newer release is staged in a
// sibling directory by a detached worker and swapped onto the install path by rename at the
// next session start, so the running install is never written while it is being staged.
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const OPT_OUT_ENV = "ARMORCOPILOT_NO_AUTO_UPDATE";
// The installer reads the same variables, so a mirror or an enterprise host is named once.
export const REPO_URL_ENV = "ARMORCOPILOT_GIT_URL";
export const API_BASE_ENV = "ARMORCOPILOT_GITHUB_API";
export const REPO = "armoriq/armorCopilot";
export const DEFAULT_REPO_URL = "https://github.com/armoriq/armorCopilot.git";
export const DEFAULT_API_BASE = "https://api.github.com";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// bootstrap.mjs trusts node_modules only when this marker matches the package version.
export const DEPS_MARKER = ".armorcopilot-installed";
export const REQUIRED_DEPS = ["@armoriq/sdk", "zod", "@modelcontextprotocol/sdk"];

const PLUGIN_SUBDIR = path.join("plugins", "armorcopilot");
const CHECK_TIMEOUT_MS = 5_000;
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;
const STALE_STAGING_MS = 6 * 60 * 60 * 1000;
const WORKER = fileURLToPath(new URL("../update-worker.mjs", import.meta.url));

const execFileAsync = promisify(execFile);

/**
 * Null unless pluginRoot sits at plugins/armorcopilot inside a git checkout of the marketplace
 * repo. A copy Copilot made of the plugin directory alone is not ours to replace.
 */
export function resolveLayout(pluginRoot) {
  try {
    const plugin = path.resolve(pluginRoot);
    if (path.basename(plugin) !== "armorcopilot" || path.basename(path.dirname(plugin)) !== "plugins") return null;
    const root = path.dirname(path.dirname(plugin));
    if (!existsSync(path.join(root, ".git"))) return null;
    if (!existsSync(path.join(root, ".claude-plugin", "marketplace.json"))) return null;
    return {
      root,
      parent: path.dirname(root),
      base: path.basename(root),
      staged: `${root}.staged`,
      previous: `${root}.previous`,
      marker: `${root}.staged.json`,
      state: `${root}.update-check.json`
    };
  } catch {
    return null;
  }
}

function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? "" };
}

// Null means one side is not a semver, which is a failed comparison rather than "not newer".
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i] - right.core[i];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export function treeVersion(root) {
  try {
    const { version } = JSON.parse(readFileSync(path.join(root, PLUGIN_SUBDIR, "package.json"), "utf8"));
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

function depsInstalled(root, version) {
  const modules = path.join(root, PLUGIN_SUBDIR, "node_modules");
  try {
    if (readFileSync(path.join(modules, DEPS_MARKER), "utf8").trim() !== version) return false;
  } catch {
    return false;
  }
  return REQUIRED_DEPS.every((dep) => existsSync(path.join(modules, dep, "package.json")));
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export function verifyStaged(layout) {
  if (!existsSync(layout.staged)) return { ok: false, reason: "nothing is staged" };
  const { version, tag } = readJson(layout.marker);
  if (typeof version !== "string" || typeof tag !== "string")
    return { ok: false, reason: "the staged tree has no completion marker" };
  const onDisk = treeVersion(layout.staged);
  if (onDisk !== version) return { ok: false, reason: `the staged tree reports ${onDisk ?? "no version"}, its marker says ${version}` };
  if (!existsSync(path.join(layout.staged, PLUGIN_SUBDIR, "scripts", "bootstrap.mjs")))
    return { ok: false, reason: "the staged tree has no scripts/bootstrap.mjs" };
  if (!depsInstalled(layout.staged, version)) return { ok: false, reason: "the staged tree is missing its dependencies" };
  return { ok: true, version, tag };
}

// Both the installer and bootstrap.mjs run npm install in the checkout, which rewrites the
// lockfile on installs made before its name was corrected. That is npm's edit, not the user's.
const NPM_OWNED = new Set([`${PLUGIN_SUBDIR}/package-lock.json`]);

// Null separates "git could not answer" from "the tree is clean".
function localChanges(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !(line.startsWith(" M ") && NPM_OWNED.has(line.slice(3))))
    .join("\n");
}

/** Synchronous and rename-only once it commits, so the install path is absent for at most one rename. */
export function applyStagedUpdate({ pluginRoot, env = process.env }) {
  try {
    if (env[OPT_OUT_ENV] === "1") return { kind: "skipped", reason: "opted_out" };
    const layout = resolveLayout(pluginRoot);
    if (!layout) return { kind: "skipped", reason: "not_a_checkout" };
    if (!existsSync(layout.staged)) return { kind: "skipped", reason: "nothing_staged" };
    const staged = verifyStaged(layout);
    if (!staged.ok) return { kind: "refused", reason: staged.reason };
    const installed = treeVersion(layout.root);
    if (installed === null) return { kind: "refused", reason: "the installed checkout has no readable version" };
    const ahead = compareVersions(staged.version, installed);
    if (ahead === null || ahead <= 0)
      return { kind: "refused", reason: `staged ${staged.version} is not newer than the installed ${installed}` };
    const changes = localChanges(layout.root);
    if (changes === null) return { kind: "refused", reason: "the installed checkout is not a readable git checkout" };
    if (changes !== "") return { kind: "refused", reason: "the installed checkout has local modifications" };

    if (existsSync(layout.previous))
      renameSync(layout.previous, path.join(layout.parent, `${layout.base}.discard.${randomUUID().slice(0, 8)}`));
    renameSync(layout.root, layout.previous);
    try {
      renameSync(layout.staged, layout.root);
    } catch (error) {
      renameSync(layout.previous, layout.root);
      throw error;
    }
    rmSync(layout.marker, { force: true });
    return { kind: "swapped", from: installed, to: staged.version };
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}

// A timestamp in the future comes from a clock change, and would otherwise suppress every check.
export function checkDue(layout, now = Date.now(), intervalMs = CHECK_INTERVAL_MS) {
  const last = readJson(layout.state).lastCheckedAt;
  return !(typeof last === "number" && last <= now && now - last < intervalMs);
}

async function latestTag(env) {
  const base = env[API_BASE_ENV]?.trim() || DEFAULT_API_BASE;
  const response = await fetch(`${base}/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "armorcopilot-updater" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`releases/latest returned ${response.status}`);
  const tag = (await response.json())?.tag_name;
  if (typeof tag !== "string" || tag === "") throw new Error("releases/latest has no tag_name");
  return tag;
}

async function run(cmd, args, options) {
  const { stdout } = await execFileAsync(cmd, args, { ...options, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Builds the release in a sibling directory; the install path is only read. */
export async function stageRelease({ layout, tag, env = process.env }) {
  const installed = treeVersion(layout.root);
  if (installed === null) return { kind: "skipped", reason: "no_install" };
  const ahead = compareVersions(tag, installed);
  if (ahead === null || ahead <= 0) return { kind: "skipped", reason: "not_newer" };
  const existing = verifyStaged(layout);
  if (existing.ok && compareVersions(existing.version, tag) === 0) return { kind: "skipped", reason: "already_staged" };

  const tmp = path.join(layout.parent, `${layout.base}.staging.${process.pid}.${randomUUID().slice(0, 8)}`);
  try {
    const url = env[REPO_URL_ENV]?.trim() || DEFAULT_REPO_URL;
    await run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, url, tmp], { env, timeout: CLONE_TIMEOUT_MS });
    const tags = (await run("git", ["-C", tmp, "tag", "--points-at", "HEAD"], { env, timeout: 30_000 })).split("\n");
    if (!tags.includes(tag)) throw new Error(`the clone is not at ${tag}`);
    const version = treeVersion(tmp);
    if (version === null) throw new Error("the release has no package version");
    if (compareVersions(version, tag) !== 0) throw new Error(`release ${tag} reports version ${version}`);

    const pluginDir = path.join(tmp, PLUGIN_SUBDIR);
    await run("npm", ["install", "--omit=dev", "--silent", "--no-audit", "--no-fund"], { cwd: pluginDir, env, timeout: INSTALL_TIMEOUT_MS });
    writeFileSync(path.join(pluginDir, "node_modules", DEPS_MARKER), version, "utf8");
    if (!depsInstalled(tmp, version)) throw new Error("dependencies are missing after npm install");

    rmSync(layout.marker, { force: true });
    rmSync(layout.staged, { recursive: true, force: true });
    renameSync(tmp, layout.staged);
    // Written last, so a tree an interrupted staging left behind is never eligible for the swap.
    writeJson(layout.marker, { version, tag, stagedAt: Date.now() });
    return { kind: "staged", version, tag };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    return { kind: "failed", reason: String(error) };
  }
}

function prune(layout, now) {
  let entries;
  try {
    entries = readdirSync(layout.parent);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(layout.parent, name);
    try {
      if (name.startsWith(`${layout.base}.discard.`)) rmSync(full, { recursive: true, force: true });
      else if (name.startsWith(`${layout.base}.staging.`) && now - statSync(full).mtimeMs >= STALE_STAGING_MS)
        rmSync(full, { recursive: true, force: true });
    } catch {}
  }
}

/** The detached worker's whole job: check once, stage if newer. Never throws. */
export async function runUpdate({ pluginRoot, env = process.env, now = Date.now() }) {
  try {
    if (env[OPT_OUT_ENV] === "1") return { kind: "skipped", reason: "opted_out" };
    const layout = resolveLayout(pluginRoot);
    if (!layout) return { kind: "skipped", reason: "not_a_checkout" };
    prune(layout, now);
    let tag;
    try {
      tag = await latestTag(env);
    } finally {
      // Recorded on a failure too, so an offline machine does not retry every session.
      try {
        writeJson(layout.state, { ...readJson(layout.state), lastCheckedAt: now, latest: tag ?? null });
      } catch {}
    }
    const installed = treeVersion(layout.root);
    const order = installed === null ? null : compareVersions(tag, installed);
    if (order === null || order <= 0) return { kind: "skipped", reason: "no_update" };
    return await stageRelease({ layout, tag, env });
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}

/**
 * Called at session start: swaps in a staged release, then launches a detached check if one is
 * due. Never throws and never writes stdout, which carries the hook's JSON.
 */
export function startUpdate({ pluginRoot, env = process.env, now = Date.now() }) {
  const swap = applyStagedUpdate({ pluginRoot, env });
  let spawned = false;
  try {
    const layout = env[OPT_OUT_ENV] === "1" ? null : resolveLayout(pluginRoot);
    if (layout && checkDue(layout, now)) {
      mkdirSync(layout.parent, { recursive: true });
      // Claimed before the spawn so sessions starting together launch one worker, not several.
      writeJson(layout.state, { ...readJson(layout.state), lastCheckedAt: now });
      const child = spawn(process.execPath, [WORKER, layout.root], { detached: true, stdio: "ignore", env });
      child.on("error", () => {});
      child.unref();
      spawned = true;
    }
  } catch {}
  return { swap, spawned };
}

export function swapNotice(swap) {
  return swap?.kind === "swapped" ? `ArmorCopilot updated from ${swap.from} to ${swap.to}.` : null;
}
