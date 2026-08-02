import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deletionConfirmationDetail } from "./picker.ts";
import {
	assertTaskBranchAvailable,
	branchHead,
	discardCapturedWork,
	ensureManagedWorktree,
	git,
	managedDeletionWorktreeSnapshot,
	managedWorktreeSnapshot,
	prepareInitialRepository,
	parseWorktreePorcelain,
	removeManagedWorktree,
	repositoryClean,
	repositoryEvidence,
	validateManagedWorktree,
	validBranchName,
	worktreeStatus,
} from "./repository.ts";
import { runtimePaths } from "./runtime.ts";
import { taskIdentity } from "./tasks.ts";

for (const [key, value] of Object.entries({
	GIT_AUTHOR_NAME: "JURUC tests",
	GIT_AUTHOR_EMAIL: "juruc@example.invalid",
	GIT_COMMITTER_NAME: "JURUC tests",
	GIT_COMMITTER_EMAIL: "juruc@example.invalid",
})) process.env[key] = value;

async function must(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

async function committedRepository(path: string): Promise<void> {
	mkdirSync(path);
	await must(path, ["init", "-b", "main"]);
	writeFileSync(join(path, "tracked.txt"), "baseline\n");
	await must(path, ["add", "tracked.txt"]);
	await must(path, ["commit", "-m", "Baseline"]);
}

const nul = "\0";
const worktreeRecord = (path: string, head: string, trailer: string): string =>
	`worktree ${path}${nul}HEAD ${head}${nul}${trailer}${nul}${nul}`;
const worktreeA = "a".repeat(40);
const worktreeB = "b".repeat(40);
assert.deepEqual(
	parseWorktreePorcelain(
		worktreeRecord("/tmp/space path", worktreeA, "branch refs/heads/main") +
		worktreeRecord("/tmp/literal\nnewline", worktreeB, "detached"),
	),
	[
		{ worktree: "/tmp/space path", branch: "refs/heads/main", detached: false },
		{ worktree: "/tmp/literal\nnewline", branch: undefined, detached: true },
	],
);
for (const malformed of [
	"",
	`worktree /tmp/missing${nul}HEAD ${worktreeA}${nul}`,
	`worktree /tmp/no-head${nul}branch refs/heads/main${nul}${nul}`,
	`worktree /tmp/no-kind${nul}HEAD ${worktreeA}${nul}${nul}`,
	`worktree /tmp/bad-branch${nul}HEAD ${worktreeA}${nul}branch main${nul}${nul}`,
])
	assert.throws(() => parseWorktreePorcelain(malformed), /worktree list output is malformed/);

const root = mkdtempSync(join(tmpdir(), "juruc-repository-test-"));
try {
	const moduleSource = join(root, "module-source");
	await committedRepository(moduleSource);
	writeFileSync(join(moduleSource, ".gitignore"), ".venv/\n");
	await must(moduleSource, ["add", ".gitignore"]);
	await must(moduleSource, ["commit", "-m", "Ignore build output"]);

	const source = join(root, "source");
	await committedRepository(source);
	mkdirSync(join(source, "src"));
	writeFileSync(join(source, ".gitignore"), ".venv/\n__pycache__/\n");
	writeFileSync(join(source, "src", "tracked.txt"), "tracked source\n");
	await must(source, ["add", ".gitignore", "src/tracked.txt"]);
	await must(source, ["commit", "-m", "Ignore generated trees"]);
	await must(source, [
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		moduleSource,
		"module",
	]);
	await must(source, ["commit", "-m", "Add module"]);
	const initial = (await repositoryEvidence(source))!;
	writeFileSync(join(source, "local-only.txt"), "not committed\n");
	const notices: string[] = [];
	const prepared = await prepareInitialRepository(
		source,
		async () => { throw new Error("existing repositories must not ask to initialize"); },
		(message) => notices.push(message),
	);
	assert.deepEqual(prepared, initial);
	assert.match(notices[0], /changes are excluded/);

	const agent = join(root, "agent");
	mkdirSync(agent);
	const paths = runtimePaths(agent);
	const identity = taskIdentity(paths, "isolated-task", prepared!.root, prepared!.branch, prepared!.head);
	assert.equal(await validBranchName(source, identity.branch), true);
	assert.equal(await validBranchName(source, "bad branch"), false);
	await assertTaskBranchAvailable(source, identity.branch, identity.worktree);
	await ensureManagedWorktree(identity);
	await must(identity.worktree, [
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"update",
		"--init",
		"--recursive",
	]);
	assert.equal(existsSync(join(identity.worktree, "local-only.txt")), false);
	assert.equal((await validateManagedWorktree(identity)).head, initial.head);
	assert.equal(await branchHead(identity.branch, source), initial.head);
	assert.equal(await repositoryClean(identity.worktree), true);
	const headTree = await must(identity.worktree, ["rev-parse", "HEAD^{tree}"]);
	const cleanSnapshot = await managedWorktreeSnapshot(identity);
	assert.deepEqual(cleanSnapshot, {
		kind: "present",
		head: initial.head,
		paths: [],
		tree: headTree,
	});
	assert.equal(await worktreeStatus(identity), "");

	const generated = join(identity.worktree, "generated", "nested", "artifact.txt");
	const virtualEnvironment = join(identity.worktree, ".venv", "lib", "site.py");
	const bytecode = join(identity.worktree, "src", "__pycache__", "module.pyc");
	for (const path of [generated, virtualEnvironment, bytecode]) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "generated\n");
	}
	const exactDeletionSnapshot = await managedDeletionWorktreeSnapshot(identity);
	assert.equal(exactDeletionSnapshot.kind, "present");
	if (exactDeletionSnapshot.kind !== "present")
		throw new Error("expected exact deletion snapshot");
	assert.deepEqual(exactDeletionSnapshot.paths, [
		".venv/lib/site.py",
		"generated/nested/artifact.txt",
		"src/__pycache__/module.pyc",
	]);
	const collapsedStatus = await worktreeStatus(identity);
	assert.match(collapsedStatus ?? "", /^!! \.venv\/$/m);
	assert.match(collapsedStatus ?? "", /^\?\? generated\/$/m);
	assert.match(collapsedStatus ?? "", /^!! src\/__pycache__\/$/m);
	assert.doesNotMatch(collapsedStatus ?? "", /site\.py|artifact\.txt|module\.pyc/);
	const lateGenerated = join(identity.worktree, ".venv", "lib", "late.py");
	writeFileSync(lateGenerated, "late\n");
	assert.notDeepEqual(
		await managedDeletionWorktreeSnapshot(identity),
		exactDeletionSnapshot,
		"adding a nested path invalidates exact deletion evidence",
	);
	rmSync(lateGenerated);
	assert.deepEqual(await managedDeletionWorktreeSnapshot(identity), exactDeletionSnapshot);
	rmSync(generated);
	assert.notDeepEqual(
		await managedDeletionWorktreeSnapshot(identity),
		exactDeletionSnapshot,
		"removing a nested path invalidates exact deletion evidence",
	);
	writeFileSync(generated, "generated\n");
	for (const path of [".venv", "generated", "src/__pycache__"])
		rmSync(join(identity.worktree, path), { recursive: true });

	const ignoredDirectory = join(identity.worktree, "module", ".venv");
	mkdirSync(join(ignoredDirectory, "lib"), { recursive: true });
	const ignored = join(ignoredDirectory, "lib", "site.py");
	writeFileSync(ignored, "first ignored body\n");
	assert.deepEqual(
		await managedWorktreeSnapshot(identity),
		cleanSnapshot,
		"ignored products are excluded from the workflow tree",
	);
	const deletionSnapshot = await managedDeletionWorktreeSnapshot(identity);
	assert.equal(deletionSnapshot.kind, "present");
	if (deletionSnapshot.kind !== "present") throw new Error("expected deletion snapshot");
	assert.ok(deletionSnapshot.paths.includes("module"));
	assert.ok(deletionSnapshot.paths.includes("module/.venv/lib/site.py"));
	const ignoredStatus = await worktreeStatus(identity);
	assert.match(ignoredStatus ?? "", /^\[submodule module\] !! \.venv\/$/m);
	assert.doesNotMatch(ignoredStatus ?? "", /site\.py/);
	assert.match(deletionConfirmationDetail(ignoredStatus), /!! \.venv\//);
	writeFileSync(ignored, "second ignored body\n");
	assert.deepEqual(
		await managedDeletionWorktreeSnapshot(identity),
		deletionSnapshot,
		"deletion confirmation is path-level consent, not content hashing",
	);
	const lateSubmodulePath = join(ignoredDirectory, "lib", "late.py");
	writeFileSync(lateSubmodulePath, "late\n");
	assert.notDeepEqual(
		await managedDeletionWorktreeSnapshot(identity),
		deletionSnapshot,
		"adding a nested submodule path invalidates exact deletion evidence",
	);
	rmSync(lateSubmodulePath);
	assert.deepEqual(await managedDeletionWorktreeSnapshot(identity), deletionSnapshot);
	rmSync(ignoredDirectory, { recursive: true });

	const module = join(identity.worktree, "module");
	writeFileSync(join(module, "untracked.txt"), "dirty nested body\n");
	await assert.rejects(
		() => managedWorktreeSnapshot(identity),
		/dirty submodule worktrees are not representable: module/,
	);
	rmSync(join(module, "untracked.txt"));

	rmSync(join(identity.worktree, "tracked.txt"));
	writeFileSync(join(identity.worktree, "untracked.txt"), "first body\n");
	symlinkSync("first-target", join(identity.worktree, "link.txt"));
	const changed = await managedWorktreeSnapshot(identity);
	assert.equal(changed.kind, "present");
	if (changed.kind !== "present") throw new Error("expected worktree snapshot");
	assert.deepEqual(changed.paths, ["link.txt", "tracked.txt", "untracked.txt"]);
	writeFileSync(join(identity.worktree, "untracked.txt"), "second body\n");
	const changedContent = await managedWorktreeSnapshot(identity);
	assert.equal(changedContent.kind, "present");
	if (changedContent.kind !== "present") throw new Error("expected worktree snapshot");
	assert.notEqual(changedContent.tree, changed.tree, "Git tree captures file content");
	chmodSync(join(identity.worktree, "untracked.txt"), 0o755);
	const changedMode = await managedWorktreeSnapshot(identity);
	assert.equal(changedMode.kind, "present");
	if (changedMode.kind !== "present") throw new Error("expected worktree snapshot");
	assert.notEqual(changedMode.tree, changedContent.tree, "Git tree captures executable mode");
	rmSync(join(identity.worktree, "link.txt"));
	symlinkSync("second-target", join(identity.worktree, "link.txt"));
	const changedLink = await managedWorktreeSnapshot(identity);
	assert.equal(changedLink.kind, "present");
	if (changedLink.kind !== "present") throw new Error("expected worktree snapshot");
	assert.notEqual(changedLink.tree, changedMode.tree, "Git tree captures symlink targets");

	await must(identity.worktree, ["reset", "--hard", "HEAD"]);
	rmSync(join(identity.worktree, "link.txt"));
	rmSync(join(identity.worktree, "untracked.txt"));
	assert.equal(await repositoryClean(identity.worktree), true);
	const beforeHeadChange = await managedWorktreeSnapshot(identity);
	await must(identity.worktree, ["commit", "--allow-empty", "-m", "Move HEAD"]);
	const afterHeadChange = await managedWorktreeSnapshot(identity);
	assert.notDeepEqual(afterHeadChange, beforeHeadChange, "HEAD is part of snapshot identity");
	await must(identity.worktree, ["reset", "--hard", initial.head]);

	writeFileSync(join(identity.worktree, "tracked.txt"), "discard this change\n");
	writeFileSync(join(identity.worktree, "discard-untracked.txt"), "discard me\n");
	const discardSnapshot = await managedWorktreeSnapshot(identity);
	assert.equal(discardSnapshot.kind, "present");
	if (discardSnapshot.kind !== "present") throw new Error("expected discard snapshot");
	writeFileSync(join(identity.worktree, "tracked.txt"), "changed after confirmation\n");
	await assert.rejects(() => discardCapturedWork(identity, discardSnapshot), /changed after confirmation/);
	writeFileSync(join(identity.worktree, "tracked.txt"), "discard this change\n");
	const discarded = await discardCapturedWork(identity, discardSnapshot);
	assert.deepEqual(discarded.paths, []);
	assert.equal(discarded.head, initial.head);
	assert.equal(existsSync(join(identity.worktree, "discard-untracked.txt")), false);
	assert.equal(await repositoryClean(identity.worktree), true);

	await must(identity.worktree, ["checkout", "--detach"]);
	await assert.rejects(() => validateManagedWorktree(identity), /expected branch isolated-task, found <detached>/);
	await must(identity.worktree, ["checkout", identity.branch]);

	await must(source, ["branch", "collision", initial.head]);
	await assert.rejects(
		() => assertTaskBranchAvailable(source, "collision", join(paths.worktrees, "collision")),
		/already exists/,
	);
	const occupied = join(paths.worktrees, "occupied");
	mkdirSync(occupied);
	await assert.rejects(() => assertTaskBranchAvailable(source, "occupied", occupied), /already exists/);

	const detached = join(root, "detached");
	await committedRepository(detached);
	await must(detached, ["checkout", "--detach"]);
	await assert.rejects(() => prepareInitialRepository(detached, async () => true), /detached HEAD is unsupported/);

	const unborn = join(root, "unborn");
	mkdirSync(unborn);
	await must(unborn, ["init", "-b", "main"]);
	writeFileSync(join(unborn, "baseline.txt"), "unborn baseline\n");
	let confirmations = 0;
	assert.equal(await prepareInitialRepository(unborn, async () => { confirmations++; return false; }), undefined);
	assert.equal(await repositoryEvidence(unborn), undefined);
	const born = await prepareInitialRepository(unborn, async () => { confirmations++; return true; });
	assert.equal(confirmations, 2);
	assert.equal(born?.branch, "main");
	assert.equal(await repositoryClean(unborn), true);
	assert.equal(await must(unborn, ["log", "-1", "--format=%s"]), "Initialize repository");

	const absent = join(root, "absent");
	mkdirSync(absent);
	writeFileSync(join(absent, "baseline.txt"), "absent baseline\n");
	const initialized = await prepareInitialRepository(absent, async (title, detail) => {
		assert.match(title, /Initialize Git/);
		assert.match(detail, /Every current non-ignored file/);
		return true;
	});
	assert.equal(initialized?.root, absent);
	assert.equal(existsSync(join(absent, ".git")), true);
	assert.equal(await repositoryClean(absent), true);

	await removeManagedWorktree(identity);
	assert.equal(existsSync(identity.worktree), false);
	assert.equal(await branchHead(identity.branch, source), initial.head);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("juruc repository lifecycle: ok");
