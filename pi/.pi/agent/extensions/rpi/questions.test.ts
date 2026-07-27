import assert from "node:assert/strict";
import {
	insertQuestions,
	parseDesignQuestions,
	type QuestionsInput,
	questionsSchema,
	serializeQuestions,
	validateQuestions,
} from "./questions.ts";

const input: QuestionsInput = {
	task_slug: "cache-policy",
	questions: [
		{
			title: "Cache ownership",
			question: "Which layer should own the cache?",
			options: ["The adapter", "The caller"],
			recommended_option: 1,
			recommendation: "it already owns the remote lifecycle",
		},
	],
};

assert.equal(
	(
		questionsSchema as typeof questionsSchema & {
			additionalProperties: boolean;
		}
	).additionalProperties,
	false,
);
assert.equal(
	(
		questionsSchema.properties.questions
			.items as typeof questionsSchema.properties.questions.items & {
			additionalProperties: boolean;
		}
	).additionalProperties,
	false,
);
assert.equal(
	(
		questionsSchema.properties
			.questions as typeof questionsSchema.properties.questions & {
			minItems: number;
		}
	).minItems,
	1,
);
assert.equal(
	serializeQuestions(input),
	[
		"#### Cache ownership",
		"",
		"Which layer should own the cache?",
		"",
		"- Option A: The adapter",
		"- Option B: The caller",
		"",
		"Recommendation: Option A — it already owns the remote lifecycle",
	].join("\n"),
);

const twentySix: QuestionsInput = {
	...input,
	questions: [
		{
			...input.questions[0],
			options: Array.from({ length: 26 }, (_, index) => `Choice ${index + 1}`),
			recommended_option: 26,
		},
	],
};
assert.match(serializeQuestions(twentySix), /- Option Z: Choice 26/);
assert.match(serializeQuestions(twentySix), /Recommendation: Option Z —/);

const design = (body: string) =>
	`# Design\n\n### Context\n\nContext.\n\n### Design Questions\n\n${body}\n\n### Patterns to follow\n\nPattern.`;
const open = serializeQuestions(input);
const resolved = [
	"#### [x] Storage format",
	"",
	"Which format should persist?",
	"",
	"- Option A: JSON",
	"- Option B: SQLite",
	"",
	"Decision: Option B",
	"Rationale: It provides transactions; JSON does not.",
].join("\n");

const parsedOpen = parseDesignQuestions(design(open));
assert.equal(parsedOpen.kind, "valid");
if (parsedOpen.kind === "valid") {
	assert.equal(parsedOpen.questions.length, 1);
	assert.deepEqual(parsedOpen.questions[0], {
		status: "open",
		title: "Cache ownership",
		question: "Which layer should own the cache?",
		options: ["The adapter", "The caller"],
		recommendedOption: 1,
		recommendation: "it already owns the remote lifecycle",
	});
}

const parsedResolved = parseDesignQuestions(design(resolved));
assert.equal(parsedResolved.kind, "valid");
if (parsedResolved.kind === "valid")
	assert.equal(parsedResolved.questions[0].status, "resolved");
assert.equal(
	parseDesignQuestions(design(open).replaceAll("\n", "\r\n")).kind,
	"valid",
);

const multiple = parseDesignQuestions(design(`${open}\n\n${resolved}`));
assert.equal(multiple.kind, "valid");
if (multiple.kind === "valid") assert.equal(multiple.questions.length, 2);

const fenced = parseDesignQuestions(
	design(
		[
			"```md",
			"### Design Questions",
			"#### Fake",
			"- Option A: Fake",
			"```",
			open,
			"~~~md",
			"#### [ ] Also fake",
			"- Option Z: Fake",
			"~~~",
		].join("\n"),
	),
);
assert.equal(fenced.kind, "valid");
if (fenced.kind === "valid") assert.equal(fenced.questions.length, 1);
const unterminatedFence = parseDesignQuestions(design(`${open}\n\n\`\`\`md`));
assert.equal(unterminatedFence.kind, "invalid");
if (unterminatedFence.kind === "invalid")
	assert.match(unterminatedFence.error, /unterminated Markdown code fence/);

function reject(body: string, pattern: RegExp): void {
	const result = parseDesignQuestions(design(body));
	assert.equal(result.kind, "invalid", body);
	if (result.kind === "invalid") {
		assert.match(result.error, /^line \d+:/);
		assert.match(result.error, pattern);
	}
}

reject(
	[
		"#### One option",
		"",
		"Choose.",
		"",
		"- Option A: Alone",
		"",
		"Recommendation: Option A — only choice",
	].join("\n"),
	/One option.*2\.\.26/,
);

const twentySeven = Array.from(
	{ length: 27 },
	(_, index) =>
		`- Option ${String.fromCharCode(65 + (index % 26))}: Value ${index}`,
).join("\n");
reject(
	`#### Too many\n\nChoose.\n\n${twentySeven}\n\nRecommendation: Option A — first`,
	/Too many/,
);
reject(
	"#### Gap\n\nChoose.\n\n- Option A: One\n- Option C: Three\n\nRecommendation: Option A — first",
	/expected Option B/,
);
reject(
	"#### Duplicate labels\n\nChoose.\n\n- Option A: One\n- Option A: Two\n\nRecommendation: Option A — first",
	/expected Option B/,
);
reject(
	"#### Duplicate values\n\nChoose.\n\n- Option A: Same\n- Option B: Same\n\nRecommendation: Option A — first",
	/duplicates option text/,
);
reject(
	"#### Missing recommendation\n\nChoose.\n\n- Option A: One\n- Option B: Two",
	/requires exactly one Recommendation; found 0/,
);
reject(
	"#### Duplicate recommendation\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nRecommendation: Option A — first\nRecommendation: Option B — second",
	/requires exactly one Recommendation; found 2/,
);
reject(
	"#### Out of range\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nRecommendation: Option C — third",
	/names missing Option C/,
);
reject(
	"#### [x] Broken resolution\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nDecision: \nRationale: reason",
	/Decision/,
);
reject(
	"#### [x] Still recommended\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nRecommendation: Option A — first\nDecision: One\nRationale: reason",
	/recommendation/i,
);
reject(`${open}\n\n${open}`, /duplicate question title "Cache ownership"/);
reject(
	"#### [ ] Malformed\n\nChoose.\n\n- Option A: One\n- Option B: Two",
	/question heading must be/,
);
reject(
	"#### Trailing prose\n\nChoose.\n\n- Option A: One\n- Option B: Two\nExtra prose\nRecommendation: Option A — first",
	/unexpected content/,
);
reject(
	"#### Bad order\n\nChoose.\n\n- Option A: One\nRecommendation: Option A — first\n- Option B: Two",
	/option after recommendation/,
);
reject(
	"#### [x] Backwards\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nRationale: reason\nDecision: One",
	/requires Decision before Rationale/,
);
reject(
	"#### [x] Padded\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nDecision: Option A \nRationale: reason",
	/Decision must not have surrounding whitespace/,
);
reject(
	"#### Padded recommendation\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nRecommendation: Option A — reason\t",
	/Recommendation rationale must not have surrounding whitespace/,
);
reject(
	"#### [x] Control\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nDecision: Option A\u0085hidden\nRationale: reason",
	/Decision must not contain control characters/,
);
reject(
	"#### [x] Line separator\n\nChoose.\n\n- Option A: One\n- Option B: Two\n\nDecision: Option A\nRationale: visible\u2029hidden",
	/Rationale/,
);
reject("Loose prose", /unexpected content before the first question/);
const outsideSection = parseDesignQuestions(
	`# Design\n\n#### Outside\n\n### Design Questions\n\n${open}`,
);
assert.equal(outsideSection.kind, "invalid");
if (outsideSection.kind === "invalid")
	assert.match(outsideSection.error, /must be inside/);

assert.deepEqual(validateQuestions({ task_slug: "ok", questions: [] }), [
	"questions must contain at least one entry",
]);
assert.match(
	validateQuestions({
		...input,
		questions: [
			{ ...input.questions[0], recommendation: "reason\u009fhidden" },
		],
	}).join("\n"),
	/recommendation must not contain control characters/,
);
assert.match(
	validateQuestions({
		...input,
		questions: [
			{ ...input.questions[0], options: ["visible\u2028hidden", "second"] },
		],
	}).join("\n"),
	/option 1 must be a single line/,
);
assert.match(
	validateQuestions({
		task_slug: "ok",
		questions: [
			{
				...input.questions[0],
				title: "[x] Injected",
				question: "#### Injected",
			},
		],
	}).join("\n"),
	/title must not start.*question must not start with Markdown structure/s,
);

assert.deepEqual(
	validateQuestions({
		task_slug: " ",
		questions: [
			{
				title: "Repeated",
				question: "line one\nline two",
				options: ["same", "same"],
				recommended_option: 3,
				recommendation: " ",
			},
			{
				title: "Repeated",
				question: "Question",
				options: ["one"],
				recommended_option: 1,
				recommendation: "Reason",
			},
		],
	}),
	[
		"task_slug must not be empty",
		'question 1 ("Repeated"): question must be a single line',
		'question 1 ("Repeated"): recommendation must not be empty',
		'question 1 ("Repeated"): duplicate option 2 (matches option 1)',
		'question 1 ("Repeated"): recommended_option 3 exceeds 2 options',
		'question 2 ("Repeated"): duplicate title (first used by question 1)',
		'question 2 ("Repeated"): options must contain 2..26 entries',
	],
);

const inserted = insertQuestions(
	"# Design\n\n### Design Questions\n\n### Next\n\nUntouched.\n",
	input,
);
assert.equal(
	inserted,
	`# Design\n\n### Design Questions\n\n${open}\n\n### Next\n\nUntouched.\n`,
);
assert.throws(
	() => insertQuestions(design(open), input),
	/duplicate question title/,
);
assert.equal(
	insertQuestions("# Design\n\n### Design Questions", input),
	`# Design\n\n### Design Questions\n\n${open}`,
	"a document without a trailing newline must remain without one",
);
assert.equal(
	insertQuestions("# Design\n\n### Design Questions\n", input),
	`# Design\n\n### Design Questions\n\n${open}\n`,
	"a document with a trailing newline must retain exactly one",
);
const crlfDocument = "# Design\r\n\r\n### Design Questions\r\n\r\n### Next\r\n";
assert.equal(
	insertQuestions(crlfDocument, input),
	`# Design\r\n\r\n### Design Questions\r\n\r\n${open.replaceAll("\n", "\r\n")}\r\n\r\n### Next\r\n`,
);

console.log("rpi questions: ok");
