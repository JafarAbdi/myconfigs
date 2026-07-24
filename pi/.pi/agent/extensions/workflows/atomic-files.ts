import { randomUUID } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface AtomicFileOptions {
	bytesMax: number;
	durable?: boolean;
}

function jsonTextBounded(value: unknown, bytesMax: number): string {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(text) > bytesMax) throw new Error("JSON file exceeds write limit");
	return text;
}

export async function syncParentDirectory(path: string): Promise<void> {
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function writeTemporary(path: string, content: string, durable: boolean): Promise<string> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content);
		if (durable) await file.sync();
		await file.close();
		return temporary;
	} catch (error) {
		try {
			await file.close();
		} finally {
			await removeTemporary(temporary);
		}
		throw error;
	}
}

async function removeTemporary(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function replaceTextAtomic(path: string, content: string, options: AtomicFileOptions): Promise<void> {
	if (Buffer.byteLength(content) > options.bytesMax) {
		throw new Error("file exceeds write limit");
	}
	const durable = options.durable ?? false;
	const temporary = await writeTemporary(path, content, durable);
	try {
		await rename(temporary, path);
		if (durable) await syncParentDirectory(path);
	} finally {
		await removeTemporary(temporary);
	}
}

export async function replaceJsonAtomic(path: string, value: unknown, options: AtomicFileOptions): Promise<void> {
	await replaceTextAtomic(path, jsonTextBounded(value, options.bytesMax), options);
}

export async function publishJsonExclusive(path: string, value: unknown, options: AtomicFileOptions): Promise<boolean> {
	const durable = options.durable ?? false;
	const temporary = await writeTemporary(path, jsonTextBounded(value, options.bytesMax), durable);
	try {
		try {
			await link(temporary, path);
			if (durable) await syncParentDirectory(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		await removeTemporary(temporary);
	}
}
