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

/** Recorded in `widgets` when JURUC clears its widget, so tests can assert the clear. */
export const CLEARED_WIDGET = "(cleared)";

export interface HarnessInstance {
	instance: number;
	pi: ExtensionAPI;
	startContext?: ExtensionContext;
	cwd?: string;
	activeTools?: string[];
	toolActivations: string[][];
	rawManager?: unknown;
}

export interface HarnessOptions {
	agentDir: string;
	cwd: string;
	sessionManager: SessionManager;
	/** Absolute prompt-template files exposed through `pi.getCommands()`. */
	promptTemplates: readonly string[];
	/** Extra tool names registered as stubs so JURUC profiles can activate. */
	stubTools?: readonly string[];
	/** Tool names hidden from JURUC registration checks. */
	omitTools?: readonly string[];
	/** Result `details` a stub tool returns, letting tests supply delegate payloads. */
	stubResult?: (name: string, args: unknown) => unknown;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	input?: (title: string) => Promise<string | undefined>;
	editor?: (title: string) => Promise<string | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
	/** Extension bind mode; `tui` exercises terminal-only UI such as factory widgets. */
	mode?: "tui" | "rpc";
	/** Resolves the TUI custom components, such as the picker, without a terminal. */
	custom?: () => Promise<unknown>;
	/** Override JURUC registration for injected workflow dependencies in tests. */
	registerJuruc?: (pi: ExtensionAPI) => void;
	/** Width used to render factory widgets; defaults to a normal terminal. */
	widgetWidth?: number;
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
	/** The text JURUC left in the core input editor. */
	getEditorText: () => string;
	/** Types into the editor, so tests can prove JURUC never overwrites a draft. */
	setEditorText: (text: string) => void;
	/** Presses Enter: submits the editor's exact text and clears it, as the TUI does. */
	submitEditor: () => Promise<void>;
	/** Records `with:N` for the instance whose closure is running the callback. */
	noteWithSession: (instance: number) => void;
	setResponses: (responses: unknown[]) => void;
	appendResponses: (responses: unknown[]) => void;
	cancelNextSwitch: () => void;
	selections: string[];
	inputValues: Array<string | undefined>;
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
	const inputValues: Array<string | undefined> = [];
	const editorValues: Array<string | undefined> = [];
	const confirmations: boolean[] = [];
	const widgetWidth = options.widgetWidth ?? 80;
	let cancelNextSwitch = false;
	let editorText = "";

	const uiContext = {
		select: options.select ?? (async () => selections.shift()),
		confirm: options.confirm ?? (async () => confirmations.shift() ?? false),
		input: options.input ?? (async () => inputValues.shift()),
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
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
		setWidget: (key: string, content: unknown) => {
			if (key !== "juruc") return;
			if (content === undefined) {
				widgets.push(CLEARED_WIDGET);
				return;
			}
			if (Array.isArray(content)) {
				if (typeof content[0] === "string") widgets.push(content[0]);
				return;
			}
			// Factory widgets are rendered exactly as the TUI renders them, at a fixed width,
			// against an identity theme so the assertions stay plain text.
			if (typeof content !== "function") return;
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
			const component = (content as (tui: unknown, theme: unknown) => {
				render(width: number): string[];
			})({}, theme);
			const [line] = component.render(widgetWidth);
			if (typeof line === "string") widgets.push(line);
		},
		custom: options.custom ?? (async () => undefined),
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
						const record: HarnessInstance = {
							instance: instances.length + 1,
							pi,
							toolActivations: [],
						};
						instances.push(record);
						const setActiveTools = pi.setActiveTools.bind(pi);
						pi.setActiveTools = (names) => {
							record.toolActivations.push([...names]);
							setActiveTools(names);
						};
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
						if (options.omitTools?.length) {
							const omitted = new Set(options.omitTools);
							const getAllTools = pi.getAllTools.bind(pi);
							pi.getAllTools = () => getAllTools().filter(({ name }) => !omitted.has(name));
						}
						pi.on("session_start", (_event, ctx) => {
							record.startContext = ctx;
							record.cwd = ctx.cwd;
							record.rawManager = ctx.sessionManager;
							events.push(`start:${record.instance}`);
						});
						pi.on("session_shutdown", (event) => {
							events.push(`shutdown:${record.instance}:${event.reason}`);
						});
						(options.registerJuruc ?? juruc)(pi);
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
			mode: options.mode ?? "rpc",
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
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
		submitEditor: async () => {
			const submitted = editorText;
			if (!submitted.trim()) throw new Error("the editor is empty; nothing to submit");
			editorText = "";
			await runtime.session.prompt(submitted);
		},
		noteWithSession: (instance: number) => events.push(`with:${instance}`),
		setResponses: (responses: unknown[]) => faux.setResponses(responses as never),
		appendResponses: (responses: unknown[]) => faux.appendResponses(responses as never),
		cancelNextSwitch: () => { cancelNextSwitch = true; },
		selections,
		inputValues,
		editorValues,
		confirmations,
		dispose: async () => {
			await runtime.dispose();
			faux.unregister();
		},
	};
}
