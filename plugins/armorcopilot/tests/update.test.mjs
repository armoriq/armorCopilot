import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  API_BASE_ENV,
  applyStagedUpdate,
  checkDue,
  compareVersions,
  OPT_OUT_ENV,
  REPO_URL_ENV,
  resolveLayout,
  runUpdate,
  startUpdate,
  treeVersion,
  verifyStaged
} from "../scripts/lib/update.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });

function writeTree(dir, version) {
  const plugin = path.join(dir, "plugins", "armorcopilot");
  mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "armorcopilot", version }));
  writeFileSync(path.join(plugin, "scripts", "bootstrap.mjs"), "");
  writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "{}");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
}

let work;
let tmp;
let remote;
let server;
let latest;
let env;

// Stands in for npm so the tests do not reach the registry; the live proof uses the real one.
function fakeNpm(dir) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "npm");
  writeFileSync(
    script,
    `#!/bin/sh\n[ -n "$FAKE_NPM_FAIL" ] && exit 1\nfor d in @armoriq/sdk zod @modelcontextprotocol/sdk; do mkdir -p "node_modules/$d" && echo '{}' > "node_modules/$d/package.json"; done\n`
  );
  chmodSync(script, 0o755);
  return bin;
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "armorcopilot-update-"));
  work = path.join(tmp, "work");
  remote = path.join(tmp, "remote.git");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "tag.gpgsign", "false");
  for (const version of ["0.1.0", "0.1.1"]) {
    writeTree(work, version);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", version);
    git(work, "tag", `v${version}`);
  }
  git(work, "tag", "v0.1.2");
  execFileSync("git", ["clone", "-q", "--bare", work, remote]);

  server = createServer((req, res) => {
    if (latest === "500") {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tag_name: latest }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  env = {
    ...process.env,
    PATH: `${fakeNpm(tmp)}:${process.env.PATH}`,
    [API_BASE_ENV]: `http://127.0.0.1:${server.address().port}`,
    [REPO_URL_ENV]: remote
  };
  delete env[OPT_OUT_ENV];
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

let home;
let pluginRoot;
let layout;

beforeEach(() => {
  home = mkdtempSync(path.join(tmp, "home-"));
  const root = path.join(home, "armorCopilot");
  execFileSync("git", ["clone", "-q", "--branch", "v0.1.0", remote, root], { stdio: "pipe" });
  pluginRoot = path.join(root, "plugins", "armorcopilot");
  layout = resolveLayout(pluginRoot);
  latest = "v0.1.1";
});

describe("compareVersions", () => {
  test("orders by core then prerelease, and rejects non-semver", () => {
    assert.equal(compareVersions("v0.1.1", "0.1.0"), 1);
    assert.equal(compareVersions("0.1.0", "v0.1.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("latest", "0.1.0"), null);
  });
});

describe("resolveLayout", () => {
  test("accepts the installer's checkout and refuses a bare plugin copy", () => {
    assert.equal(layout.root, path.join(home, "armorCopilot"));
    const copy = path.join(home, "copy", "armorcopilot");
    mkdirSync(copy, { recursive: true });
    assert.equal(resolveLayout(copy), null);
    assert.deepEqual(applyStagedUpdate({ pluginRoot: copy, env }), { kind: "skipped", reason: "not_a_checkout" });
  });
});

describe("stage then swap", () => {
  test("stages the newer tag beside the install and swaps it in", async () => {
    const staged = await runUpdate({ pluginRoot, env });
    assert.deepEqual(staged, { kind: "staged", version: "0.1.1", tag: "v0.1.1" });
    assert.equal(treeVersion(layout.root), "0.1.0", "staging must not touch the install");
    assert.equal(verifyStaged(layout).ok, true);

    const swap = applyStagedUpdate({ pluginRoot, env });
    assert.deepEqual(swap, { kind: "swapped", from: "0.1.0", to: "0.1.1" });
    assert.equal(treeVersion(layout.root), "0.1.1");
    assert.equal(treeVersion(layout.previous), "0.1.0");
    assert.equal(existsSync(layout.staged), false);
    assert.equal(existsSync(layout.marker), false);
    const marker = readFileSync(path.join(pluginRoot, "node_modules", ".armorcopilot-installed"), "utf8");
    assert.equal(marker, "0.1.1", "bootstrap must trust the staged node_modules without reinstalling");
  });

  test("does nothing when the latest release is not newer", async () => {
    latest = "v0.1.0";
    assert.deepEqual(await runUpdate({ pluginRoot, env }), { kind: "skipped", reason: "no_update" });
    assert.equal(existsSync(layout.staged), false);
  });

  test("refuses a release whose tag and package version disagree", async () => {
    latest = "v0.1.2";
    const outcome = await runUpdate({ pluginRoot, env });
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.reason, /reports version 0\.1\.1/);
    assert.equal(existsSync(layout.staged), false);
  });

  test("leaves nothing staged when the dependency install fails", async () => {
    const outcome = await runUpdate({ pluginRoot, env: { ...env, FAKE_NPM_FAIL: "1" } });
    assert.equal(outcome.kind, "failed");
    assert.equal(existsSync(layout.staged), false);
    assert.deepEqual(applyStagedUpdate({ pluginRoot, env }), { kind: "skipped", reason: "nothing_staged" });
  });
});

describe("swap refusals", () => {
  test("refuses a checkout with local modifications", async () => {
    await runUpdate({ pluginRoot, env });
    writeFileSync(path.join(pluginRoot, "scripts", "bootstrap.mjs"), "// edited\n");
    const swap = applyStagedUpdate({ pluginRoot, env });
    assert.equal(swap.kind, "refused");
    assert.match(swap.reason, /local modifications/);
    assert.equal(treeVersion(layout.root), "0.1.0");
  });

  test("swaps when npm rewrote only the tracked lockfile", async () => {
    const lock = path.join(pluginRoot, "package-lock.json");
    writeFileSync(lock, "{}\n");
    git(layout.root, "add", lock);
    git(layout.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "lock");
    await runUpdate({ pluginRoot, env });
    writeFileSync(lock, '{"rewritten":true}\n');
    assert.equal(applyStagedUpdate({ pluginRoot, env }).kind, "swapped");
  });

  test("refuses a staged tree without its completion marker", async () => {
    await runUpdate({ pluginRoot, env });
    rmSync(layout.marker);
    const swap = applyStagedUpdate({ pluginRoot, env });
    assert.deepEqual(swap, { kind: "refused", reason: "the staged tree has no completion marker" });
  });

  test("refuses a staged release that is not newer than the install", async () => {
    await runUpdate({ pluginRoot, env });
    writeTree(layout.root, "0.2.0");
    git(layout.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "0.2.0");
    const swap = applyStagedUpdate({ pluginRoot, env });
    assert.equal(swap.kind, "refused");
    assert.match(swap.reason, /not newer than the installed 0\.2\.0/);
    assert.equal(treeVersion(layout.root), "0.2.0");
  });
});

describe("opt-out and failures", () => {
  test("the opt-out disables both the check and the swap", async () => {
    const off = { ...env, [OPT_OUT_ENV]: "1" };
    assert.deepEqual(await runUpdate({ pluginRoot, env: off }), { kind: "skipped", reason: "opted_out" });
    await runUpdate({ pluginRoot, env });
    assert.deepEqual(applyStagedUpdate({ pluginRoot, env: off }), { kind: "skipped", reason: "opted_out" });
    assert.deepEqual(startUpdate({ pluginRoot, env: off }), { swap: { kind: "skipped", reason: "opted_out" }, spawned: false });
    assert.equal(treeVersion(layout.root), "0.1.0");
  });

  test("an API failure returns instead of throwing and still records the check", async () => {
    latest = "500";
    const outcome = await runUpdate({ pluginRoot, env });
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.reason, /returned 500/);
    assert.equal(checkDue(layout), false);
  });

  test("an unreachable API returns instead of throwing", async () => {
    const outcome = await runUpdate({ pluginRoot, env: { ...env, [API_BASE_ENV]: "http://127.0.0.1:9" } });
    assert.equal(outcome.kind, "failed");
  });

  test("startUpdate launches one detached check per interval", () => {
    const quiet = { ...env, [API_BASE_ENV]: "http://127.0.0.1:9" };
    assert.equal(startUpdate({ pluginRoot, env: quiet }).spawned, true);
    assert.equal(startUpdate({ pluginRoot, env: quiet }).spawned, false);
    assert.equal(checkDue(layout, Date.now() + 25 * 60 * 60 * 1000), true);
  });
});
