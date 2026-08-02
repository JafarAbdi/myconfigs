import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { sameSessionIdentity, type SessionIdentity } from "./state.ts";

interface CommandContextLease {
	context: ExtensionCommandContext;
	session: SessionIdentity;
}

interface PlanningPromptLease {
	args: string;
	prompt?: string;
	session: SessionIdentity;
}

export interface SettlementLease {
	task: string;
	session: SessionIdentity;
	action: "no-code completion" | "committing" | "recovery";
	token: symbol;
	authorizedTransfer?: {
		source: SessionIdentity;
		target: SessionIdentity;
		task: string;
		token: symbol;
		consumed: boolean;
	};
}

/** Exact task/phase identity of the canonical turn being authorized. */
export interface CanonicalTurnTarget {
	task: string;
	phase: string;
}

/** Exact task/phase/baseline binding an authorization is consumed against. */
export interface CanonicalTurnBinding extends CanonicalTurnTarget {
	baseline: string;
}

/**
 * One-use authorization for exactly one canonical `/commit-message` turn.
 *
 * `same-instance` never crosses a runtime boundary and carries the prompt its
 * own instance resolved. `replacement` survives the expected old
 * `session_shutdown(reason: "resume")` only: the fresh instance resolves the
 * canonical prompt, the disposed instance claims it, and the fresh
 * `message_start` consumes it.
 */
export type CanonicalTurnAuthorization =
	| (CanonicalTurnBinding & {
			kind: "same-instance";
			session: SessionIdentity;
			prompt: string;
			token: symbol;
		})
	| (CanonicalTurnTarget & {
			kind: "replacement";
			source: SessionIdentity;
			target: SessionIdentity;
			lease: symbol;
			step: "pending" | "resolved" | "claimed";
			baseline: string | null;
			prompt: string | null;
			token: symbol;
		});

const SETTLEMENT_KEY = Symbol.for("juruc.settlement-lease");
const LEASE_KEY = Symbol.for("juruc.command-context-lease");
const PROMPT_KEY = Symbol.for("juruc.planning-prompt-lease");
const CANONICAL_KEY = Symbol.for("juruc.canonical-turn-authorizations");
const processState = globalThis as typeof globalThis & {
	[SETTLEMENT_KEY]?: SettlementLease;
	[LEASE_KEY]?: CommandContextLease;
	[PROMPT_KEY]?: PlanningPromptLease;
	[CANONICAL_KEY]?: Map<string, CanonicalTurnAuthorization>;
};

function sessionKey(session: SessionIdentity): string {
	return `${session.path}\u0000${session.id}`;
}

function canonicalAuthorizations(): Map<string, CanonicalTurnAuthorization> {
	return processState[CANONICAL_KEY] ??= new Map();
}

function sameTarget(
	authorization: CanonicalTurnAuthorization,
	target: CanonicalTurnTarget,
): boolean {
	return authorization.task === target.task && authorization.phase === target.phase;
}

export function sessionContextIdentity(
	ctx: Pick<ExtensionContext, "sessionManager">,
): SessionIdentity | null {
	try {
		const path = ctx.sessionManager.getSessionFile();
		const header = ctx.sessionManager.getHeader();
		const id = ctx.sessionManager.getSessionId();
		return path && isAbsolute(path) && header?.id === id ? { path, id } : null;
	} catch {
		return null;
	}
}

export function retainCommandContext(
	context: ExtensionCommandContext,
	expected?: SessionIdentity,
): boolean {
	const session = sessionContextIdentity(context);
	if (!session || (expected && !sameSessionIdentity(session, expected))) {
		clearCommandContext();
		return false;
	}
	processState[LEASE_KEY] = { context, session };
	return true;
}

export function retainedCommandContext(
	expected: SessionIdentity,
): ExtensionCommandContext | undefined {
	const lease = processState[LEASE_KEY];
	if (!lease || !sameSessionIdentity(lease.session, expected)) return undefined;
	if (!sameSessionIdentity(sessionContextIdentity(lease.context), expected)) {
		if (processState[LEASE_KEY] === lease) clearCommandContext();
		return undefined;
	}
	return lease.context;
}

export function beginPlanningPrompt(session: SessionIdentity, args: string): void {
	processState[PROMPT_KEY] = { args, session: { ...session } };
}

export function pendingPlanningPromptArgs(
	session: SessionIdentity,
): string | undefined {
	const lease = processState[PROMPT_KEY];
	return lease && sameSessionIdentity(lease.session, session)
		? lease.args
		: undefined;
}

export function finishPlanningPrompt(
	session: SessionIdentity,
	prompt: string,
): void {
	const lease = processState[PROMPT_KEY];
	if (!lease || !sameSessionIdentity(lease.session, session))
		throw new Error("JURUC planning prompt request changed during activation");
	lease.prompt = prompt;
}

export function takePlanningPrompt(
	session: SessionIdentity,
): string | undefined {
	const lease = processState[PROMPT_KEY];
	if (!lease || !sameSessionIdentity(lease.session, session)) return undefined;
	delete processState[PROMPT_KEY];
	return lease.prompt;
}

export function clearPlanningPrompt(session: SessionIdentity): void {
	const lease = processState[PROMPT_KEY];
	if (lease && sameSessionIdentity(lease.session, session))
		delete processState[PROMPT_KEY];
}

export function acquireSettlementLease(
	task: string,
	session: SessionIdentity,
	action: SettlementLease["action"],
): SettlementLease | undefined {
	if (processState[SETTLEMENT_KEY]) return undefined;
	const lease: SettlementLease = {
		task,
		session: { ...session },
		action,
		token: Symbol("juruc-settlement"),
	};
	processState[SETTLEMENT_KEY] = lease;
	return lease;
}

export function settlementLease(session?: SessionIdentity | null): Omit<SettlementLease, "token"> | undefined {
	const lease = processState[SETTLEMENT_KEY];
	if (!lease || (session && !sameSessionIdentity(lease.session, session))) return undefined;
	return { task: lease.task, session: { ...lease.session }, action: lease.action };
}

export function settlementLeaseMatches(
	token: symbol,
	task: string,
	session: SessionIdentity,
): boolean {
	const lease = processState[SETTLEMENT_KEY];
	return Boolean(
		lease && lease.token === token && lease.task === task &&
		sameSessionIdentity(lease.session, session),
	);
}

export function transferSettlementLease(
	lease: SettlementLease,
	source: SessionIdentity,
	target: SessionIdentity,
): void {
	const current = processState[SETTLEMENT_KEY];
	if (current?.token !== lease.token || current.task !== lease.task)
		throw new Error("settlement lease changed before session transfer");
	current.session = { ...target };
	current.authorizedTransfer = {
		source: { ...source },
		target: { ...target },
		task: current.task,
		token: current.token,
		consumed: false,
	};
}

export function consumeSettlementTarget(
	source: SessionIdentity | null,
	targetSessionFile: string | undefined,
): "allowed" | "blocked" | "none" {
	const lease = processState[SETTLEMENT_KEY];
	const transfer = lease?.authorizedTransfer;
	if (!lease || !transfer) return "none";
	if (transfer.consumed || !source || !targetSessionFile ||
		transfer.token !== lease.token || transfer.task !== lease.task ||
		!sameSessionIdentity(transfer.source, source) ||
		transfer.target.path !== targetSessionFile)
		return "blocked";
	transfer.consumed = true;
	return "allowed";
}

export function releaseSettlementLease(lease: SettlementLease): void {
	if (processState[SETTLEMENT_KEY]?.token === lease.token)
		delete processState[SETTLEMENT_KEY];
}

export function clearSettlementLease(session: SessionIdentity): void {
	const lease = processState[SETTLEMENT_KEY];
	if (lease && sameSessionIdentity(lease.session, session))
		delete processState[SETTLEMENT_KEY];
}

export function clearCommandContext(): void {
	delete processState[LEASE_KEY];
}

export function canonicalTurnAuthorization(session?: SessionIdentity): CanonicalTurnAuthorization | undefined {
	const authorizations = canonicalAuthorizations();
	return session ? authorizations.get(sessionKey(session)) :
		authorizations.size === 1 ? authorizations.values().next().value : undefined;
}

export function beginSameInstanceCanonicalTurn(
	binding: CanonicalTurnBinding,
	session: SessionIdentity,
	prompt: string,
): symbol {
	const token = Symbol("juruc-canonical-turn");
	const authorizations = canonicalAuthorizations();
	const key = sessionKey(session);
	if (authorizations.has(key))
		throw new Error("canonical authorization already exists for the target session");
	authorizations.set(key, {
		...binding,
		kind: "same-instance",
		session: { ...session },
		prompt,
		token,
	});
	return token;
}

export function beginReplacementCanonicalTurn(
	target: CanonicalTurnTarget,
	source: SessionIdentity,
	destination: SessionIdentity,
	lease: SettlementLease,
): symbol {
	const token = Symbol("juruc-canonical-turn");
	const authorizations = canonicalAuthorizations();
	const key = sessionKey(destination);
	if (authorizations.has(key))
		throw new Error("canonical authorization already exists for the target session");
	authorizations.set(key, {
		...target,
		kind: "replacement",
		source: { ...source },
		target: { ...destination },
		lease: lease.token,
		step: "pending",
		baseline: null,
		prompt: null,
		token,
	});
	return token;
}

/**
 * Records the baseline and canonical prompt the fresh destination instance owns.
 * Any target mismatch clears the authorization instead of adapting to it.
 */
export function resolveReplacementCanonicalTurn(
	binding: CanonicalTurnBinding,
	destination: SessionIdentity,
	prompt: string,
): boolean {
	const authorizations = canonicalAuthorizations();
	const key = sessionKey(destination);
	const authorization = authorizations.get(key);
	if (!authorization || authorization.kind !== "replacement") return false;
	if (
		authorization.step !== "pending" || !sameTarget(authorization, binding) ||
		!sameSessionIdentity(authorization.target, destination)
	) {
		authorizations.delete(key);
		return false;
	}
	authorization.step = "resolved";
	authorization.baseline = binding.baseline;
	authorization.prompt = prompt;
	return true;
}

/** Claims—but does not consume—the exact replacement text in the disposed closure. */
export function claimReplacementCanonicalTurn(
	target: CanonicalTurnTarget,
	source: SessionIdentity,
	destination: SessionIdentity,
	lease: SettlementLease,
): { baseline: string; prompt: string } | undefined {
	const authorizations = canonicalAuthorizations();
	const key = sessionKey(destination);
	const authorization = authorizations.get(key);
	if (!authorization || authorization.kind !== "replacement") return undefined;
	if (
		authorization.step !== "resolved" || authorization.baseline === null ||
		authorization.prompt === null || !sameTarget(authorization, target) ||
		!sameSessionIdentity(authorization.source, source) ||
		!sameSessionIdentity(authorization.target, destination) ||
		authorization.lease !== lease.token
	) {
		authorizations.delete(key);
		return undefined;
	}
	authorization.step = "claimed";
	return { baseline: authorization.baseline, prompt: authorization.prompt };
}

/** Atomically validates and consumes the matching authorization in fresh `message_start`. */
export function consumeCanonicalTurn(
	binding: CanonicalTurnBinding,
	session: SessionIdentity,
	prompt: string,
): CanonicalTurnAuthorization["kind"] | undefined {
	const authorizations = canonicalAuthorizations();
	const authorization = authorizations.get(sessionKey(session));
	if (
		!authorization || !sameTarget(authorization, binding) ||
		authorization.baseline !== binding.baseline || authorization.prompt !== prompt
	) return undefined;
	if (authorization.kind === "same-instance") {
		if (!sameSessionIdentity(authorization.session, session)) return undefined;
	} else if (
		authorization.step !== "claimed" || !sameSessionIdentity(authorization.target, session)
	) {
		return undefined;
	}
	authorizations.delete(sessionKey(session));
	return authorization.kind;
}

export function clearCanonicalTurn(token?: symbol): void {
	const authorizations = canonicalAuthorizations();
	for (const [key, authorization] of authorizations)
		if (token === undefined || authorization.token === token) authorizations.delete(key);
}

/**
 * Session shutdown clears every authorization except the exact pending
 * replacement transfer leaving its own source session.
 */
export function clearCanonicalTurnOnShutdown(
	session: SessionIdentity | null,
	reason: string,
): void {
	if (!session) return;
	const authorizations = canonicalAuthorizations();
	for (const [key, authorization] of authorizations) {
		const ownsSource = authorization.kind === "replacement" &&
			sameSessionIdentity(authorization.source, session);
		const ownsTarget = sameSessionIdentity(
			authorization.kind === "replacement" ? authorization.target : authorization.session,
			session,
		);
		if (reason === "resume" && ownsSource && authorization.kind === "replacement" && authorization.step === "pending")
			continue;
		if (ownsSource || ownsTarget) authorizations.delete(key);
	}
}
