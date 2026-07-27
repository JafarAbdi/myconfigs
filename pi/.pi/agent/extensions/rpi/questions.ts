import { type Static, Type } from "typebox";

export const questionsSchema = Type.Object(
	{
		task_slug: Type.String({
			description: "Active RPI task slug from the phase prompt",
			minLength: 1,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		questions: Type.Array(
			Type.Object(
				{
					title: Type.String({
						description: "Concise one-line question heading",
						minLength: 1,
					}),
					question: Type.String({
						description: "One-line design question",
						minLength: 1,
					}),
					options: Type.Array(
						Type.String({
							description: "One-line option text without an Option A-Z label",
							minLength: 1,
						}),
						{
							description:
								"Options in display order; the extension assigns labels",
							minItems: 2,
							maxItems: 26,
						},
					),
					recommended_option: Type.Integer({
						description: "1-based index into options",
						minimum: 1,
						maximum: 26,
					}),
					recommendation: Type.String({
						description: "One-line rationale for the recommended option",
						minLength: 1,
					}),
				},
				{ additionalProperties: false },
			),
			{
				description: "New unresolved questions to add in one batch",
				minItems: 1,
			},
		),
	},
	{ additionalProperties: false },
);

export type QuestionsInput = Static<typeof questionsSchema>;

export type ParsedQuestion =
	| {
			status: "open";
			title: string;
			question: string;
			options: string[];
			recommendedOption: number;
			recommendation: string;
	  }
	| {
			status: "resolved";
			title: string;
			question: string;
			options: string[];
			decision: string;
			rationale: string;
	  };

type ParseDesignQuestionsResult =
	| {
			kind: "valid";
			questions: ParsedQuestion[];
			sectionEnd: number;
	  }
	| { kind: "invalid"; line: number; error: string };

const DESIGN_HEADING = "### Design Questions";
const OPTION = /^- Option ([A-Z]): (.+)$/;
const OPEN_HEADING = /^#### (.+)$/;
const RESOLVED_TITLE = /^\[x\] (.+)$/;

function fieldProblem(value: string): string | undefined {
	if (!value.trim()) return "must not be empty";
	if (/(?:[\r\n]|\p{Zl}|\p{Zp})/u.test(value)) return "must be a single line";
	if (value !== value.trim()) return "must not have surrounding whitespace";
	if (/\p{Cc}/u.test(value)) return "must not contain control characters";
	return undefined;
}

/** Returns all semantic diagnostics; structural validation belongs to the TypeBox schema. */
export function validateQuestions(input: QuestionsInput): string[] {
	const errors: string[] = [];
	const slugProblem = fieldProblem(input.task_slug);
	if (slugProblem) errors.push(`task_slug ${slugProblem}`);
	else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.task_slug))
		errors.push("task_slug has invalid characters");

	if (input.questions.length === 0)
		errors.push("questions must contain at least one entry");
	const titles = new Map<string, number>();
	input.questions.forEach((question, index) => {
		const at = `question ${index + 1}${question.title.trim() ? ` ("${question.title}")` : ""}`;
		for (const [name, value] of [
			["title", question.title],
			["question", question.question],
			["recommendation", question.recommendation],
		] as const) {
			const problem = fieldProblem(value);
			if (problem) errors.push(`${at}: ${name} ${problem}`);
		}
		if (question.title.startsWith("["))
			errors.push(`${at}: title must not start with "["`);
		if (
			/^(?:#{1,6}(?:\s|$)|`{3}|~{3}|- Option\b|Recommendation:|Decision:|Rationale:)/.test(
				question.question,
			)
		)
			errors.push(`${at}: question must not start with Markdown structure`);

		const titleKey = question.title.trim();
		if (titleKey) {
			const first = titles.get(titleKey);
			if (first !== undefined)
				errors.push(`${at}: duplicate title (first used by question ${first})`);
			else titles.set(titleKey, index + 1);
		}

		if (question.options.length < 2 || question.options.length > 26)
			errors.push(`${at}: options must contain 2..26 entries`);
		const options = new Map<string, number>();
		question.options.forEach((option, optionIndex) => {
			const problem = fieldProblem(option);
			if (problem) errors.push(`${at}: option ${optionIndex + 1} ${problem}`);
			const key = option.trim();
			if (!key) return;
			const first = options.get(key);
			if (first !== undefined)
				errors.push(
					`${at}: duplicate option ${optionIndex + 1} (matches option ${first})`,
				);
			else options.set(key, optionIndex + 1);
		});
		if (
			!Number.isInteger(question.recommended_option) ||
			question.recommended_option < 1 ||
			question.recommended_option > 26
		)
			errors.push(`${at}: recommended_option must be an integer from 1..26`);
		else if (question.recommended_option > question.options.length)
			errors.push(
				`${at}: recommended_option ${question.recommended_option} exceeds ${question.options.length} options`,
			);
	});
	return errors;
}

export function optionLabel(index: number): string {
	if (!Number.isInteger(index) || index < 1 || index > 26)
		throw new Error(`option index ${index} is outside 1..26`);
	return `Option ${String.fromCharCode(64 + index)}`;
}

export function serializeQuestions(input: QuestionsInput): string {
	const errors = validateQuestions(input);
	if (errors.length) throw new Error(errors.join("\n"));
	return input.questions
		.map((question) =>
			[
				`#### ${question.title}`,
				"",
				question.question,
				"",
				...question.options.map(
					(option, index) => `- ${optionLabel(index + 1)}: ${option}`,
				),
				"",
				`Recommendation: ${optionLabel(question.recommended_option)} — ${question.recommendation}`,
			].join("\n"),
		)
		.join("\n\n");
}

interface SourceLine {
	text: string;
	line: number;
	start: number;
	ignored: boolean;
}

function sourceLines(document: string): {
	lines: SourceLine[];
	unterminatedFence?: number;
} {
	const lines: SourceLine[] = [];
	let offset = 0;
	let fence:
		| { marker: "`" | "~"; length: number; openingLine: number }
		| undefined;
	for (const [index, raw] of document.split("\n").entries()) {
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
		const ignored = fence !== undefined || marker !== undefined;
		lines.push({ text, line: index + 1, start: offset, ignored });
		if (fence) {
			const close = new RegExp(
				`^ {0,3}\\${fence.marker}{${fence.length},}\\s*$`,
			);
			if (close.test(text)) fence = undefined;
		} else if (marker) {
			fence = {
				marker: marker[0] as "`" | "~",
				length: marker.length,
				openingLine: index + 1,
			};
		}
		offset += raw.length + 1;
	}
	return { lines, unterminatedFence: fence?.openingLine };
}

function invalid(line: number, error: string): ParseDesignQuestionsResult {
	return { kind: "invalid", line, error: `line ${line}: ${error}` };
}

export function parseDesignQuestions(
	document: string,
): ParseDesignQuestionsResult {
	const source = sourceLines(document);
	if (source.unterminatedFence !== undefined)
		return invalid(
			source.unterminatedFence,
			"unterminated Markdown code fence",
		);
	const { lines } = source;
	const headings = lines.filter(
		(line) => !line.ignored && line.text === DESIGN_HEADING,
	);
	if (headings.length !== 1) {
		const line = headings[1]?.line ?? headings[0]?.line ?? 1;
		return invalid(
			line,
			`expected exactly one "${DESIGN_HEADING}" section; found ${headings.length}`,
		);
	}
	const heading = headings[0];
	const headingIndex = lines.indexOf(heading);
	let endIndex = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index++) {
		if (!lines[index].ignored && /^###(?:\s|$)/.test(lines[index].text)) {
			endIndex = index;
			break;
		}
	}

	for (const [index, line] of lines.entries()) {
		if (
			!line.ignored &&
			/^####(?!#)/.test(line.text) &&
			(index <= headingIndex || index >= endIndex)
		)
			return invalid(
				line.line,
				`question heading must be inside "${DESIGN_HEADING}"`,
			);
	}

	const questionStarts: Array<{
		index: number;
		title: string;
		status: "open" | "resolved";
	}> = [];
	for (let index = headingIndex + 1; index < endIndex; index++) {
		const line = lines[index];
		if (line.ignored || !/^####(?!#)/.test(line.text)) continue;
		const headingMatch = OPEN_HEADING.exec(line.text);
		if (!headingMatch) return invalid(line.line, "malformed question heading");
		const resolved = RESOLVED_TITLE.exec(headingMatch[1]);
		if (/^\[/.test(headingMatch[1]) && !resolved)
			return invalid(
				line.line,
				'question heading must be "#### title" or "#### [x] title"',
			);
		const title = resolved?.[1] ?? headingMatch[1];
		const titleProblem = fieldProblem(title);
		if (titleProblem)
			return invalid(line.line, `question title ${titleProblem}`);
		questionStarts.push({
			index,
			title,
			status: resolved ? "resolved" : "open",
		});
	}

	const firstQuestion = questionStarts[0]?.index ?? endIndex;
	const stray = lines
		.slice(headingIndex + 1, firstQuestion)
		.find((line) => !line.ignored && line.text.trim());
	if (stray)
		return invalid(
			stray.line,
			`unexpected content before the first question in "${DESIGN_HEADING}"`,
		);

	const seenTitles = new Map<string, number>();
	const questions: ParsedQuestion[] = [];
	for (const [questionIndex, start] of questionStarts.entries()) {
		const headingLine = lines[start.index].line;
		const firstTitleLine = seenTitles.get(start.title);
		if (firstTitleLine !== undefined)
			return invalid(
				headingLine,
				`duplicate question title "${start.title}" (first declared on line ${firstTitleLine})`,
			);
		seenTitles.set(start.title, headingLine);
		const stop = questionStarts[questionIndex + 1]?.index ?? endIndex;
		const body = lines.slice(start.index + 1, stop);
		const options: Array<{ label: number; value: string; line: number }> = [];
		const recommendations: Array<{
			option: number;
			rationale: string;
			line: number;
		}> = [];
		const decisions: Array<{ value: string; line: number }> = [];
		const rationales: Array<{ value: string; line: number }> = [];
		let firstStructure = body.length;
		let terminal: "recommendation" | "decision" | "rationale" | undefined;

		for (const [bodyIndex, line] of body.entries()) {
			if (line.ignored || !line.text.trim()) continue;
			const option = OPTION.exec(line.text);
			if (option) {
				const optionProblem = fieldProblem(option[2]);
				if (optionProblem)
					return invalid(
						line.line,
						`question "${start.title}" ${optionLabel(option[1].charCodeAt(0) - 64)} ${optionProblem}`,
					);
				if (terminal)
					return invalid(
						line.line,
						`question "${start.title}" has an option after ${terminal}`,
					);
				firstStructure = Math.min(firstStructure, bodyIndex);
				options.push({
					label: option[1].charCodeAt(0) - 64,
					value: option[2],
					line: line.line,
				});
				continue;
			}
			if (/^- Option\b/.test(line.text))
				return invalid(
					line.line,
					`malformed option in question "${start.title}"`,
				);
			const recommendation = /^Recommendation: Option ([A-Z]) — (.+)$/.exec(
				line.text,
			);
			if (recommendation) {
				const rationaleProblem = fieldProblem(recommendation[2]);
				if (rationaleProblem)
					return invalid(
						line.line,
						`question "${start.title}" Recommendation rationale ${rationaleProblem}`,
					);
				firstStructure = Math.min(firstStructure, bodyIndex);
				terminal = "recommendation";
				recommendations.push({
					option: recommendation[1].charCodeAt(0) - 64,
					rationale: recommendation[2],
					line: line.line,
				});
				continue;
			}
			if (/^Recommendation:/.test(line.text))
				return invalid(
					line.line,
					`malformed Recommendation in question "${start.title}"`,
				);
			if (line.text.startsWith("Decision:")) {
				const decision = /^Decision: (.+)$/.exec(line.text);
				if (!decision)
					return invalid(
						line.line,
						`question "${start.title}" Decision must use exact \`Decision: value\` syntax`,
					);
				const decisionProblem = fieldProblem(decision[1]);
				if (decisionProblem)
					return invalid(
						line.line,
						`question "${start.title}" Decision ${decisionProblem}`,
					);
				if (terminal === "recommendation" || terminal === "rationale")
					return invalid(
						line.line,
						`question "${start.title}" has Decision after ${terminal}`,
					);
				firstStructure = Math.min(firstStructure, bodyIndex);
				terminal = "decision";
				decisions.push({ value: decision[1], line: line.line });
				continue;
			}
			if (line.text.startsWith("Rationale:")) {
				const rationale = /^Rationale: (.+)$/.exec(line.text);
				if (!rationale)
					return invalid(
						line.line,
						`question "${start.title}" Rationale must use exact \`Rationale: value\` syntax`,
					);
				const rationaleProblem = fieldProblem(rationale[1]);
				if (rationaleProblem)
					return invalid(
						line.line,
						`question "${start.title}" Rationale ${rationaleProblem}`,
					);
				if (terminal !== "decision" && terminal !== "rationale")
					return invalid(
						line.line,
						`question "${start.title}" requires Decision before Rationale`,
					);
				firstStructure = Math.min(firstStructure, bodyIndex);
				terminal = "rationale";
				rationales.push({ value: rationale[1], line: line.line });
				continue;
			}
			if (firstStructure !== body.length)
				return invalid(
					line.line,
					`question "${start.title}" has unexpected content after its options`,
				);
		}

		const proseLines = body
			.slice(0, firstStructure)
			.filter((line) => !line.ignored && line.text.trim());
		if (proseLines.length > 1)
			return invalid(
				proseLines[1].line,
				`question "${start.title}" prose must be a single line`,
			);
		const proseProblem = proseLines[0]
			? fieldProblem(proseLines[0].text)
			: undefined;
		if (proseProblem)
			return invalid(
				proseLines[0].line,
				`question "${start.title}" prose ${proseProblem}`,
			);
		const prose = proseLines.map((line) => line.text);
		if (!prose.length)
			return invalid(
				headingLine,
				`question "${start.title}" has no question prose`,
			);
		if (options.length < 2 || options.length > 26)
			return invalid(
				headingLine,
				`question "${start.title}" must have 2..26 options; found ${options.length}`,
			);
		const optionValues = new Map<string, number>();
		for (const [index, option] of options.entries()) {
			if (option.label !== index + 1)
				return invalid(
					option.line,
					`question "${start.title}" options must be sequential from Option A; expected ${optionLabel(index + 1)}`,
				);
			if (!option.value)
				return invalid(
					option.line,
					`question "${start.title}" has an empty option`,
				);
			const first = optionValues.get(option.value);
			if (first !== undefined)
				return invalid(
					option.line,
					`question "${start.title}" duplicates option text from line ${first}`,
				);
			optionValues.set(option.value, option.line);
		}

		const common = {
			title: start.title,
			question: prose.join("\n"),
			options: options.map((option) => option.value),
		};
		if (start.status === "open") {
			if (decisions.length || rationales.length)
				return invalid(
					(decisions[0] ?? rationales[0]).line,
					`open question "${start.title}" must not contain Decision or Rationale`,
				);
			if (recommendations.length !== 1)
				return invalid(
					recommendations[1]?.line ?? headingLine,
					`open question "${start.title}" requires exactly one Recommendation; found ${recommendations.length}`,
				);
			const recommendation = recommendations[0];
			if (!recommendation.rationale)
				return invalid(
					recommendation.line,
					`question "${start.title}" has an empty Recommendation rationale`,
				);
			if (recommendation.option > options.length)
				return invalid(
					recommendation.line,
					`question "${start.title}" Recommendation names missing ${optionLabel(recommendation.option)}`,
				);
			questions.push({
				status: "open",
				...common,
				recommendedOption: recommendation.option,
				recommendation: recommendation.rationale,
			});
		} else {
			if (recommendations.length)
				return invalid(
					recommendations[0].line,
					`resolved question "${start.title}" must not contain Recommendation`,
				);
			if (decisions.length !== 1 || !decisions[0]?.value)
				return invalid(
					decisions[1]?.line ?? decisions[0]?.line ?? headingLine,
					`resolved question "${start.title}" requires exactly one nonempty Decision`,
				);
			if (rationales.length !== 1 || !rationales[0]?.value)
				return invalid(
					rationales[1]?.line ?? rationales[0]?.line ?? headingLine,
					`resolved question "${start.title}" requires exactly one nonempty Rationale`,
				);
			questions.push({
				status: "resolved",
				...common,
				decision: decisions[0].value,
				rationale: rationales[0].value,
			});
		}
	}

	return {
		kind: "valid",
		questions,
		sectionEnd:
			endIndex < lines.length ? lines[endIndex].start : document.length,
	};
}

export function insertQuestions(
	document: string,
	input: QuestionsInput,
): string {
	const parsed = parseDesignQuestions(document);
	if (parsed.kind === "invalid") throw new Error(parsed.error);
	const newline = document.includes("\r\n") ? "\r\n" : "\n";
	const serialized = serializeQuestions(input).replaceAll("\n", newline);
	if (!serialized) return document;
	const existing = new Set(parsed.questions.map((question) => question.title));
	for (const question of input.questions) {
		if (existing.has(question.title.trim()))
			throw new Error(`duplicate question title "${question.title}"`);
	}

	let insertion = parsed.sectionEnd;
	while (document.slice(0, insertion).endsWith(newline))
		insertion -= newline.length;
	const before = document.slice(0, insertion);
	const after = document.slice(insertion);
	const prefix = before.endsWith(newline + newline)
		? ""
		: before.endsWith(newline)
			? newline
			: newline + newline;
	const atDocumentEnd = parsed.sectionEnd === document.length;
	const suffix =
		atDocumentEnd || after.startsWith(newline + newline) || !after
			? ""
			: after.startsWith(newline)
				? newline
				: newline + newline;
	return `${before}${prefix}${serialized}${suffix}${after}`;
}
