import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBase,
  commitApprovedTree,
  inspectApprovedCommit,
  verifyTerminalGit,
  stageExactSnapshot,
} from "./execution.ts";
import {
  ensureManagedWorktree,
  git,
  managedWorktreeSnapshot,
  repositoryEvidence,
} from "./repository.ts";
import { runtimePaths } from "./runtime.ts";
import type { TaskIdentity } from "./state.ts";

for (
  const [key, value] of Object.entries({
    GIT_AUTHOR_NAME: "JURUC tests",
    GIT_AUTHOR_EMAIL: "juruc@example.invalid",
    GIT_COMMITTER_NAME: "JURUC tests",
    GIT_COMMITTER_EMAIL: "juruc@example.invalid",
  })
) process.env[key] = value;

async function must(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(root: string, slug: string): Promise<TaskIdentity> {
  const source = join(root, `${slug}-source`);
  mkdirSync(source);
  await must(source, ["init", "-b", "main"]);
  writeFileSync(join(source, "changed.txt"), "baseline\n");
  writeFileSync(join(source, "deleted.txt"), "delete me\n");
  writeFileSync(join(source, "other.txt"), "other\n");
  writeFileSync(join(source, ".gitignore"), "target/\nCargo.lock\n");
  await must(source, ["add", "."]);
  await must(source, ["commit", "-m", "Baseline"]);
  const evidence = (await repositoryEvidence(source))!;
  const agent = join(root, `${slug}-agent`);
  mkdirSync(agent);
  const paths = runtimePaths(agent);
  const identity: TaskIdentity = {
    version: 7,
    slug,
    branch: slug,
    worktree: join(paths.worktrees, slug),
    sourceRoot: source,
    baseBranch: evidence.branch,
    sourceHead: evidence.head,
    planningSession: null,
    buildSessions: [],
  };
  await ensureManagedWorktree(identity);
  return identity;
}

async function snapshot(identity: TaskIdentity) {
  const value = await managedWorktreeSnapshot(identity);
  assert.equal(value.kind, "present");
  if (value.kind !== "present") throw new Error("expected worktree snapshot");
  return value;
}

const root = mkdtempSync(join(tmpdir(), "juruc-execution-test-"));
try {
  const identity = await fixture(root, "success");
  const parent = identity.sourceHead;
  writeFileSync(join(identity.worktree, "changed.txt"), "changed\n");
  writeFileSync(join(identity.worktree, "untracked.txt"), "new\n");
  writeFileSync(join(identity.worktree, "Cargo.lock"), "ignored lock\n");
  mkdirSync(join(identity.worktree, "target"));
  writeFileSync(join(identity.worktree, "target", "artifact"), "ignored build output\n");
  unlinkSync(join(identity.worktree, "deleted.txt"));
  const approved = await snapshot(identity);
  assert.deepEqual(approved.paths, [
    "changed.txt",
    "deleted.txt",
    "untracked.txt",
  ]);
  const tree = await stageExactSnapshot(identity, approved);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(await inspectApprovedCommit(identity, parent, tree), {
    status: "awaiting-message",
  });
  await assert.rejects(
    commitApprovedTree(identity, parent, tree, "   "),
    /nonempty/,
  );
  await assert.rejects(
    commitApprovedTree(identity, parent, tree, "x".repeat(10_001)),
    /too long/,
  );
  const commonDirectory = await must(identity.worktree, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const hook = join(commonDirectory, "hooks", "post-commit");
  writeFileSync(hook, "#!/bin/sh\nprintf hook > hook-ran\n");
  chmodSync(hook, 0o755);
  const acceptedMessage = "Subject with  spaces\n\nBody line with trailing spaces  \n  indented final line";
  const child = await commitApprovedTree(
    identity,
    parent,
    tree,
    acceptedMessage,
  );
  assert.equal(
    existsSync(join(identity.worktree, "hook-ran")),
    false,
    "automatic commits disable all repository hooks",
  );
  assert.deepEqual(await inspectApprovedCommit(identity, parent, tree, acceptedMessage), {
    status: "committed",
    commit: child,
  });
  assert.deepEqual(await inspectApprovedCommit(identity, parent, tree, "Wrong wording"), {
    status: "blocked",
    reason: "committed message differs from approved message",
  });
  assert.equal(
    await must(identity.worktree, ["rev-parse", `${child}^{tree}`]),
    tree,
  );
  assert.deepEqual(
    await verifyTerminalGit(identity, {
      sourceHead: parent,
      finalHead: child,
      finalTree: tree,
      phaseCommits: [child],
      baseBranch: "main",
      baseHead: parent,
    }),
    { finalHead: child, finalTree: tree, finalParent: parent, orderedCommits: [child], base: "current" },
    "terminal acceptance verifies the exact direct chain and clean repository",
  );
  writeFileSync(join(identity.sourceRoot, "base-moved.txt"), "base moved\n");
  await must(identity.sourceRoot, ["add", "base-moved.txt"]);
  await must(identity.sourceRoot, ["commit", "-m", "Move base"]);
  assert.equal(await classifyBase(identity, parent), "moved", "base movement is classified through ancestor semantics");
  await must(identity.sourceRoot, ["update-ref", "-d", "refs/heads/main"]);
  assert.equal(await classifyBase(identity, parent), "deleted-or-rewritten", "deleted base refs are not treated as current");
  const treeObject = await must(identity.sourceRoot, ["rev-parse", `${parent}^{tree}`]);
  const rewritten = await must(identity.sourceRoot, ["commit-tree", treeObject, "-m", "Rewritten base"]);
  await must(identity.sourceRoot, ["update-ref", "refs/heads/main", rewritten]);
  assert.equal(await classifyBase(identity, parent), "deleted-or-rewritten", "diverged base refs are classified as rewritten");

  const changed = await fixture(root, "changed-snapshot");
  writeFileSync(join(changed.worktree, "changed.txt"), "one\n");
  const stale = await snapshot(changed);
  writeFileSync(join(changed.worktree, "changed.txt"), "two\n");
  await assert.rejects(stageExactSnapshot(changed, stale), /snapshot changed/);
  await assert.rejects(
    stageExactSnapshot(changed, { ...stale, paths: [] }),
    /empty/,
  );

  const extra = await fixture(root, "extra-index");
  writeFileSync(join(extra.worktree, "changed.txt"), "approved\n");
  const exact = await snapshot(extra);
  writeFileSync(join(extra.worktree, "other.txt"), "extra\n");
  await must(extra.worktree, ["add", "other.txt"]);
  await assert.rejects(stageExactSnapshot(extra, exact), /snapshot changed/);

  const embedded = await fixture(root, "embedded-repository");
  const nested = join(embedded.worktree, "study");
  mkdirSync(nested);
  await must(nested, ["init", "-b", "main"]);
  writeFileSync(join(nested, "reference.txt"), "reference\n");
  await must(nested, ["add", "reference.txt"]);
  await must(nested, ["commit", "-m", "Reference"]);
  const embeddedSnapshot = await snapshot(embedded);
  await assert.rejects(
    stageExactSnapshot(embedded, embeddedSnapshot),
    /unregistered nested Git repositories cannot be committed: study/,
  );
  assert.equal(await must(embedded.worktree, ["diff", "--cached", "--name-only"]), "");

  const moduleSource = join(root, "registered-module-source");
  mkdirSync(moduleSource);
  await must(moduleSource, ["init", "-b", "main"]);
  writeFileSync(join(moduleSource, "module.txt"), "module\n");
  await must(moduleSource, ["add", "module.txt"]);
  await must(moduleSource, ["commit", "-m", "Module"]);
  const registered = await fixture(root, "registered-submodule");
  await must(registered.worktree, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    moduleSource,
    "module",
  ]);
  const registeredSnapshot = await snapshot(registered);
  assert.match(await stageExactSnapshot(registered, registeredSnapshot), /^[0-9a-f]{40,64}$/);

  const dirty = await fixture(root, "dirty-residue");
  writeFileSync(join(dirty.worktree, "changed.txt"), "approved\n");
  const dirtySnapshot = await snapshot(dirty);
  const dirtyTree = await stageExactSnapshot(dirty, dirtySnapshot);
  writeFileSync(join(dirty.worktree, "changed.txt"), "later\n");
  assert.equal(
    (await inspectApprovedCommit(dirty, dirty.sourceHead, dirtyTree)).status,
    "blocked",
  );

  assert.equal(
    (await inspectApprovedCommit(identity, parent, parent)).status,
    "blocked",
    "wrong approved tree is blocked",
  );
  assert.equal(
    (await inspectApprovedCommit(identity, "0".repeat(parent.length), tree))
      .status,
    "blocked",
    "wrong parent is blocked",
  );

  const wrongMessage = await fixture(root, "wrong-message-child");
  writeFileSync(join(wrongMessage.worktree, "changed.txt"), "approved tree\n");
  const wrongMessageSnapshot = await snapshot(wrongMessage);
  const wrongMessageTree = await stageExactSnapshot(wrongMessage, wrongMessageSnapshot);
  await must(wrongMessage.worktree, ["commit", "--cleanup=verbatim", "-m", "External wrong message"]);
  assert.deepEqual(
    await inspectApprovedCommit(
      wrongMessage,
      wrongMessage.sourceHead,
      wrongMessageTree,
      "Persisted canonical message",
    ),
    { status: "blocked", reason: "committed message differs from approved message" },
    "an exact direct child with the audited tree cannot be adopted under different wording",
  );

  const wrongChild = await fixture(root, "wrong-child");
  await must(wrongChild.worktree, ["commit", "--allow-empty", "-m", "First"]);
  await must(wrongChild.worktree, ["commit", "--allow-empty", "-m", "Second"]);
  const baseTree = await must(wrongChild.worktree, [
    "rev-parse",
    `${wrongChild.sourceHead}^{tree}`,
  ]);
  assert.equal(
    (await inspectApprovedCommit(wrongChild, wrongChild.sourceHead, baseTree))
      .status,
    "blocked",
  );

  const merge = await fixture(root, "merge-child");
  await must(merge.worktree, ["checkout", "-b", "side"]);
  writeFileSync(join(merge.worktree, "side.txt"), "side\n");
  await must(merge.worktree, ["add", "side.txt"]);
  await must(merge.worktree, ["commit", "-m", "Side"]);
  await must(merge.worktree, ["checkout", merge.branch]);
  await must(merge.worktree, ["commit", "--allow-empty", "-m", "Main"]);
  await must(merge.worktree, ["merge", "--no-ff", "side", "-m", "Merge"]);
  const mergeTree = await must(merge.worktree, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(
    (await inspectApprovedCommit(merge, merge.sourceHead, mergeTree)).status,
    "blocked",
  );

  console.log("juruc deterministic Git execution: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
