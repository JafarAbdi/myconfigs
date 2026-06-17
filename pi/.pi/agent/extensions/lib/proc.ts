// Shared helper, kept under lib/ on purpose: pi auto-loads every top-level
// extensions/*.ts as an extension and errors if it has no default export. Non-extension
// modules must live in a subdir (pi only descends into subdirs for index.ts/package.json).
import { spawn } from "node:child_process";

function formatCommandFailure(command: string, code: number | null, stderr: Buffer[]): string {
	const text = Buffer.concat(stderr).toString("utf8").trim();
	return text || `${command} exited with ${code ?? "unknown status"}`;
}

export function runCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		const stderr: Buffer[] = [];
		child.stderr.on("data", (data) => stderr.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(formatCommandFailure(command, code, stderr)));
		});
	});
}
