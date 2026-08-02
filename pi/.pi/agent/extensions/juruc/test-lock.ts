import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETRIES = 1_200;
const RETRY_MS = 25;

export async function acquireTestLock(name: string): Promise<() => void> {
	const path = join(tmpdir(), name);
	for (let attempt = 0; attempt < RETRIES; attempt += 1) {
		try {
			mkdirSync(path);
			return () => rmSync(path, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}
	}
	throw new Error(`timed out waiting for test lock ${path}`);
}
