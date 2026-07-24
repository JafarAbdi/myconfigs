// Exclusive writer-lease ownership of the canonical workspace, keyed by hashed cwd. A stale lease
// is reclaimed only after its owner process and any marked writer descendants are gone.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, watch } from "node:fs/promises";
import { basename, join } from "node:path";
import { publishJsonExclusive, replaceJsonAtomic } from "./atomic-files.ts";
import { JOB_LAUNCH_LEASE_RECHECK_MS } from "./limits.ts";
import { processEnvironmentMarkerExists, processToken, processTokenMatches, WRITER_OWNER_ENV } from "./processes.ts";

const LEASE_BYTES_MAX = 4096;
const LEASE_GUARD_ATTEMPT_COUNT_MAX = 3;
const LEASE_WAIT_EVENT_COUNT_MAX = 64;

export class WriterLeaseBusyError extends Error {}

export interface WriterLease {
	version: 2;
	ownerId: string;
	processId: number;
	processToken: string;
	// Diagnostic only: the canonical key is the hashed workspace path in the lease
	// filename (see leasePath). This stored copy is validated but never read for logic.
	cwd: string;
	createdAt: string;
	protectDescendants: boolean;
	processGroupId?: number;
	path: string;
}

interface WriterLeaseOptions {
	protectDescendants?: boolean;
	processGroupId?: number;
}

interface LeaseGuard {
	version: 1;
	processId: number;
	processToken: string;
}

function leasePath(root: string, cwd: string): string {
	const key = createHash("sha256").update(cwd).digest("hex");
	return join(root, `${key}.json`);
}

function validateLease(value: unknown, path: string): WriterLease {
	if (typeof value !== "object" || value === null) throw new Error("invalid writer lease");
	const lease = value as Partial<WriterLease>;
	if (lease.version !== 2 || typeof lease.ownerId !== "string") {
		throw new Error("invalid writer lease identity");
	}
	if (!Number.isSafeInteger(lease.processId) || (lease.processId ?? 0) <= 1) {
		throw new Error("invalid writer lease process");
	}
	if (typeof lease.processToken !== "string" || typeof lease.cwd !== "string") {
		throw new Error("invalid writer lease metadata");
	}
	if (typeof lease.createdAt !== "string") throw new Error("invalid writer lease time");
	if (typeof lease.protectDescendants !== "boolean") {
		throw new Error("invalid writer lease descendant policy");
	}
	if (
		lease.processGroupId !== undefined &&
		(!Number.isSafeInteger(lease.processGroupId) || lease.processGroupId <= 1)
	) {
		throw new Error("invalid writer lease process group");
	}
	return { ...(lease as WriterLease), path };
}

async function readLease(path: string): Promise<WriterLease> {
	const content = await readFile(path);
	if (content.length > LEASE_BYTES_MAX) throw new Error("writer lease exceeds size limit");
	return validateLease(JSON.parse(content.toString("utf8")), path);
}

async function leaseOwnerIsAlive(lease: WriterLease): Promise<boolean> {
	return processTokenMatches(lease.processId, lease.processToken);
}

function validateGuard(value: unknown): LeaseGuard {
	if (typeof value !== "object" || value === null) throw new Error("invalid writer lease guard");
	const guard = value as Partial<LeaseGuard>;
	if (guard.version !== 1 || !Number.isSafeInteger(guard.processId)) {
		throw new Error("invalid writer lease guard identity");
	}
	if ((guard.processId ?? 0) <= 1 || typeof guard.processToken !== "string") {
		throw new Error("invalid writer lease guard process");
	}
	return guard as LeaseGuard;
}

async function readGuard(path: string): Promise<LeaseGuard> {
	const content = await readFile(path);
	if (content.length > LEASE_BYTES_MAX) throw new Error("writer lease guard exceeds size limit");
	return validateGuard(JSON.parse(content.toString("utf8")));
}

async function acquireGuard(path: string, guard: LeaseGuard): Promise<void> {
	for (let attempt = 0; attempt < LEASE_GUARD_ATTEMPT_COUNT_MAX; attempt += 1) {
		if (
			await publishJsonExclusive(path, guard, {
				bytesMax: LEASE_BYTES_MAX,
			})
		)
			return;
		let owner: LeaseGuard;
		try {
			owner = await readGuard(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (await processTokenMatches(owner.processId, owner.processToken)) {
			throw new WriterLeaseBusyError("workspace writer lease acquisition is already in progress");
		}
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error("workspace writer lease guard could not be acquired");
}

async function replaceStaleLease(path: string): Promise<void> {
	let owner: WriterLease;
	try {
		owner = await readLease(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (await leaseOwnerIsAlive(owner)) {
		throw new WriterLeaseBusyError(`workspace writer lease is held by ${owner.ownerId}`);
	}
	if (
		owner.protectDescendants &&
		(await processEnvironmentMarkerExists(WRITER_OWNER_ENV, owner.ownerId, owner.processGroupId))
	) {
		throw new WriterLeaseBusyError(`workspace writer lease is held by ${owner.ownerId}`);
	}
	await unlink(path);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function waitForWriterLeaseRelease(root: string, cwd: string, deadlineMs: number): Promise<void> {
	const remainingMs = deadlineMs - Date.now();
	if (remainingMs <= 0) throw new WriterLeaseBusyError("writer lease wait timed out");
	const timeoutMs = Math.min(remainingMs, JOB_LAUNCH_LEASE_RECHECK_MS);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = leasePath(root, cwd);
	const name = basename(path);
	const names = new Set([name, `${name}.guard`]);
	const signal = AbortSignal.timeout(timeoutMs);
	const events = watch(root, { signal });
	try {
		if (!(await pathExists(path)) && !(await pathExists(`${path}.guard`))) return;
		let eventCount = 0;
		for await (const event of events) {
			if (!(await pathExists(path)) && !(await pathExists(`${path}.guard`))) return;
			if (event.filename && !names.has(event.filename)) continue;
			eventCount += 1;
			if (eventCount >= LEASE_WAIT_EVENT_COUNT_MAX) {
				throw new WriterLeaseBusyError("writer lease wait event limit exceeded");
			}
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			if (Date.now() < deadlineMs) return;
			throw new WriterLeaseBusyError("writer lease wait timed out");
		}
		throw error;
	} finally {
		await events.return?.();
	}
}

export async function acquireWriterLease(
	root: string,
	cwd: string,
	ownerId: string,
	options: WriterLeaseOptions = {},
): Promise<WriterLease> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = leasePath(root, cwd);
	const lease: WriterLease = {
		version: 2,
		ownerId,
		processId: process.pid,
		processToken: await processToken(process.pid),
		cwd,
		createdAt: new Date().toISOString(),
		protectDescendants: options.protectDescendants ?? false,
		processGroupId: options.processGroupId,
		path,
	};
	const guardPath = `${path}.guard`;
	await acquireGuard(guardPath, {
		version: 1,
		processId: lease.processId,
		processToken: lease.processToken,
	});
	try {
		await replaceStaleLease(path);
		const published = await publishJsonExclusive(path, lease, {
			bytesMax: LEASE_BYTES_MAX,
		});
		if (!published) {
			throw new WriterLeaseBusyError("workspace writer lease appeared during acquisition");
		}
		return lease;
	} finally {
		await unlink(guardPath);
	}
}

interface WriterLeaseRetry {
	attemptsMax: number;
	waitMs: number;
	exhausted: string;
}

// Retry policy for a contended lease, shared by job admission and job state transitions.
// Both wait on release rather than sleeping, so a fast release is picked up immediately.
export async function acquireWriterLeaseWithRetry(
	root: string,
	cwd: string,
	ownerId: string,
	retry: WriterLeaseRetry,
): Promise<WriterLease> {
	const deadlineMs = Date.now() + retry.waitMs;
	for (let attempt = 0; attempt < retry.attemptsMax; attempt += 1) {
		try {
			return await acquireWriterLease(root, cwd, ownerId);
		} catch (error) {
			if (!(error instanceof WriterLeaseBusyError)) throw error;
			await waitForWriterLeaseRelease(root, cwd, deadlineMs);
		}
	}
	throw new WriterLeaseBusyError(retry.exhausted);
}

export async function setWriterLeaseProcessGroup(lease: WriterLease, processGroupId: number): Promise<WriterLease> {
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
		throw new Error("invalid writer lease process group");
	}
	const current = await readLease(lease.path);
	if (current.ownerId !== lease.ownerId || current.processToken !== lease.processToken) {
		throw new Error("refusing to update a writer lease owned by another process");
	}
	const updated = { ...current, processGroupId };
	await replaceJsonAtomic(lease.path, updated, {
		bytesMax: LEASE_BYTES_MAX,
	});
	return updated;
}

export async function releaseWriterLease(lease: WriterLease): Promise<void> {
	let current: WriterLease;
	try {
		current = await readLease(lease.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (current.ownerId !== lease.ownerId || current.processToken !== lease.processToken) {
		throw new Error("refusing to release a writer lease owned by another process");
	}
	if (
		lease.protectDescendants &&
		(await processEnvironmentMarkerExists(WRITER_OWNER_ENV, lease.ownerId, lease.processGroupId))
	) {
		throw new Error("refusing to release a writer lease with active descendants");
	}
	await unlink(lease.path);
}
