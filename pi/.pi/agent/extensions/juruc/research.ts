import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function saveResearchBrief(taskDirectory: string, brief: string): void {
	if (!brief.trim())
		throw new Error("research brief must be nonempty after trimming");
	const directory = lstatSync(taskDirectory, { throwIfNoEntry: false });
	if (
		!directory?.isDirectory() ||
		directory.isSymbolicLink() ||
		realpathSync(taskDirectory) !== taskDirectory
	)
		throw new Error(`${taskDirectory} is not an exact regular task directory`);

	const path = join(taskDirectory, "research.md");
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.isSymbolicLink()))
		throw new Error(`${path} is not a regular file`);

	const temporary = join(
		taskDirectory,
		`.research.md.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, brief, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}
