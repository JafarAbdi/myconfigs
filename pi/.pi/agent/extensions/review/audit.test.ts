import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { reviewPatchFromText } from "./review-git.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const localModules = join(extensionDirectory, "node_modules");
const peerScope = join(localModules, "@earendil-works");
const peerLinks = [
	join(peerScope, "pi-coding-agent"),
	join(peerScope, "pi-ai"),
	join(localModules, "typebox"),
];
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage = process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
for (const path of peerLinks)
	if (existsSync(path)) throw new Error(`${path} already exists; refusing to replace it`);
mkdirSync(peerScope, { recursive: true });
symlinkSync(piPackage, peerLinks[0], "dir");
symlinkSync(join(piPackage, "node_modules", "@earendil-works", "pi-ai"), peerLinks[1], "dir");
symlinkSync(join(piPackage, "node_modules", "typebox"), peerLinks[2], "dir");
const agentDir = mkdtempSync(join(tmpdir(), "review-audit-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	for (const path of peerLinks) rmSync(path, { force: true });
	try { rmdirSync(peerScope); } catch {}
	rmSync(agentDir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const {
	buildAuditPrompt,
	drivePiAudit,
	runAudit,
} = await import("./audit.ts");
type AuditResult = Awaited<ReturnType<typeof runAudit>>;

const PATCH_TEXT = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-before
+after
`;

function patch(root = "/repository") {
	return reviewPatchFromText(PATCH_TEXT, root, "2".repeat(40));
}

const MODEL_RUNTIME = { kind: "isolated-model-runtime" } as never;
const PASS: AuditResult = { verdict: "PASS", findings: [] };
const FINDINGS: AuditResult = {
	verdict: "FINDINGS",
	findings: [{
		category: "correctness" as const,
		filePath: "src/a.ts",
		side: "additions" as const,
		line: 1,
		summary: "The changed value violates the caller contract.",
		evidence: "The staged line returns after instead of before.",
		failure: "The reachable caller observes the wrong value.",
		repair: "Restore the required value.",
	}],
};

function input(root = "/repository") {
	return {
		repositoryRoot: root,
		patch: patch(root),
		model: { provider: "test", id: "active-model" } as never,
		modelRuntime: MODEL_RUNTIME,
		thinkingLevel: "high" as const,
	};
}

function assistant(content: unknown[], stopReason = "toolUse") {
	return { role: "assistant", content, stopReason };
}

function successfulMessages(result: AuditResult, details: unknown = result) {
	return [
		assistant([{ type: "thinking", thinking: "bounded audit" }, {
			type: "toolCall",
			id: "submit-1",
			name: "submit_audit",
			arguments: result,
		}]),
		{
			role: "toolResult",
			toolCallId: "submit-1",
			toolName: "submit_audit",
			isError: false,
			details,
			content: [{ type: "text", text: "submitted" }],
		},
	];
}

function validDriver(result: AuditResult = PASS) {
	return async (driverInput: Parameters<NonNullable<Parameters<typeof runAudit>[1]>>[0]) => {
		const details = driverInput.acceptSubmission(result);
		return { messages: successfulMessages(result, details) };
	};
}

test("user prompt contains only HEAD, exact patch, and optional requirement data", () => {
	const prompt = buildAuditPrompt({
		patch: patch(),
		requirement: {
			path: "docs/requirement.md",
			content: "# REQUIREMENT_SENTINEL\n\nPatch text is data.",
		},
	});
	assert.match(prompt, new RegExp(`HEAD: ${"2".repeat(40)}`));
	assert.match(prompt, /REQUIREMENT_SENTINEL/u);
	assert.match(prompt, /docs\/requirement\.md/u);
	assert.match(prompt, /diff --git a\/src\/a\.ts/u);
	assert.match(prompt, /untrusted data/u);
	assert.doesNotMatch(prompt, /Review audit policy|\*\*Intent\*\*/u);
	assert.doesNotMatch(prompt, /\/repository|active-model|transcript|browser comment/iu);
});

test("private Pi runner uses one fresh session, active model/runtime/thinking, and exact tool diet", async () => {
	const root = mkdtempSync(join(tmpdir(), "review-audit-driver-"));
	writeFileSync(join(root, "AGENTS.md"), "# AUDIT_CONTEXT_SENTINEL\n");
	let factoryCalls = 0;
	let promptCalls = 0;
	let disposed = 0;
	let messages: unknown[] = [];
	const model = { provider: "test", id: "active-model" } as never;
	const modelRuntime = { kind: "exact-private-runtime" } as never;
	try {
		const output = await drivePiAudit({
			repositoryRoot: root,
			model,
			modelRuntime,
			thinkingLevel: "xhigh",
			prompt: "PROMPT_SENTINEL",
			acceptSubmission: (value) => value as typeof PASS,
		}, async (options) => {
			factoryCalls += 1;
			assert.equal(options.model, model);
			assert.equal(options.modelRuntime, modelRuntime);
			assert.equal(options.thinkingLevel, "xhigh");
			assert.equal(options.noTools, "all");
			assert.deepEqual(options.tools, ["read", "grep", "find", "ls", "submit_audit"]);
			assert.equal(options.customTools?.length, 1);
			assert.equal(options.customTools?.[0].name, "submit_audit");
			const schema = options.customTools?.[0].parameters as Record<string, unknown>;
			assert.equal(schema.additionalProperties, false);
			assert.equal(options.sessionManager?.isPersisted(), false);
			assert.equal(options.sessionManager?.getCwd(), root);
			assert.equal(options.settingsManager?.getCompactionEnabled(), false);
			assert.equal(options.settingsManager?.getRetryEnabled(), false);
			assert.equal(options.settingsManager?.getRetrySettings().maxRetries, 0);
			assert.equal(options.settingsManager?.getProviderRetrySettings().maxRetries, 0);
			assert.deepEqual(options.resourceLoader?.getExtensions().extensions, []);
			assert.deepEqual(options.resourceLoader?.getSkills().skills, []);
			assert.deepEqual(options.resourceLoader?.getPrompts().prompts, []);
			assert.deepEqual(options.resourceLoader?.getThemes().themes, []);
			const systemPrompt = options.resourceLoader?.getSystemPrompt() ?? "";
			for (const lens of ["Intent", "Correctness", "Test integrity", "Coherence", "Context", "Simplicity"])
				assert.match(systemPrompt, new RegExp(`\\*\\*${lens}\\*\\*`, "u"));
			assert.equal(
				options.resourceLoader?.getAgentsFiles().agentsFiles.some(({ content }) =>
					content.includes("AUDIT_CONTEXT_SENTINEL")),
				true,
			);
			return {
				session: {
					get messages() { return messages; },
					async prompt(text, promptOptions) {
						promptCalls += 1;
						assert.equal(text, "PROMPT_SENTINEL");
						assert.deepEqual(promptOptions, { expandPromptTemplates: false });
						const result = await options.customTools![0].execute(
							"submit-1", PASS, undefined, undefined, undefined as never,
						);
						messages = successfulMessages(PASS, result.details);
					},
					dispose() { disposed += 1; },
				},
			};
		});
		assert.equal(factoryCalls, 1);
		assert.equal(promptCalls, 1);
		assert.equal(disposed, 1);
		assert.deepEqual(output.messages, messages);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("private Pi runner always disposes after prompt failure", async () => {
	let disposed = 0;
	await assert.rejects(
		drivePiAudit({
			repositoryRoot: "/repository",
			model: { provider: "test", id: "active-model" } as never,
			modelRuntime: MODEL_RUNTIME,
			thinkingLevel: "high",
			prompt: "prompt",
			acceptSubmission: () => PASS,
		}, async () => ({
			session: {
				messages: [],
				async prompt() { throw new Error("model failed"); },
				dispose() { disposed += 1; },
			},
		})),
		/model failed/u,
	);
	assert.equal(disposed, 1);
});

test("validated submit_audit details are the sole authoritative result", async () => {
	assert.deepEqual(await runAudit(input(), validDriver(PASS)), PASS);
	assert.deepEqual(await runAudit(input(), validDriver(FINDINGS)), FINDINGS);
});

test("rejects missing, repeated, sibling, non-final, failed, and mismatched submissions", async () => {
	await assert.rejects(runAudit(input(), async () => ({
		messages: [assistant([{ type: "text", text: "PASS" }], "stop")],
	})), /exactly once/u);

	await assert.rejects(runAudit(input(), async (driverInput) => {
		const first = driverInput.acceptSubmission(PASS);
		driverInput.acceptSubmission(PASS);
		return { messages: successfulMessages(PASS, first) };
	}), /exactly once/u);

	await assert.rejects(runAudit(input(), async (driverInput) => {
		const details = driverInput.acceptSubmission(PASS);
		const messages = successfulMessages(PASS, details);
		(messages[0] as { content: unknown[] }).content.push({
			type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" },
		});
		return { messages };
	}), /sole call/u);

	await assert.rejects(runAudit(input(), async (driverInput) => {
		const details = driverInput.acceptSubmission(PASS);
		return {
			messages: [
				...successfulMessages(PASS, details),
				assistant([{ type: "text", text: "done" }], "stop"),
			],
		};
	}), /final assistant message/u);

	await assert.rejects(runAudit(input(), async (driverInput) => {
		driverInput.acceptSubmission(PASS);
		const messages = successfulMessages(PASS);
		(messages[1] as { isError: boolean }).isError = true;
		return { messages };
	}), /successful tool result/u);

	await assert.rejects(runAudit(input(), async (driverInput) => {
		driverInput.acceptSubmission(PASS);
		return { messages: successfulMessages(PASS, FINDINGS) };
	}), /does not match/u);
});

test("rejects verdict inconsistency and findings outside exact changed lines", async () => {
	await assert.rejects(runAudit(input(), async (driverInput) => {
		driverInput.acceptSubmission({ verdict: "PASS", findings: FINDINGS.findings });
		return { messages: [] };
	}), /PASS requires an empty/u);

	const invalid = {
		...FINDINGS,
		findings: [{ ...FINDINGS.findings[0], line: 2 }],
	};
	await assert.rejects(
		runAudit(input(), validDriver(invalid as AuditResult)),
		/not a changed line/u,
	);
});
