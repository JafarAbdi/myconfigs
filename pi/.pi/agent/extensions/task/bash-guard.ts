/**
 * The one place this extension inspects a command string.
 *
 * Planning needs bash — `git log`, `rg`, `cargo tree`, whatever this repository uses to explain
 * itself — so the question is not which commands are allowed but which ones stop it being a reading
 * stage. Hence a denylist: it fails open, so an unusual read-only command still runs, where an
 * allowlist would refuse everything nobody thought of.
 *
 * The command is tokenised the way a shell would, rather than pattern-matched: quotes are honoured,
 * so `rg -n "=>" src/` is a search and `echo x > f` is a write, and the two cannot be confused.
 * Every refusal names the token that caused it, because a model told only "blocked" tries something
 * else, and the something else is usually worse.
 *
 * This is a drift guard, not a sandbox. It stops a planner from starting to implement; a command
 * that means to get around it can. The guarantees are elsewhere: `edit` and `write` cannot leave the
 * task directory, and `delegate` reaches research roles only. For an actual sandbox, pi's
 * `createBashTool` takes a `spawnHook` and its `examples/extensions/sandbox/` wraps commands with
 * bubblewrap — a dependency, and a decision for the operator rather than a default.
 */

/** Commands whose ordinary use changes files. */
const WRITE_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "ln", "tee", "dd", "truncate", "chmod", "chown",
	"chgrp", "patch", "install", "shred", "unzip", "tar", "gunzip", "mktemp",
]);

/** Commands that build or run project code: they write into the tree and execute what they find. */
const BUILD_COMMANDS = new Set([
	"make", "ninja", "cmake", "meson", "gradle", "mvn", "ant", "bazel", "dotnet", "swift", "zig",
	"rustc", "gcc", "g++", "cc", "clang", "javac", "tsc", "webpack", "vite", "esbuild", "rollup",
	"pytest", "tox", "nox", "jest", "vitest", "python", "python3", "node", "deno", "ruby", "php",
]);

/** Shells and evaluators: what they run cannot be read from the outside. */
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "eval", "source", "."]);

const ELEVATION = new Set(["sudo", "doas", "su", "pkexec"]);

/** Commands that run another command; the guard follows through to it. */
const WRAPPERS = new Set(["env", "time", "nohup", "nice", "ionice", "xargs", "command", "exec", "timeout", "watch"]);
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	env: new Set(["-u", "--unset", "-C", "--chdir"]),
	time: new Set(["-f", "--format", "-o", "--output"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
	xargs: new Set(["-a", "--arg-file", "-d", "--delimiter", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"]),
	command: new Set(),
	exec: new Set(["-a"]),
	timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
	watch: new Set(["-d", "--differences", "-n", "--interval"]),
	nohup: new Set(),
};

/** Git verbs that always write: history, the index, the working tree, or a remote. */
const WRITE_GIT = new Set([
	"add", "commit", "checkout", "switch", "restore", "apply", "am", "reset", "revert", "rebase",
	"merge", "cherry-pick", "push", "pull", "fetch", "clean", "init", "clone", "gc", "prune", "mv",
	"rm", "update-ref", "update-index", "filter-branch",
]);

/** Verbs that both report and change: `git worktree list` reads, `git worktree add` does not. */
const REPORTING_GIT = new Set(["worktree", "stash"]);
const REPORTING_VERBS = new Set(["list", "show"]);

/** `git branch` and `git tag` are read-only only when their reporting intent is explicit. */
const REF_REPORTING_FLAGS = new Set([
	"-l", "--list", "-v", "--verify", "-n", "--contains", "--no-contains", "--merged", "--no-merged",
	"--points-at", "--format", "--sort", "--column", "--color", "--ignore-case", "--abbrev",
]);
const BRANCH_CHANGING_FLAGS = new Set([
	"-u", "-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force",
	"--edit-description", "--set-upstream-to", "--unset-upstream", "--create-reflog",
]);
const TAG_CHANGING_FLAGS = new Set([
	"-a", "-s", "-u", "-d", "-f", "-F", "-e", "-m", "--annotate", "--sign", "--local-user",
	"--delete", "--force", "--file", "--edit", "--message", "--create-reflog",
]);

/** Git options that take a value, so the token after them is not the subcommand. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const PACKAGE_MANAGERS = new Set([
	"npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "uvx", "cargo", "apt", "apt-get", "brew",
	"gem", "go", "poetry", "nix", "conda", "composer",
]);

/** The package-manager subcommands that only report. Everything else installs, builds, or runs. */
const PACKAGE_READS = new Set([
	"list", "ls", "tree", "info", "view", "show", "why", "outdated", "search", "metadata", "audit",
	"licenses", "config", "help", "version", "--version", "-V", "which", "env", "locate", "doctor",
]);

/** `find` actions that change files rather than report them. */
const FIND_WRITES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"]);

interface Token {
	text: string;
	/** Quoted text is never an operator: `"=>"` is a search pattern, `>` is a redirection. */
	quoted: boolean;
}

/** Characters a shell treats as their own token when they are not quoted. */
const OPERATORS = new Set([";", "|", "&", "<", ">", "(", ")", "\n"]);

function hasCommandSubstitution(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "'" && quote === undefined) {
			quote = "'";
			continue;
		}
		if (character === '"') {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (character === "`" || (character === "$" && command[index + 1] === "(")) return true;
	}
	return false;
}

function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let text = "";
	let quoted = false;
	let started = false;
	let quote: string | undefined;
	const flush = (): void => {
		if (started) tokens.push({ text, quoted });
		text = "";
		quoted = false;
		started = false;
	};
	for (const character of command) {
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else text += character;
			started = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			quoted = true;
			started = true;
			continue;
		}
		if (OPERATORS.has(character)) {
			flush();
			tokens.push({ text: character, quoted: false });
			continue;
		}
		if (character === " " || character === "\t") {
			flush();
			continue;
		}
		text += character;
		started = true;
	}
	flush();
	return tokens;
}

function isOperator(token: Token): boolean {
	return !token.quoted && OPERATORS.has(token.text);
}

/** Each command in the line, as its arguments — the operators between them are the boundaries. */
function invocations(tokens: Token[]): string[][] {
	const commands: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (isOperator(token)) {
			if (current.length) commands.push(current);
			current = [];
			continue;
		}
		current.push(token.text);
	}
	if (current.length) commands.push(current);
	return commands;
}

function gitSubcommand(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (GIT_VALUE_OPTIONS.has(argument)) {
			index += 1;
			continue;
		}
		if (!argument.startsWith("-")) return argument;
	}
	return undefined;
}

function firstWord(args: string[]): string | undefined {
	return args.find((argument) => !argument.startsWith("-"));
}

function hasOption(args: string[], flags: ReadonlySet<string>): boolean {
	return args.some((argument) => [...flags].some((flag) =>
		argument === flag || (flag.startsWith("--") ? argument.startsWith(`${flag}=`) : argument.startsWith(flag)),
	));
}

function refChangingFlag(args: string[], flags: ReadonlySet<string>): string | undefined {
	return args.find((argument) => hasOption([argument], flags));
}

function git(args: string[]): string | undefined {
	const subcommand = gitSubcommand(args);
	if (subcommand === undefined) return undefined;
	if (WRITE_GIT.has(subcommand)) return `git ${subcommand} changes the repository`;
	const rest = args.slice(args.indexOf(subcommand) + 1);
	if (REPORTING_GIT.has(subcommand)) {
		const verb = firstWord(rest);
		if (verb !== undefined && REPORTING_VERBS.has(verb)) return undefined;
		return `git ${subcommand} ${verb ?? ""}`.trim() + " changes the repository";
	}
	if (subcommand === "branch" || subcommand === "tag") {
		const changing = subcommand === "branch" ? BRANCH_CHANGING_FLAGS : TAG_CHANGING_FLAGS;
		const flag = refChangingFlag(rest, changing);
		if (flag) return `git ${subcommand} ${flag} changes a ref`;
		const positional = firstWord(rest);
		if (positional !== undefined && !hasOption(rest, REF_REPORTING_FLAGS)) {
			return `git ${subcommand} ${positional} changes a ref`;
		}
		return undefined;
	}
	return undefined;
}

function wrappedCommand(name: string, args: string[]): string[] {
	const valueOptions = WRAPPER_VALUE_OPTIONS[name]!;
	let index = 0;
	while (index < args.length && args[index]!.startsWith("-")) {
		const option = args[index]!;
		index += 1;
		if (option === "--") break;
		if (!option.includes("=") && valueOptions.has(option)) index += 1;
	}
	if (name === "env") {
		while (index < args.length && args[index]!.includes("=")) index += 1;
	}
	if (name === "timeout") index += 1; // Duration precedes the command.
	return args.slice(index);
}

function mutates(argv: string[]): string | undefined {
	const [head, ...rest] = argv;
	if (head === undefined) return undefined;
	const name = head.slice(head.lastIndexOf("/") + 1);

	if (SHELLS.has(name)) return `${name} runs a command this stage cannot read`;
	if (ELEVATION.has(name)) return `${name} escalates privileges`;
	if (WRAPPERS.has(name)) {
		if (name === "time" && rest.some((argument) => ["-o", "--output"].includes(argument) || argument.startsWith("--output="))) {
			return "time --output changes files";
		}
		const inner = wrappedCommand(name, rest);
		return inner.length ? mutates(inner) : undefined;
	}
	if (WRITE_COMMANDS.has(name)) return `${name} changes files`;
	if (BUILD_COMMANDS.has(name)) return `${name} builds or runs project code, which writes into the tree`;
	if (name === "git") return git(rest);
	if (PACKAGE_MANAGERS.has(name)) {
		const verb = firstWord(rest);
		if (verb === undefined || PACKAGE_READS.has(verb)) return undefined;
		return `${name} ${verb} installs, builds, or runs code rather than reporting`;
	}
	if (name === "find" && rest.some((argument) => FIND_WRITES.has(argument))) {
		return "find with -delete or -exec changes files";
	}
	if ((name === "sed" || name === "perl") && rest.some((argument) => argument.startsWith("-i"))) {
		return `${name} -i edits files in place`;
	}
	if (name === "curl" && rest.some((argument) => argument === "-o" || argument === "-O" || argument === "--output")) {
		return "curl -o writes the response to a file";
	}
	if (name === "wget") return "wget writes the response to a file";
	return undefined;
}

/**
 * Why this command line would change something, or undefined when it only reads. The reason is the
 * refusal message: it names what was matched, so the model corrects the command instead of
 * disguising it.
 */
export function writeReason(command: string): string | undefined {
	if (hasCommandSubstitution(command)) {
		return "command substitution hides execution; run the read command directly";
	}
	const tokens = tokenize(command);
	for (const [index, token] of tokens.entries()) {
		if (token.quoted || token.text !== ">") continue;
		// `2>&1` points a descriptor at another descriptor; only a name after `>` is a file.
		const target = tokens[index + 1];
		if (target && !target.quoted && target.text === "&") continue;
		return "it redirects output into a file";
	}
	for (const argv of invocations(tokens)) {
		const reason = mutates(argv);
		if (reason) return reason;
	}
	return undefined;
}
