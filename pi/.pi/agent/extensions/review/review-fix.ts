import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
	AddWiffReplyOptions,
	ResolveWiffCommentOptions,
	WiffComment,
	WiffPinnedOptions,
	WiffState,
} from "./review-wiff.ts";

export const WIFF_RESOLVE_TOOL = "wiff_resolve";

const WIFF_RESOLVE_AUTHOR = "pi-review";
const MAX_REPLY_LENGTH = 4_096;

export interface FixTurn {
	readonly prompt: string;
	readonly target: Omit<WiffPinnedOptions, "signal">;
}

export interface WiffResolveDependencies {
	readWiffState(options: WiffPinnedOptions): Promise<WiffState>;
	addWiffReply(options: AddWiffReplyOptions): Promise<void>;
	resolveWiffComment(options: ResolveWiffCommentOptions): Promise<void>;
}

export interface WiffResolveController {
	arm(turn: FixTurn): void;
	clear(): void;
}

function copyTurn(turn: FixTurn): FixTurn {
	const { repositoryRoot, wiffDataDir, session, project } = turn.target;
	return {
		prompt: turn.prompt,
		target: { repositoryRoot, wiffDataDir, session, project },
	};
}

function findComment(state: WiffState, reference: string): WiffComment | undefined {
	return state.comments.find((comment) => comment.id === reference)
		?? state.comments.find((comment) => String(comment.number) === reference);
}

function requireLiveComment(comment: WiffComment | undefined, reference: string): WiffComment {
	if (!comment) throw new Error(`Unknown Wiff comment ${JSON.stringify(reference)}`);
	if (comment.deleted) throw new Error(`Wiff comment ${comment.id} is deleted`);
	if (comment.resolved) throw new Error(`Wiff comment ${comment.id} is already resolved`);
	return comment;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function latestUserPrompt(messages: ContextEvent["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (!Array.isArray(message.content)) return message.content;
		return message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
	}
	return undefined;
}

/** Registers the normally inactive resolver used only by one armed `/review fix` invocation. */
export function registerWiffResolveTool(
	pi: ExtensionAPI,
	dependencies: WiffResolveDependencies,
): WiffResolveController {
	let pending: FixTurn | undefined;
	let active: FixTurn | undefined;
	let deferred = false;
	const queuedDifferentPrompts = new Set<string>();

	const removeTool = (): void => {
		const current = pi.getActiveTools();
		if (current.includes(WIFF_RESOLVE_TOOL))
			pi.setActiveTools(current.filter((name) => name !== WIFF_RESOLVE_TOOL));
	};
	const addTool = (): void => {
		const current = pi.getActiveTools();
		if (!current.includes(WIFF_RESOLVE_TOOL))
			pi.setActiveTools([...current, WIFF_RESOLVE_TOOL]);
	};
	const clear = (): void => {
		pending = undefined;
		active = undefined;
		deferred = false;
		queuedDifferentPrompts.clear();
		removeTool();
	};

	pi.registerTool({
		name: WIFF_RESOLVE_TOOL,
		label: "Resolve Wiff comment",
		description:
			"Resolve one live Wiff review comment only after completely addressing it, optionally adding an exact reply first.",
		parameters: Type.Object({
			comment: Type.String({
				description: "Displayed decimal comment number or exact durable comment ID.",
			}),
			reply: Type.Optional(Type.String({
				maxLength: MAX_REPLY_LENGTH,
				description: "Optional concise explanation to add before resolving the comment.",
			})),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, parameters, signal) {
			const invocation = active;
			if (!invocation)
				throw new Error(`${WIFF_RESOLVE_TOOL} is available only during the active /review fix invocation`);
			if (parameters.reply !== undefined) {
				if (!parameters.reply.trim()) throw new Error("Wiff resolution reply must not be blank");
				if (parameters.reply.length > MAX_REPLY_LENGTH)
					throw new Error(`Wiff resolution reply exceeds ${MAX_REPLY_LENGTH} characters`);
			}

			const target: WiffPinnedOptions = { ...invocation.target, signal };
			let state = await dependencies.readWiffState(target);
			const comment = requireLiveComment(findComment(state, parameters.comment), parameters.comment);
			let replyAdded = false;
			try {
				if (parameters.reply !== undefined) {
					await dependencies.addWiffReply({
						...target,
						author: WIFF_RESOLVE_AUTHOR,
						commentId: comment.id,
						body: parameters.reply,
					});
					replyAdded = true;
					state = await dependencies.readWiffState(target);
					requireLiveComment(
						state.comments.find((candidate) => candidate.id === comment.id),
						comment.id,
					);
				}

				await dependencies.resolveWiffComment({
					...target,
					author: WIFF_RESOLVE_AUTHOR,
					commentId: comment.id,
				});
				state = await dependencies.readWiffState(target);
				const resolved = state.comments.find((candidate) => candidate.id === comment.id);
				if (!resolved?.resolved)
					throw new Error(`Wiff did not report comment ${comment.id} as resolved`);
			} catch (error) {
				if (!replyAdded) throw error;
				throw new Error(
					`Reply was added to Wiff comment ${comment.id}, but resolution was not verified: ${errorMessage(error)}`,
					{ cause: error },
				);
			}

			const remaining = state.comments.filter(
				(candidate) =>
					!candidate.deleted &&
					!candidate.resolved &&
					candidate.target.target !== "comment",
			).length;
			return {
				content: [{
					type: "text",
					text: `Resolved Wiff comment ${comment.id}. Remaining unresolved top-level comments: ${remaining}.`,
				}],
				details: { commentId: comment.id, remaining },
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		if (pending && event.prompt === pending.prompt) {
			active = pending;
			pending = undefined;
			queuedDifferentPrompts.clear();
			addTool();
			return;
		}
		clear();
	});
	pi.on("input", (event, ctx) => {
		if (
			pending && event.source === "extension" && event.text === pending.prompt &&
			!ctx.isIdle()
		) {
			deferred = true;
			return { action: "handled" as const };
		}
		if (active && event.streamingBehavior !== undefined && event.text !== active.prompt)
			queuedDifferentPrompts.add(event.text);
	});
	pi.on("context", (event, ctx) => {
		if (!active || queuedDifferentPrompts.size === 0) return;
		const latestPrompt = latestUserPrompt(event.messages);
		if (latestPrompt === active.prompt) return;
		if (latestPrompt !== undefined && queuedDifferentPrompts.has(latestPrompt)) {
			clear();
			return;
		}
		if (!ctx.hasPendingMessages()) clear();
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (pending && deferred) {
			deferred = false;
			pi.sendUserMessage(pending.prompt);
			return;
		}
		clear();
	});
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);

	return {
		arm(turn) {
			clear();
			pending = copyTurn(turn);
		},
		clear,
	};
}
