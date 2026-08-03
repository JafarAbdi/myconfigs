import { readFileSync } from "node:fs";
import { reviewPatchFromText, type ReviewPatch } from "./review-git.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	registerTaskReviewerStart,
	type ReviewerOutcome,
	type TaskDocument,
} from "./task.ts";

export const DEMO_BASE_OID = "1111111111111111111111111111111111111111";
export const DEMO_HEAD_OID = "2222222222222222222222222222222222222222";

export const DEMO_DEVIATION_OUTCOME: ReviewerOutcome = {
	status: "completed",
	annotations: [{
		filePath: "src/greeting.ts",
		side: "additions",
		line: 2,
		summary: "Whitespace-only names now receive a readable fallback.",
		rationale: "Advisory context only; the operator decides whether any correction is needed.",
	}],
};

export const DEMO_CORRECTNESS_OUTCOME: ReviewerOutcome = {
	status: "completed",
	annotations: [],
};

export function demoReviewPatch(): ReviewPatch {
	return reviewPatchFromText(
		readFileSync(new URL("./review-fixture.patch", import.meta.url), "utf8"),
		DEMO_BASE_OID,
		DEMO_HEAD_OID,
	);
}

export function demoReviewTask(options: {
	deviation?: ReviewerOutcome;
	correctness?: ReviewerOutcome;
} = {}): TaskDocument {
	let task = createTaskDocument({
		slug: "demo-review",
		title: "Demo review",
		request: "Review the greeting change.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: DEMO_BASE_OID,
			branch: "demo-review",
			worktree: "/worktrees/demo-review",
		},
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "Review the greeting change.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, {
		summary: "Keep greeting behavior deterministic.",
		requirements: ["Render the greeting."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["The greeting is readable."],
		decisions: [],
	});
	task = activateTaskPlan(acceptTaskPlan(task, {
		phases: [{
			id: "update-greeting",
			title: "Update greeting",
			goal: "Update greeting behavior.",
			fileScopes: ["src/greeting.ts", "README.md"],
			instructions: ["Implement the greeting change."],
			verification: ["npm test"],
		}],
	}));
	task = completeTaskPhase(
		task,
		"Updated greeting behavior.",
		[{ command: "npm test", exitCode: 0, summary: "Tests passed." }],
		DEMO_HEAD_OID,
	);
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-review.jsonl");
	task = completeTaskReviewer(task, "deviation", options.deviation ?? DEMO_DEVIATION_OUTCOME);
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness-review.jsonl");
	return completeTaskReviewer(task, "correctness", options.correctness ?? DEMO_CORRECTNESS_OUTCOME);
}
