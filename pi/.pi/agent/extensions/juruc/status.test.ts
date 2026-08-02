import assert from "node:assert/strict";
import { lifecyclePlace, phasePosition, readinessDimensions } from "./status.ts";
import type { BaseReadiness } from "./execution.ts";
import type { TaskRecord } from "./tasks.ts";

function task(state: Record<string, unknown>): TaskRecord {
	return {
		plan: { approved: { completed: [], future: [{}] } },
		state,
	} as unknown as TaskRecord;
}

assert.match(lifecyclePlace(task({
	phase: "building",
	audit: { snapshot: { paths: ["changed.ts"] }, summary: "done" },
}))?.detail ?? "", /audited · recovery ready/);
assert.match(lifecyclePlace(task({
	phase: "building",
	audit: { snapshot: { paths: [] }, summary: "done" },
}))?.detail ?? "", /audited · no-code recovery/);
assert.match(lifecyclePlace(task({
	phase: "committing",
	commitMessage: null,
}))?.detail ?? "", /generating commit message/);
assert.match(lifecyclePlace(task({
	phase: "committing",
	commitMessage: { responseEntryId: "response", text: "message" },
}))?.detail ?? "", /commit recovery ready/);

const replaced = task({
	phase: "building",
	phaseSnapshot: { id: "P9" },
});
replaced.plan.approved = {
	completed: [{ id: "P6" }],
	future: [{ id: "P9" }, { id: "P12" }],
} as never;
assert.deepEqual(phasePosition(replaced, "P9"), { position: 2, total: 3 });
assert.deepEqual(phasePosition(replaced), { position: 2, total: 3 });
assert.equal(phasePosition(replaced, "P6")?.position, 1);

for (const acceptance of ["accepted", "not-ready"] as const)
	for (const risk of ["clear", "accepted-risks"] as const)
		for (const base of ["current", "moved", "deleted-or-rewritten"] as BaseReadiness[])
			assert.deepEqual(
				readinessDimensions({
					plan: { approved: { risks: risk === "clear" ? [] : [{}] } },
					state: { phase: acceptance === "accepted" ? "done" : "planning" },
				} as unknown as TaskRecord, base),
				{ acceptance, risk, base },
			);
assert.equal(lifecyclePlace(task({ phase: "accepting" }))?.active, "build");

console.log("juruc authoritative recovery status: ok");
