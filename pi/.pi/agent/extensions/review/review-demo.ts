import { demoAuditFinding, demoReviewPatch } from "./review-fixture.ts";
import { createReviewServer } from "./review-server.ts";

const patch = demoReviewPatch();
const server = await createReviewServer({
	patch,
	auditFindings: [
		demoAuditFinding(),
		demoAuditFinding({
			category: "test-integrity",
			filePath: "README.md",
			line: 3,
			message: "Document the whitespace-only behavior covered by the regression test.",
		}),
	],
	readPatch: async () => patch,
});

console.log(`Review demo: ${server.url}`);
console.log("Press Ctrl+C to stop.");

await new Promise<void>((resolve) => {
	const stop = () => {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		resolve();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
});
await server.close();
