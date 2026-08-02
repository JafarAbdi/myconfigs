import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	acquireSettlementLease,
	beginPlanningPrompt,
	beginReplacementCanonicalTurn,
	beginSameInstanceCanonicalTurn,
	canonicalTurnAuthorization,
	claimReplacementCanonicalTurn,
	clearCanonicalTurn,
	clearCanonicalTurnOnShutdown,
	consumeCanonicalTurn,
	resolveReplacementCanonicalTurn,
	clearCommandContext,
	clearPlanningPrompt,
	clearSettlementLease,
	consumeSettlementTarget,
	finishPlanningPrompt,
	pendingPlanningPromptArgs,
	retainCommandContext,
	releaseSettlementLease,
	retainedCommandContext,
	sessionContextIdentity,
	settlementLease,
	takePlanningPrompt,
	transferSettlementLease,
} from "./lease.ts";

function context(
	path: string,
	id: string,
): {
	context: ExtensionCommandContext;
	setHeaderId(value: string): void;
	makeStale(): void;
} {
	let headerId = id;
	let stale = false;
	const sessionManager = {
		getSessionFile: () => path,
		getHeader: () => ({ id: headerId }),
		getSessionId: () => id,
	};
	const value = {
		get sessionManager() {
			if (stale) throw new Error("stale context");
			return sessionManager;
		},
	} as unknown as ExtensionCommandContext;
	return {
		context: value,
		setHeaderId: (next) => {
			headerId = next;
		},
		makeStale: () => {
			stale = true;
		},
	};
}

const session = { path: "/tmp/juruc-session.jsonl", id: "session-one" };
const first = context(session.path, session.id);
assert.deepEqual(sessionContextIdentity(first.context), session);
assert.equal(retainCommandContext(first.context, session), true);
assert.equal(retainedCommandContext(session), first.context);
beginPlanningPrompt(session, "current request");
assert.equal(pendingPlanningPromptArgs(session), "current request");
const reloadModulePath: string = "./lease.ts?reload-test";
const reloadedLeaseModule = await import(reloadModulePath);
assert.equal(
	reloadedLeaseModule.retainedCommandContext(session),
	first.context,
	"the process lease survives extension module reload",
);
assert.equal(
	reloadedLeaseModule.pendingPlanningPromptArgs(session),
	"current request",
	"the pending prompt survives extension module reload",
);
assert.equal(
	pendingPlanningPromptArgs({ ...session, id: "replacement" }),
	undefined,
);
finishPlanningPrompt(session, "canonical body");
assert.equal(takePlanningPrompt(session), "canonical body");
assert.equal(takePlanningPrompt(session), undefined, "planning prompts are one-use");
beginPlanningPrompt(session, "cancelled request");
clearPlanningPrompt(session);
assert.equal(pendingPlanningPromptArgs(session), undefined);

const secondSession = {
	path: "/tmp/juruc-replacement.jsonl",
	id: "session-two",
};
const second = context(secondSession.path, secondSession.id);
assert.equal(retainCommandContext(second.context, secondSession), true);
assert.equal(
	retainedCommandContext(session),
	undefined,
	"a lease cannot be used for another session",
);
assert.equal(
	retainedCommandContext(secondSession),
	second.context,
	"a stale claim cannot clear a newer session lease",
);

assert.equal(retainCommandContext(first.context, session), true);
first.setHeaderId("changed-header");
assert.equal(
	retainedCommandContext(session),
	undefined,
	"header identity is revalidated when the lease is claimed",
);

const stale = context(session.path, session.id);
assert.equal(retainCommandContext(stale.context, session), true);
stale.makeStale();
assert.equal(
	retainedCommandContext(session),
	undefined,
	"a stale Pi context is rejected without running it",
);

const wrong = context(secondSession.path, secondSession.id);
assert.equal(retainCommandContext(wrong.context, session), false);
assert.equal(retainedCommandContext(session), undefined);
clearCommandContext();

const settlement = acquireSettlementLease("task", session, "committing");
if (!settlement) throw new Error("expected settlement lease");
assert.deepEqual(settlementLease(session), {
	task: "task",
	session,
	action: "committing",
});
assert.equal(acquireSettlementLease("task", session, "committing"), undefined, "settlement is exclusive");
assert.equal(settlementLease(secondSession), undefined, "settlement belongs only to its exact session");
releaseSettlementLease({ ...settlement, token: Symbol("wrong") });
assert.ok(settlementLease(session), "a foreign token cannot release settlement");
releaseSettlementLease(settlement);
assert.equal(settlementLease(session), undefined);
const recovery = acquireSettlementLease("task", session, "recovery");
if (!recovery) throw new Error("expected recovery lease");
assert.equal(settlementLease(session)?.action, "recovery");
clearSettlementLease(secondSession);
assert.ok(settlementLease(session), "replacement-session shutdown cannot clear another session's recovery");
transferSettlementLease(recovery, session, secondSession);
assert.deepEqual(settlementLease(secondSession)?.session, secondSession);
assert.equal(
	consumeSettlementTarget({ ...session, id: "foreign-source" }, secondSession.path),
	"blocked",
	"a foreign source cannot consume an exact target transfer",
);
assert.equal(consumeSettlementTarget(session, secondSession.path), "allowed");
assert.equal(consumeSettlementTarget(session, secondSession.path), "blocked", "target authorization is one-use");
clearSettlementLease(secondSession);
assert.equal(settlementLease(), undefined, "reload/quit cleanup clears the exact process-global lease");

const target = { task: "task", phase: "P1" };
const binding = { ...target, baseline: "leaf-1" };
const prompt = "Return the canonical commit message.\n";

beginSameInstanceCanonicalTurn(binding, session, prompt);
assert.equal(
	consumeCanonicalTurn(binding, secondSession, prompt),
	undefined,
	"a same-instance authorization belongs only to its own session",
);
assert.equal(
	consumeCanonicalTurn({ ...binding, baseline: "leaf-2" }, session, prompt),
	undefined,
	"a same-instance authorization is bound to its exact baseline",
);
assert.equal(consumeCanonicalTurn(binding, session, "other prompt"), undefined);
assert.equal(consumeCanonicalTurn(binding, session, prompt), "same-instance");
assert.equal(consumeCanonicalTurn(binding, session, prompt), undefined, "canonical turns are one-use");

const settling = acquireSettlementLease("task", session, "recovery");
assert.ok(settling);
beginReplacementCanonicalTurn(target, session, secondSession, settling);
assert.equal(
	claimReplacementCanonicalTurn(target, session, secondSession, settling),
	undefined,
	"an unresolved replacement authorization cannot be claimed",
);
beginReplacementCanonicalTurn(target, session, secondSession, settling);
assert.equal(
	resolveReplacementCanonicalTurn(binding, session, prompt),
	false,
	"only the destination session resolves the canonical prompt",
);
assert.ok(canonicalTurnAuthorization(secondSession), "a wrong destination cannot inspect another session authorization");
clearCanonicalTurn();

beginReplacementCanonicalTurn(target, session, secondSession, settling);
assert.equal(resolveReplacementCanonicalTurn(binding, secondSession, prompt), true);
assert.equal(
	claimReplacementCanonicalTurn(target, secondSession, secondSession, settling),
	undefined,
	"only the exact source session claims the replacement text",
);
beginReplacementCanonicalTurn(target, session, secondSession, settling);
resolveReplacementCanonicalTurn(binding, secondSession, prompt);
assert.equal(
	consumeCanonicalTurn(binding, secondSession, prompt),
	undefined,
	"an unclaimed replacement authorization cannot be consumed",
);
assert.deepEqual(
	claimReplacementCanonicalTurn(target, session, secondSession, settling),
	{ baseline: binding.baseline, prompt },
	"the disposed closure claims the fresh instance's exact baseline and prompt",
);
clearCanonicalTurnOnShutdown(session, "resume");
assert.equal(
	canonicalTurnAuthorization(),
	undefined,
	"a claimed transfer does not outlive another source shutdown",
);

beginReplacementCanonicalTurn(target, session, secondSession, settling);
clearCanonicalTurnOnShutdown(session, "resume");
assert.ok(
	canonicalTurnAuthorization(),
	"the pending transfer survives its own expected resume shutdown",
);
clearCanonicalTurnOnShutdown(secondSession, "resume");
assert.equal(
	canonicalTurnAuthorization(),
	undefined,
	"destination shutdown before recognition clears the transfer",
);
for (const reason of ["reload", "quit", "new", "fork"]) {
	beginReplacementCanonicalTurn(target, session, secondSession, settling);
	clearCanonicalTurnOnShutdown(session, reason);
	assert.equal(canonicalTurnAuthorization(), undefined, `${reason} clears the transfer`);
}
beginSameInstanceCanonicalTurn(binding, session, prompt);
clearCanonicalTurnOnShutdown(session, "resume");
assert.equal(
	canonicalTurnAuthorization(),
	undefined,
	"a same-instance authorization never crosses a replacement",
);
beginSameInstanceCanonicalTurn(binding, session, prompt);
clearCanonicalTurn(Symbol("foreign"));
assert.ok(canonicalTurnAuthorization(), "a foreign token cannot clear an authorization");
clearCanonicalTurn();
assert.equal(canonicalTurnAuthorization(), undefined);
releaseSettlementLease(settling);

const thirdSession = { path: "/tmp/juruc-third.jsonl", id: "session-three" };
const thirdBinding = { task: "task-three", phase: "P1", baseline: "leaf-three" };
const fourthBinding = { task: "task-four", phase: "P1", baseline: "leaf-four" };
const thirdPrompt = "third canonical prompt";
const fourthPrompt = "fourth canonical prompt";
beginSameInstanceCanonicalTurn(thirdBinding, thirdSession, thirdPrompt);
beginSameInstanceCanonicalTurn(fourthBinding, secondSession, fourthPrompt);
assert.equal(canonicalTurnAuthorization(thirdSession)?.task, "task-three");
assert.equal(canonicalTurnAuthorization(secondSession)?.task, "task-four");
assert.equal(consumeCanonicalTurn(thirdBinding, thirdSession, thirdPrompt), "same-instance");
assert.equal(canonicalTurnAuthorization(secondSession)?.task, "task-four", "independent session authorization survives another turn");
assert.equal(consumeCanonicalTurn(fourthBinding, secondSession, fourthPrompt), "same-instance");

console.log("juruc command-context lease: ok");
