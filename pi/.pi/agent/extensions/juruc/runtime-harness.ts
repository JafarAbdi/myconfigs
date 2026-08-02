import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import juruc from "./index.ts";

export { fauxAssistantMessage, fauxToolCall };

export interface HarnessInstance {
	instance: number;
	pi: ExtensionAPI;
	startContext?: ExtensionContext;
	rawManager?: unknown;
}

export interface HarnessOptions {
	agentDir: string;
	cwd: string;
	sessionManager: SessionManager;
	/** Absolute canonical prompt-template files exposed through `pi.getCommands()`. */
	promptTemplates: readonly string[];
	/** Extra tool names registered as stubs so JURUC profiles can activate. */
	stubTools?: readonly string[];
	/** Result `details` a stub tool returns, letting tests supply delegate payloads. */
	stubResult?: (name: string, args: unknown) => unknown;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	editor?: (title: string) => Promise<string | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
	/** Registered in the same extension closure as JURUC, before JURUC itself. */
	beforeJuruc?: readonly ((pi: ExtensionAPI) => void)[];
	/** Registered after JURUC, matching configured extension order. */
	afterJuruc?: readonly ((pi: ExtensionAPI) => void)[];
	probe?: (pi: ExtensionAPI, record: HarnessInstance) => void;
}

export interface RuntimeHarness {
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	/** One record per constructed JURUC extension instance, in creation order. */
	instances: HarnessInstance[];
	/** Ordered lifecycle trace: `start:N`, `shutdown:N:reason`, `with:N`. */
	events: string[];
	notices: string[];
	widgets: string[];
	/** Records `with:N` for the instance whose closure is running the callback. */
	noteWithSession: (instance: number) => void;
	setResponses: (responses: unknown[]) => void;
	appendResponses: (responses: unknown[]) => void;
	cancelNextSwitch: () => void;
	selections: string[];
	editorValues: Array<string | undefined>;
	confirmations: boolean[];
	dispose: () => Promise<void>;
}

/**
 * Builds a real Pi runtime whose every session replacement constructs a fresh
 * JURUC extension instance. Nothing here simulates replacement: Pi destroys the
 * old runtime, starts the fresh one, then invokes the old `withSession`.
 */
export async function createRuntimeHarness(options: HarnessOptions): Promise<RuntimeHarness> {
	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const provider = faux.getModel().provider;
	mkdirSync(options.agentDir, { recursive: true });
	const authPath = join(options.agentDir, "harness-auth.json");
	writeFileSync(authPath, JSON.stringify({ [provider]: { type: "api_key", key: "faux-key" } }), {
		mode: 0o600,
	});
	const modelRuntime = await ModelRuntime.create({
		authPath,
		modelsPath: join(options.agentDir, "harness-models.json"),
	});

	const instances: HarnessInstance[] = [];
	const events: string[] = [];
	const notices: string[] = [];
	const widgets: string[] = [];
	const selections: string[] = [];
	const editorValues: Array<string | undefined> = [];
	const confirmations: boolean[] = [];
	let cancelNextSwitch = false;

	const uiContext = {
		select: options.select ?? (async () => selections.shift()),
		confirm: options.confirm ?? (async () => confirmations.shift() ?? false),
		input: async () => undefined,
		editor: options.editor ?? (async () => editorValues.shift()),
		notify: (message: string) => {
			notices.push(message);
		},
		onTerminalInput: () => () => undefined,
		setStatus: () => undefined,
		setWorkingMessage: () => undefined,
		setWorkingVisible: () => undefined,
		setWorkingIndicator: () => undefined,
		setHiddenThinkingLabel: () => undefined,
		setWidget: (key: string, content: unknown) => {
			if (key === "juruc" && Array.isArray(content) && typeof content[0] === "string")
				widgets.push(content[0]);
		},
		custom: async () => undefined,
	} as never;

	const createRuntime = async ({
		cwd,
		sessionManager,
		sessionStartEvent,
	}: {
		cwd: string;
		sessionManager: SessionManager;
		sessionStartEvent?: unknown;
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						const record: HarnessInstance = { instance: instances.length + 1, pi };
						instances.push(record);
						pi.registerProvider(provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((model) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							})),
						});
						for (const extension of options.beforeJuruc ?? []) extension(pi);
						for (const name of options.stubTools ?? [])
							pi.registerTool({
								name,
								label: name,
								description: `harness stub ${name}`,
								parameters: {
									type: "object",
									properties: {},
									additionalProperties: true,
								} as never,
								execute: async (_id: string, args: unknown) => ({
									content: [{ type: "text" as const, text: "" }],
									details: options.stubResult?.(name, args),
								}),
							});
						pi.on("session_start", (_event, ctx) => {
							record.startContext = ctx;
							record.rawManager = ctx.sessionManager;
							events.push(`start:${record.instance}`);
						});
						pi.on("session_shutdown", (event) => {
							events.push(`shutdown:${record.instance}:${event.reason}`);
						});
						juruc(pi);
						for (const extension of options.afterJuruc ?? []) extension(pi);
						options.probe?.(pi, record);
					},
				],
				additionalPromptTemplatePaths: [...options.promptTemplates],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent: sessionStartEvent as never,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime as never, {
		cwd: options.cwd,
		agentDir: options.agentDir,
		sessionManager: options.sessionManager,
	});

	const rebindSession = async (): Promise<void> => {
		const session = runtime.session;
		await session.bindExtensions({
			uiContext,
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (createOptions) => runtime.newSession(createOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, treeOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: treeOptions?.summarize,
						customInstructions: treeOptions?.customInstructions,
						replaceInstructions: treeOptions?.replaceInstructions,
						label: treeOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					if (cancelNextSwitch) {
						cancelNextSwitch = false;
						return { cancelled: true };
					}
					return runtime.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
		});
	};
	runtime.setRebindSession(async () => {
		await rebindSession();
	});
	await rebindSession();

	return {
		runtime,
		instances,
		events,
		notices,
		widgets,
		noteWithSession: (instance: number) => events.push(`with:${instance}`),
		setResponses: (responses: unknown[]) => faux.setResponses(responses as never),
		appendResponses: (responses: unknown[]) => faux.appendResponses(responses as never),
		cancelNextSwitch: () => { cancelNextSwitch = true; },
		selections,
		editorValues,
		confirmations,
		dispose: async () => {
			await runtime.dispose();
			faux.unregister();
		},
	};
}
