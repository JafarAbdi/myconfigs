import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

interface ReviewLockOwner {
	pid: number;
	token: string;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function invalidLock(path: string): Error {
	return new Error(
		`review lock is invalid; remove ${path} after confirming no review operation is running`,
	);
}

function readOwner(path: string): ReviewLockOwner {
	const source = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw invalidLock(path);
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 2 ||
		!("pid" in value) ||
		!("token" in value) ||
		!Number.isSafeInteger(value.pid) ||
		(value.pid as number) < 1 ||
		typeof value.token !== "string" ||
		!value.token
	) throw invalidLock(path);
	return { pid: value.pid as number, token: value.token };
}

export function acquireTaskReviewLock(taskPath: string): () => void {
	mkdirSync(dirname(taskPath), { recursive: true, mode: 0o700 });
	const path = `${taskPath}.review.lock`;
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let descriptor: number;
		try {
			descriptor = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: ReviewLockOwner;
			try {
				owner = readOwner(path);
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw readError;
			}
			if (processExists(owner.pid))
				throw new Error(`another review operation already owns ${taskPath}`);
			try {
				unlinkSync(path);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
			}
			continue;
		}
		try {
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
			fchmodSync(descriptor, 0o600);
		} catch (error) {
			closeSync(descriptor);
			try {
				unlinkSync(path);
			} catch {}
			throw error;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			closeSync(descriptor);
			let owner: ReviewLockOwner;
			try {
				owner = readOwner(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			if (owner.token === token) unlinkSync(path);
		};
	}
	throw new Error(`could not acquire review lock for ${taskPath}`);
}
