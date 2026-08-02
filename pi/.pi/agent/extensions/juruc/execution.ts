import type { WorktreeSnapshot } from "./plan.ts";
import {
  git,
  managedWorktreeSnapshot,
  validateManagedWorktree,
} from "./repository.ts";
import type { TaskIdentity } from "./state.ts";

const GIT_WRITE_MS = 120_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_COMMIT_MESSAGE_LENGTH = 10_000;

export type ApprovedCommitStatus =
  | { status: "awaiting-message" }
  | { status: "committed"; commit: string }
  | { status: "blocked"; reason: string };

export interface TerminalGitExpectation {
  sourceHead: string;
  finalHead: string;
  finalTree: string;
  phaseCommits: readonly (string | null)[];
  baseBranch: string;
  baseHead: string;
}

export type BaseReadiness = "current" | "moved" | "deleted-or-rewritten";

export async function classifyBase(identity: TaskIdentity, verifiedBase: string): Promise<BaseReadiness> {
  const result = await git(identity.sourceRoot, ["rev-parse", "--verify", `refs/heads/${identity.baseBranch}^{commit}`]);
  if (result.code !== 0) return "deleted-or-rewritten";
  const actual = result.stdout.trim();
  if (actual === verifiedBase) return "current";
  const ancestry = await git(identity.sourceRoot, ["merge-base", "--is-ancestor", verifiedBase, actual]);
  return ancestry.code === 0 ? "moved" : "deleted-or-rewritten";
}

export interface TerminalGitVerification {
  finalHead: string;
  finalTree: string;
  finalParent: string | null;
  orderedCommits: string[];
  base: BaseReadiness;
}

export async function verifyTerminalGit(identity: TaskIdentity, expected: TerminalGitExpectation): Promise<TerminalGitVerification> {
  for (const [label, value] of [["source", expected.sourceHead], ["final", expected.finalHead], ["tree", expected.finalTree], ["base", expected.baseHead]] as const) requireObjectId(value, label);
  const repository = await validateManagedWorktree(identity, false);
  if (repository.branch !== identity.branch) throw new Error("managed worktree branch differs from the task branch");
  const snapshot = await managedWorktreeSnapshot(identity, false);
  if (snapshot.kind !== "present" || snapshot.head !== expected.finalHead || snapshot.tree !== expected.finalTree || snapshot.paths.length !== 0)
    throw new Error("managed worktree does not exactly match the accepted final tree");
  const [cached, unstaged, untracked] = await Promise.all([
    git(identity.worktree, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]),
    git(identity.worktree, ["diff", "--name-only", "-z", "--"]),
    git(identity.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (cached.code !== 0 || unstaged.code !== 0 || untracked.code !== 0 || cached.stdout || unstaged.stdout || untracked.stdout)
    throw new Error("terminal index or worktree has staged, unstaged, or untracked paths");
  const chain = await git(identity.worktree, ["rev-list", "--reverse", `${expected.sourceHead}..${expected.finalHead}`]);
  if (chain.code !== 0) throw new Error(chain.stderr.trim() || "could not inspect terminal commit chain");
  const commits = chain.stdout.trim() ? chain.stdout.trim().split(/\s+/u) : [];
  const recorded = expected.phaseCommits.filter((commit): commit is string => commit !== null);
  if (commits.length !== recorded.length || commits.some((commit, index) => commit !== recorded[index])) throw new Error("recorded phase commits are not the direct chain from sourceHead");
  let finalParent: string | null = null;
  for (let index = 0; index < commits.length; index++) {
    const detail = await git(identity.worktree, ["show", "-s", "--format=%P%x00%T", commits[index]]);
    const [parents = "", commitTree = ""] = detail.stdout.trim().split("\0");
    const parent = index === 0 ? expected.sourceHead : commits[index - 1];
    if (detail.code !== 0 || !OBJECT_ID.test(commitTree) || parents !== parent || parents.includes(" ")) throw new Error("terminal commit chain contains a merge or non-direct parent");
    if (index === commits.length - 1) finalParent = parent;
  }
  const head = await git(identity.worktree, ["rev-parse", "HEAD"]);
  const tree = await git(identity.worktree, ["rev-parse", "HEAD^{tree}"]);
  if (head.code !== 0 || tree.code !== 0 || head.stdout.trim() !== expected.finalHead || tree.stdout.trim() !== expected.finalTree) throw new Error("final HEAD or tree differs from acceptance");
  return { finalHead: expected.finalHead, finalTree: expected.finalTree, finalParent, orderedCommits: commits, base: await classifyBase(identity, expected.baseHead) };
}

function requireObjectId(value: string, label: string): void {
  if (!OBJECT_ID.test(value)) throw new Error(`invalid ${label} object ID`);
}

function sameSnapshot(
  actual: Awaited<ReturnType<typeof managedWorktreeSnapshot>>,
  expected: WorktreeSnapshot,
): boolean {
  return (
    actual.kind === "present" &&
    actual.head === expected.head &&
    actual.tree === expected.tree &&
    actual.paths.length === expected.paths.length &&
    actual.paths.every((path, index) => path === expected.paths[index])
  );
}

async function requireSnapshot(
  identity: TaskIdentity,
  expected: WorktreeSnapshot,
): Promise<WorktreeSnapshot> {
  const actual = await managedWorktreeSnapshot(identity);
  if (actual.kind === "present" && sameSnapshot(actual, expected)) return actual;
  throw new Error("managed worktree snapshot changed");
}

async function writeTree(root: string): Promise<string> {
  const result = await git(root, ["write-tree"]);
  const tree = result.stdout.trim();
  if (result.code !== 0 || !OBJECT_ID.test(tree)) {
    throw new Error(result.stderr.trim() || "could not write Git index tree");
  }
  return tree;
}

async function residueReason(root: string): Promise<string | undefined> {
  const [unstaged, untracked] = await Promise.all([
    git(root, ["diff", "--quiet", "--"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (unstaged.code > 1 || untracked.code !== 0) {
    throw new Error("could not inspect managed worktree residue");
  }
  if (unstaged.code !== 0) return "managed worktree has unstaged changes";
  if (untracked.stdout.length !== 0) {
    return "managed worktree has untracked files";
  }
  return undefined;
}

async function indexClean(root: string): Promise<boolean> {
  const result = await git(root, ["diff", "--cached", "--quiet", "--"]);
  if (result.code > 1) throw new Error("could not inspect Git index");
  return result.code === 0;
}

async function rejectUnregisteredGitlinks(root: string): Promise<void> {
  const raw = await git(root, ["diff", "--cached", "--raw", "-z", "HEAD", "--"]);
  if (raw.code !== 0) throw new Error(raw.stderr.trim() || "could not inspect staged Git modes");
  const records = raw.stdout.split("\0");
  const addedGitlinks: string[] = [];
  for (let index = 0; index < records.length - 1; index += 2) {
    const header = records[index];
    const path = records[index + 1];
    const modes = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/u.exec(header);
    if (modes?.[1] !== "160000" && modes?.[2] === "160000" && path) addedGitlinks.push(path);
  }
  if (!addedGitlinks.length) return;
  const configured = await git(root, [
    "config",
    "--blob",
    ":.gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  const registered = configured.code === 0
    ? new Set(configured.stdout.trim().split("\n").map((line) => line.split(/\s+/u).slice(1).join(" ")).filter(Boolean))
    : new Set<string>();
  const accidental = addedGitlinks.filter((path) => !registered.has(path));
  if (accidental.length) {
    throw new Error(`unregistered nested Git repositories cannot be committed: ${accidental.join(", ")}`);
  }
}

export async function unstageCandidate(identity: TaskIdentity): Promise<void> {
  const reset = await git(identity.worktree, ["reset", "--mixed", "--quiet", "HEAD"], GIT_WRITE_MS);
  if (reset.code !== 0) throw new Error(reset.stderr.trim() || "could not clear the candidate index");
}

export async function requireStagedSnapshot(
  identity: TaskIdentity,
  expectedSnapshot: WorktreeSnapshot,
): Promise<string> {
  await rejectUnregisteredGitlinks(identity.worktree);
  const approvedSnapshot = await requireSnapshot(identity, expectedSnapshot);
  const tree = await writeTree(identity.worktree);
  if (tree !== approvedSnapshot.tree) throw new Error("staged tree differs from the approved worktree tree");
  const residue = await residueReason(identity.worktree);
  if (residue) throw new Error(residue);
  return tree;
}

export async function stageExactSnapshot(
  identity: TaskIdentity,
  expectedSnapshot: WorktreeSnapshot,
): Promise<string> {
  if (expectedSnapshot.paths.length === 0) throw new Error("cannot stage an empty worktree snapshot");
  const approvedSnapshot = await requireSnapshot(identity, expectedSnapshot);
  const added = await git(identity.worktree, ["add", "-A"], GIT_WRITE_MS);
  if (added.code !== 0) throw new Error(added.stderr.trim() || "could not stage the candidate worktree");
  try {
    return await requireStagedSnapshot(identity, approvedSnapshot);
  } catch (error) {
    await unstageCandidate(identity);
    throw error;
  }
}

export async function inspectApprovedCommit(
  identity: TaskIdentity,
  parent: string,
  tree: string,
  expectedMessage?: string,
): Promise<ApprovedCommitStatus> {
  requireObjectId(parent, "parent");
  requireObjectId(tree, "tree");
  const snapshot = await managedWorktreeSnapshot(identity);
  if (snapshot.kind === "absent") {
    return { status: "blocked", reason: "managed worktree is absent" };
  }
  const residue = await residueReason(identity.worktree);
  if (residue) return { status: "blocked", reason: residue };

  if (snapshot.head === parent) {
    if ((await writeTree(identity.worktree)) !== tree) {
      return {
        status: "blocked",
        reason: "Git index tree differs from approved tree",
      };
    }
    return { status: "awaiting-message" };
  }

  const details = await git(identity.worktree, [
    "show",
    "-s",
    "--format=%P%x00%T",
    snapshot.head,
  ]);
  if (details.code !== 0) {
    return { status: "blocked", reason: "HEAD commit could not be inspected" };
  }
  const [parents = "", headTree = ""] = details.stdout.trim().split("\0");
  if (parents !== parent) {
    return {
      status: "blocked",
      reason: "HEAD is not the direct non-merge child of approved parent",
    };
  }
  if (headTree !== tree) {
    return {
      status: "blocked",
      reason: "committed tree differs from approved tree",
    };
  }
  if (!(await indexClean(identity.worktree))) {
    return { status: "blocked", reason: "managed worktree index is dirty" };
  }
  if (expectedMessage !== undefined) {
    const object = await git(identity.worktree, ["cat-file", "commit", snapshot.head]);
    if (object.code !== 0) {
      return { status: "blocked", reason: "HEAD commit message could not be inspected" };
    }
    const separator = object.stdout.indexOf("\n\n");
    if (separator < 0) {
      return { status: "blocked", reason: "HEAD commit object is malformed" };
    }
    const rawMessage = object.stdout.slice(separator + 2);
    const committedMessage = rawMessage.endsWith("\n")
      ? rawMessage.slice(0, -1)
      : rawMessage;
    if (committedMessage !== expectedMessage) {
      return { status: "blocked", reason: "committed message differs from approved message" };
    }
  }
  return { status: "committed", commit: snapshot.head };
}

export async function commitApprovedTree(
  identity: TaskIdentity,
  parent: string,
  tree: string,
  message: string,
): Promise<string> {
  if (message.trim().length === 0) {
    throw new Error("commit message must be nonempty");
  }
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH || message.includes("\0")) {
    throw new Error("commit message is invalid or too long");
  }
  const before = await inspectApprovedCommit(identity, parent, tree);
  if (before.status !== "awaiting-message") {
    throw new Error(
      `approved commit is not awaiting a message: ${
        before.status === "blocked" ? before.reason : before.status
      }`,
    );
  }
  const committed = await git(
    identity.worktree,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--cleanup=verbatim",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      message,
    ],
    GIT_WRITE_MS,
  );
  if (committed.code !== 0) {
    throw new Error(committed.stderr.trim() || "git commit failed");
  }
  const after = await inspectApprovedCommit(identity, parent, tree, message);
  if (after.status !== "committed") {
    throw new Error(
      `committed result was not approved: ${
        after.status === "blocked" ? after.reason : after.status
      }`,
    );
  }
  return after.commit;
}
