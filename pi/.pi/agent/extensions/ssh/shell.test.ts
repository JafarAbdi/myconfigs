import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fdExcludeArgs, rgExcludeArgs, shellQuote, toDisplayPath } from "./shell.ts";

// shellQuote is the one function every remote command is built from. A wrong escape here is
// command injection, so this proves round-tripping through a real shell, not just checking the
// escaped string looks right.
function roundTripThroughShell(value: string): string {
	const command = `printf '%s' ${shellQuote(value)}`;
	return execFileSync("bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8" });
}

const shellQuoteCases = [
	"plain",
	"",
	"has space",
	"it's a test",
	"''",
	"'''",
	"$(rm -rf /)",
	"`rm -rf /`",
	"; rm -rf / #",
	"a'b'c",
	"newline\nin\nvalue",
	"back\\slash",
	'"double quotes"',
	"$HOME and $PATH",
];

for (const value of shellQuoteCases) {
	assert.equal(roundTripThroughShell(value), value, `shellQuote round-trip failed for: ${JSON.stringify(value)}`);
}

assert.deepEqual(fdExcludeArgs(["a", "b"]), ["--exclude", "a", "--exclude", "b"]);
assert.deepEqual(fdExcludeArgs([]), []);
assert.deepEqual(rgExcludeArgs(["a", "b"]), ["--glob", "!**/a/**", "--glob", "!**/b/**"]);
assert.equal(toDisplayPath("a\\b\\c"), "a/b/c");
assert.equal(toDisplayPath("a/b/c"), "a/b/c");

console.log("ssh shell: ok");
