import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const oneLineSchema = Type.String({ minLength: 1 });

export const questionInputSchema = Type.Object(
	{
		title: oneLineSchema,
		question: oneLineSchema,
		options: Type.Array(oneLineSchema, { minItems: 2, maxItems: 26 }),
		recommended_option: Type.Integer({ minimum: 1, maximum: 26 }),
		recommendation: oneLineSchema,
	},
	{ additionalProperties: false },
);

export const questionAnswerSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("option"), option: Type.Integer({ minimum: 1, maximum: 26 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("free_text"),
			text: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const questionContentProperties = {
	id: Type.String({ pattern: "^Q[1-9][0-9]*$" }),
	title: oneLineSchema,
	question: oneLineSchema,
	options: Type.Array(oneLineSchema, { minItems: 2, maxItems: 26 }),
	recommended_option: Type.Integer({ minimum: 1, maximum: 26 }),
	recommendation: oneLineSchema,
};

export const questionSchema = Type.Union([
	Type.Object(
		{
			...questionContentProperties,
			status: Type.Literal("open"),
			answer: Type.Null(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...questionContentProperties,
			status: Type.Literal("answered"),
			answer: questionAnswerSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...questionContentProperties,
			status: Type.Literal("incorporated"),
			answer: questionAnswerSchema,
		},
		{ additionalProperties: false },
	),
]);

export const questionStoreSchema = Type.Object(
	{
		version: Type.Literal(1),
		questions: Type.Array(questionSchema),
	},
	{ additionalProperties: false },
);

export const updateDesignQuestionsSchema = Type.Object(
	{
		task_slug: Type.String({
			minLength: 1,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		incorporated_question_ids: Type.Array(Type.String({ pattern: "^Q[1-9][0-9]*$" })),
		questions: Type.Array(questionInputSchema),
	},
	{ additionalProperties: false },
);

export type QuestionInput = Static<typeof questionInputSchema>;
export type QuestionAnswer = Static<typeof questionAnswerSchema>;
export type Question = Static<typeof questionSchema>;
export type QuestionStore = Static<typeof questionStoreSchema>;
export type UpdateDesignQuestions = Static<typeof updateDesignQuestionsSchema>;
export type LifecycleMutation = Pick<
	UpdateDesignQuestions,
	"incorporated_question_ids" | "questions"
>;

export const EMPTY_QUESTION_STORE: QuestionStore = { version: 1, questions: [] };

function fieldProblem(value: string): string | undefined {
	if (!value.trim()) return "must not be empty";
	if (value !== value.trim()) return "must not have surrounding whitespace";
	if (/(?:[\r\n]|\p{Zl}|\p{Zp})/u.test(value)) return "must be a single line";
	if (/\p{Cc}/u.test(value)) return "must not contain control characters";
	return undefined;
}

export function validateQuestionInput(input: QuestionInput): string[] {
	const errors: string[] = [];
	for (const [name, value] of [
		["title", input.title],
		["question", input.question],
		["recommendation", input.recommendation],
	] as const) {
		const problem = fieldProblem(value);
		if (problem) errors.push(`${name} ${problem}`);
	}
	const seen = new Map<string, number>();
	input.options.forEach((option, index) => {
		const problem = fieldProblem(option);
		if (problem) errors.push(`option ${index + 1} ${problem}`);
		const first = seen.get(option);
		if (first !== undefined)
			errors.push(`duplicate option ${index + 1} (matches option ${first})`);
		else seen.set(option, index + 1);
	});
	if (input.recommended_option > input.options.length)
		errors.push(
			`recommended_option ${input.recommended_option} exceeds ${input.options.length} options`,
		);
	return errors;
}

function freeTextProblem(value: string): string | undefined {
	if (!value.trim()) return "must not be empty";
	if (value !== value.trim()) return "must not have surrounding whitespace";
	return undefined;
}

function questionInput(question: Question): QuestionInput {
	return {
		title: question.title,
		question: question.question,
		options: [...question.options],
		recommended_option: question.recommended_option,
		recommendation: question.recommendation,
	};
}

function sameInput(left: QuestionInput, right: QuestionInput): boolean {
	return (
		left.title === right.title &&
		left.question === right.question &&
		left.options.length === right.options.length &&
		left.options.every((option, index) => option === right.options[index]) &&
		left.recommended_option === right.recommended_option &&
		left.recommendation === right.recommendation
	);
}

function storeProblems(store: QuestionStore): string[] {
	const errors: string[] = [];
	const titles = new Set<string>();
	store.questions.forEach((question, index) => {
		const expectedId = `Q${index + 1}`;
		if (question.id !== expectedId)
			errors.push(`question ${index + 1} must have immutable insertion-order id ${expectedId}`);
		if (titles.has(question.title)) errors.push(`duplicate title "${question.title}"`);
		titles.add(question.title);
		errors.push(...validateQuestionInput(questionInput(question)).map((error) => `${question.id} ${error}`));
		if (question.answer?.kind === "option" && question.answer.option > question.options.length)
			errors.push(`${question.id} answer option ${question.answer.option} exceeds ${question.options.length} options`);
		if (question.answer?.kind === "free_text") {
			const problem = freeTextProblem(question.answer.text);
			if (problem) errors.push(`${question.id} answer text ${problem}`);
		}
	});
	return errors;
}

export function validateQuestionStore(value: unknown): string[] {
	if (!Check(questionStoreSchema, value)) return ["does not match the exact version-1 question store schema"];
	return storeProblems(value);
}

export function parseQuestionStore(json: string): QuestionStore {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(`invalid questions JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const errors = validateQuestionStore(value);
	if (errors.length) throw new Error(`invalid question store: ${errors.join("; ")}`);
	return value as QuestionStore;
}

export function serializeQuestionStore(store: QuestionStore): string {
	const errors = validateQuestionStore(store);
	if (errors.length) throw new Error(`invalid question store: ${errors.join("; ")}`);
	return `${JSON.stringify(store, null, 2)}\n`;
}

export function updateDesignQuestions(
	store: QuestionStore,
	mutation: LifecycleMutation,
): QuestionStore {
	const existingErrors = validateQuestionStore(store);
	if (existingErrors.length) throw new Error(`invalid question store: ${existingErrors.join("; ")}`);
	if (!mutation.incorporated_question_ids.length && !mutation.questions.length)
		throw new Error("question lifecycle mutation requires at least one operation");

	const ids = new Set<string>();
	for (const id of mutation.incorporated_question_ids) {
		if (ids.has(id)) throw new Error(`duplicate incorporated question id ${id}`);
		ids.add(id);
		const question = store.questions.find((candidate) => candidate.id === id);
		if (!question) throw new Error(`unknown question id ${id}`);
		if (question.status === "open") throw new Error(`question ${id} has not been answered`);
	}

	const additions: QuestionInput[] = [];
	const byTitle = new Map(store.questions.map((question) => [question.title, question]));
	for (const input of mutation.questions) {
		if (!Check(questionInputSchema, input)) throw new Error("question does not match the exact input schema");
		const problems = validateQuestionInput(input);
		if (problems.length) throw new Error(`invalid question "${input.title}": ${problems.join("; ")}`);
		const existing = byTitle.get(input.title);
		if (existing) {
			if (!sameInput(questionInput(existing), input))
				throw new Error(`conflicting duplicate title "${input.title}"`);
			continue;
		}
		const repeated = additions.find((candidate) => candidate.title === input.title);
		if (repeated) {
			if (!sameInput(repeated, input)) throw new Error(`conflicting duplicate title "${input.title}"`);
			continue;
		}
		additions.push(input);
	}

	const questions = store.questions.map((question): Question =>
		ids.has(question.id) && question.status === "answered"
			? { ...question, status: "incorporated" }
			: question,
	);
	for (const input of additions) {
		questions.push({
			id: `Q${questions.length + 1}`,
			...input,
			options: [...input.options],
			status: "open",
			answer: null,
		});
	}
	return { version: 1, questions };
}

export function answerQuestion(
	store: QuestionStore,
	id: string,
	answer: QuestionAnswer,
): QuestionStore {
	const errors = validateQuestionStore(store);
	if (errors.length) throw new Error(`invalid question store: ${errors.join("; ")}`);
	if (!Check(questionAnswerSchema, answer)) throw new Error("answer does not match the exact answer schema");
	const question = store.questions.find((candidate) => candidate.id === id);
	if (!question) throw new Error(`unknown question id ${id}`);
	if (answer.kind === "option" && answer.option > question.options.length)
		throw new Error(`answer option ${answer.option} exceeds ${question.options.length} options`);
	let storedAnswer = answer;
	if (answer.kind === "free_text") {
		storedAnswer = { ...answer, text: answer.text.trim() };
		const problem = freeTextProblem(storedAnswer.text);
		if (problem) throw new Error(`answer text ${problem}`);
	}
	if (question.status !== "open") {
		if (JSON.stringify(question.answer) === JSON.stringify(storedAnswer)) return store;
		throw new Error(`question ${id} already has an immutable answer`);
	}
	return {
		version: 1,
		questions: store.questions.map((candidate) =>
			candidate.id === id
				? { ...candidate, status: "answered", answer: storedAnswer }
				: candidate,
		),
	};
}
