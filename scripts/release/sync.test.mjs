import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultVerify, syncBranches } from "./sync.mjs";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec("git", args, { cwd });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-sync-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["clone", remote, seed]);
  await git(seed, "config", "user.name", "Test");
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "switch", "-c", "main");
  await writeFile(join(seed, "shared.txt"), "base\n");
  await git(seed, "add", "shared.txt");
  await git(seed, "commit", "-m", "base");
  await git(seed, "push", "origin", "main");
  await git(seed, "switch", "-c", "develop");
  await git(seed, "push", "origin", "develop");
  return { root, remote, seed };
}

test("fast-forwards develop to verified main", async () => {
  const { seed } = await fixture();
  await git(seed, "switch", "main");
  await writeFile(join(seed, "main.txt"), "released\n");
  await git(seed, "add", "main.txt");
  await git(seed, "commit", "-m", "release");
  await git(seed, "push", "origin", "main");
  let verified = false;
  const result = await syncBranches({
    cwd: seed,
    verify: async () => { verified = true; },
  });
  assert.equal(result.mode, "fast-forward");
  assert.equal(verified, true);
  const main = (await git(seed, "rev-parse", "origin/main")).stdout.trim();
  const develop = (await git(seed, "rev-parse", "origin/develop")).stdout.trim();
  assert.equal(develop, main);
});

test("creates a verified merge when both branches advanced", async () => {
  const { seed } = await fixture();
  await git(seed, "switch", "main");
  await writeFile(join(seed, "main.txt"), "released\n");
  await git(seed, "add", "main.txt");
  await git(seed, "commit", "-m", "release");
  await git(seed, "push", "origin", "main");
  await git(seed, "switch", "develop");
  await writeFile(join(seed, "develop.txt"), "next\n");
  await git(seed, "add", "develop.txt");
  await git(seed, "commit", "-m", "next");
  await git(seed, "push", "origin", "develop");
  const result = await syncBranches({ cwd: seed, verify: async () => {} });
  assert.equal(result.mode, "merge");
  const parents = (await git(seed, "show", "-s", "--format=%P", result.sha)).stdout.trim().split(" ");
  assert.equal(parents.length, 2);
});

test("leaves remote develop unchanged when a merge conflicts", async () => {
  const { seed } = await fixture();
  await git(seed, "switch", "main");
  await writeFile(join(seed, "shared.txt"), "main\n");
  await git(seed, "commit", "-am", "main edit");
  await git(seed, "push", "origin", "main");
  await git(seed, "switch", "develop");
  await writeFile(join(seed, "shared.txt"), "develop\n");
  await git(seed, "commit", "-am", "develop edit");
  await git(seed, "push", "origin", "develop");
  const before = (await git(seed, "rev-parse", "origin/develop")).stdout.trim();
  let verified = false;
  await assert.rejects(
    syncBranches({ cwd: seed, verify: async () => { verified = true; } }),
    /conflict/,
  );
  await git(seed, "fetch", "origin", "develop");
  const after = (await git(seed, "rev-parse", "origin/develop")).stdout.trim();
  assert.equal(after, before);
  assert.equal(verified, false);
});

test("refuses to synchronize when tracked files are modified", async () => {
  // The publish job installs wrangler on demand during the site deploy, which rewrites package.json
  // in the workspace this runs in. A bare git abort was hard to diagnose, so name the paths.
  const { seed } = await fixture();
  await git(seed, "switch", "main");
  await writeFile(join(seed, "shared.txt"), "main\n");
  await git(seed, "commit", "-am", "main edit");
  await git(seed, "push", "origin", "main");
  await git(seed, "switch", "--detach", "origin/main");
  await writeFile(join(seed, "shared.txt"), "dirtied by a previous step\n");
  await assert.rejects(
    syncBranches({ cwd: seed, verify: async () => {} }),
    /dirty working tree[\s\S]*shared\.txt/,
  );
});

test("untracked files do not block synchronization", async () => {
  const { seed } = await fixture();
  await git(seed, "switch", "main");
  await writeFile(join(seed, "shared.txt"), "main\n");
  await git(seed, "commit", "-am", "main edit");
  await git(seed, "push", "origin", "main");
  await git(seed, "switch", "--detach", "origin/main");
  await writeFile(join(seed, "notes.md"), "left behind by publication\n");
  const result = await syncBranches({ cwd: seed, verify: async () => {} });
  assert.equal(result.mode, "fast-forward");
});

test("defaultVerify installs Playwright Chromium before pnpm verify", async () => {
  const commands = [];
  await defaultVerify("/repo", async (cwd, args) => {
    commands.push([cwd, ...args]);
  });
  assert.deepEqual(commands, [
    ["/repo", "install", "--frozen-lockfile"],
    ["/repo", "--filter", "@lurkloot/extension", "exec", "playwright", "install", "chromium"],
    ["/repo", "verify"],
  ]);
});

test("defaultVerify includes command stdout when verification fails", async () => {
  const failure = Object.assign(new Error("Command failed: pnpm verify"), {
    stdout: "browserType.launch: Executable doesn't exist at /ms-playwright/chromium\n",
    stderr: "$ pnpm -r --if-present test\n",
  });
  await assert.rejects(
    () => defaultVerify("/repo", async () => {
      throw failure;
    }),
    /Executable doesn't exist[\s\S]*pnpm -r --if-present test/,
  );
});

test("the sync job installs Playwright Chromium before synchronizing develop", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(
    yaml,
    /playwright install chromium\s+node scripts\/release\/cli\.mjs sync-branches/,
  );
});

test("recovery dispatch is not gated on the workflow ref being main", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.doesNotMatch(yaml, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(
    yaml,
    /github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| 'main'/,
  );
});

test("recovery skips promotion when the GitHub release is already stable", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(yaml, /gh release view "v\$VERSION" --json isPrerelease/);
  assert.match(yaml, /already the stable release/);
});

test("recovery leaves an already published immutable image tag in place", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(yaml, /already published; aliasing the published digest/);
});

test("candidate lookup does not persist the GitHub token in Docker credentials", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const resolveJob = yaml.slice(yaml.indexOf("  resolve:"), yaml.indexOf("\n  docker:"));
  assert.doesNotMatch(resolveJob, /docker\/login-action/);
  assert.match(resolveJob, /https:\/\/ghcr\.io\/token/);
  assert.match(resolveJob, /Docker-Content-Digest/i);
});
