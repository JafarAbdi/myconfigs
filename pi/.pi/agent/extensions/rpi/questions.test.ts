import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
	EMPTY_QUESTION_STORE,
	answerQuestion,
	parseQuestionStore,
	questionAnswerSchema,
	questionInputSchema,
	questionStoreSchema,
	serializeQuestionStore,
	type QuestionInput,
	type QuestionStore,
	updateDesignQuestions,
	updateDesignQuestionsSchema,
	validateQuestionInput,
	validateQuestionStore,
} from "./questions.ts";

const input = (title = "Cache ownership"): QuestionInput => ({
	title,
	question: "Which layer should own the cache?",
	options: ["The adapter", "The caller"],
	recommended_option: 1,
	recommendation: "The adapter already owns the remote lifecycle.",
});
const update = (store: QuestionStore, questions: QuestionInput[], ids: string[] = []) =>
	updateDesignQuestions(store, { incorporated_question_ids: ids, questions });

assert.equal(Check(questionInputSchema, input()), true);
assert.equal(Check(questionInputSchema, { ...input(), extra: true }), false);
assert.equal(Check(questionStoreSchema, EMPTY_QUESTION_STORE), true);
assert.equal(
	(updateDesignQuestionsSchema.properties.questions as { maxItems?: number }).maxItems,
	undefined,
	"the lifecycle tool must not cap question count",
);
assert.equal(
	(updateDesignQuestionsSchema as unknown as { additionalProperties: boolean })
		.additionalProperties,
	false,
);
assert.equal(
	Check(updateDesignQuestionsSchema, {
		task_slug: "cache-policy",
		incorporated_question_ids: [],
		questions: [],
	}),
	true,
	"the schema describes shape; semantic validation rejects an empty operation",
);
assert.throws(() => update(EMPTY_QUESTION_STORE, []), /at least one operation/);

const one = update(EMPTY_QUESTION_STORE, [input()]);
assert.deepEqual(one.questions[0], {
	id: "Q1",
	...input(),
	status: "open",
	answer: null,
});
const manyInputs = Array.from({ length: 100 }, (_, index) => input(`Decision ${index + 1}`));
const many = update(EMPTY_QUESTION_STORE, manyInputs);
assert.equal(many.questions.length, 100);
assert.equal(many.questions[99].id, "Q100");
assert.equal(EMPTY_QUESTION_STORE.questions.length, 0, "mutation is pure");

const invalidMember = { ...input("Broken"), options: ["Only one"] };
assert.throws(
	() => update(EMPTY_QUESTION_STORE, [input("Valid"), invalidMember]),
	/exact input schema/,
);
assert.deepEqual(EMPTY_QUESTION_STORE, { version: 1, questions: [] });
assert.deepEqual(validateQuestionInput({ ...input(), options: ["same", "same"] }), [
	"duplicate option 2 (matches option 1)",
]);
assert.deepEqual(validateQuestionInput({ ...input(), recommended_option: 3 }), [
	"recommended_option 3 exceeds 2 options",
]);
assert.match(
	validateQuestionInput({ ...input(), title: " padded " }).join("\n"),
	/surrounding whitespace/,
);
assert.match(
	validateQuestionInput({ ...input(), question: "two\nlines" }).join("\n"),
	/single line/,
);
assert.match(
	validateQuestionInput({ ...input(), recommendation: "bad\u0085value" }).join("\n"),
	/control characters/,
);

const twentySix = input("Twenty six");
twentySix.options = Array.from({ length: 26 }, (_, index) => `Choice ${index + 1}`);
twentySix.recommended_option = 26;
assert.equal(update(EMPTY_QUESTION_STORE, [twentySix]).questions[0].options.length, 26);
assert.equal(Check(questionInputSchema, { ...twentySix, options: [...twentySix.options, "27"] }), false);

const encoded = serializeQuestionStore(one);
assert.equal(encoded, `${JSON.stringify(one, null, 2)}\n`);
assert.deepEqual(parseQuestionStore(encoded), one);
assert.throws(() => parseQuestionStore("not JSON"), /invalid questions JSON/);
assert.throws(() => parseQuestionStore('{"version":1,"questions":[],"extra":1}'), /exact version-1/);
assert.throws(() => parseQuestionStore('{"version":2,"questions":[]}'), /exact version-1/);
assert.throws(() => parseQuestionStore("[]"), /exact version-1/);

for (const malformed of [
	{ ...one, questions: [{ ...one.questions[0], id: "Q2" }] },
	{ ...one, questions: [{ ...one.questions[0], id: "Q01" }] },
	{ ...one, questions: [{ ...one.questions[0], status: "answered", answer: null }] },
	{ ...one, questions: [{ ...one.questions[0], status: "open", answer: { kind: "option", option: 1 } }] },
	{ ...one, questions: [{ ...one.questions[0], status: "resolved" }] },
	{ ...one, questions: [{ ...one.questions[0], extra: true }] },
]) {
	assert.notDeepEqual(validateQuestionStore(malformed), [], JSON.stringify(malformed));
}
assert.equal(Check(questionAnswerSchema, { kind: "option", option: 1 }), true);
assert.equal(Check(questionAnswerSchema, { kind: "free_text", text: "Other" }), true);
assert.equal(Check(questionAnswerSchema, { kind: "option", option: 1, text: "mixed" }), false);

const optionAnswered = answerQuestion(one, "Q1", { kind: "option", option: 2 });
assert.deepEqual(optionAnswered.questions[0].answer, { kind: "option", option: 2 });
assert.equal(optionAnswered.questions[0].status, "answered");
assert.equal(one.questions[0].status, "open", "answer transition is pure");
const freeTextAnswered = answerQuestion(one, "Q1", {
	kind: "free_text",
	text: "  The repository owner decides  ",
});
assert.deepEqual(freeTextAnswered.questions[0].answer, {
	kind: "free_text",
	text: "The repository owner decides",
});
const multilineAnswered = answerQuestion(one, "Q1", {
	kind: "free_text",
	text: "  Use retries.\nStop after three failures.  ",
});
assert.deepEqual(multilineAnswered.questions[0].answer, {
	kind: "free_text",
	text: "Use retries.\nStop after three failures.",
});
assert.deepEqual(validateQuestionStore(multilineAnswered), []);
assert.throws(
	() => answerQuestion(one, "Q1", { kind: "free_text", text: "   " }),
	/answer text must not be empty/,
);
assert.throws(() => answerQuestion(one, "Q1", { kind: "option", option: 3 }), /exceeds 2 options/);
assert.throws(() => answerQuestion(one, "Q9", { kind: "option", option: 1 }), /unknown/);
assert.equal(
	answerQuestion(optionAnswered, "Q1", { kind: "option", option: 2 }),
	optionAnswered,
	"an exact answer retry is idempotent",
);
assert.throws(
	() => answerQuestion(optionAnswered, "Q1", { kind: "option", option: 1 }),
	/immutable answer/,
);

const incorporated = update(optionAnswered, [], ["Q1"]);
assert.equal(incorporated.questions[0].status, "incorporated");
assert.deepEqual(incorporated.questions[0].answer, { kind: "option", option: 2 });
assert.deepEqual(update(incorporated, [], ["Q1"]), incorporated);
assert.throws(() => update(one, [], ["Q1"]), /has not been answered/);
assert.throws(() => update(one, [], ["Q9"]), /unknown question/);
assert.throws(() => update(optionAnswered, [], ["Q1", "Q1"]), /duplicate incorporated/);

assert.deepEqual(update(one, [input()]), one, "an exact repeated submission is a no-op");
const reorderedInput: QuestionInput = {
	recommendation: input().recommendation,
	recommended_option: input().recommended_option,
	options: input().options,
	question: input().question,
	title: input().title,
};
assert.deepEqual(
	update(one, [reorderedInput]),
	one,
	"idempotency must not depend on JSON property order",
);
assert.throws(
	() => update(one, [{ ...input(), question: "A conflicting question" }]),
	/conflicting duplicate title/,
);
assert.equal(update(EMPTY_QUESTION_STORE, [input(), input()]).questions.length, 1);
assert.throws(
	() => update(EMPTY_QUESTION_STORE, [input(), { ...input(), recommendation: "Conflict" }]),
	/conflicting duplicate title/,
);

const acknowledgedAndAdded = update(optionAnswered, [input("Eviction timing")], ["Q1"]);
assert.deepEqual(
	acknowledgedAndAdded.questions.map(({ id, status }) => ({ id, status })),
	[
		{ id: "Q1", status: "incorporated" },
		{ id: "Q2", status: "open" },
	],
);
assert.deepEqual(acknowledgedAndAdded.questions[0].answer, optionAnswered.questions[0].answer);
assert.equal(acknowledgedAndAdded.questions[0].title, one.questions[0].title);

const duplicateTitles: QuestionStore = {
	version: 1,
	questions: [
		one.questions[0],
		{ ...one.questions[0], id: "Q2" },
	],
};
assert.match(validateQuestionStore(duplicateTitles).join("\n"), /duplicate title/);
assert.throws(() => serializeQuestionStore(duplicateTitles), /duplicate title/);

console.log("rpi structured questions: ok");
