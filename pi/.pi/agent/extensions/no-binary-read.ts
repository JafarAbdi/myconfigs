/**
 * No Binary Read Extension
 *
 * Blocks the `read` tool from reading binary files.
 * Saves you from mojibake when accidentally reading a PDF, .zip, .exe, etc.
 *
 * How it works:
 *   Hooks into the `tool_call` event before any tool executes.
 *   When the tool is `read`, reads the first 4096 bytes of the target file
 *   and checks for NUL bytes (`\x00`). If found, the file is classified as
 *   binary and the read is blocked with a clear error to the model.
 *
 * Detection strategy (ripgrep-style):
 *   A NUL byte is a near-definitive signal of binary content. Text files
 *   almost never contain them; binary files almost always do. The check is
 *   extremely fast (scans at most 4KB).
 *
 * Alternative approach (zlib txtvsbin.txt):
 *   For more rigorous detection with non-Latin text encodings, the zlib
 *   algorithm classifies bytes into allow/block lists: bytes 0x00-0x06 and
 *   0x0E-0x1F are "blocked" control characters; everything else (TAB, LF,
 *   CR, 0x20-0xFF) is allowed text. Uses counting instead of presence check
 *   to tolerate "polluted" text files (e.g. a CSV with embedded NULs).
 *   Overkill for our use case since UTF-8 encoded non-Latin text (CJK,
 *   Greek, Cyrillic) has no NUL bytes, and the read tool already handles
 *   UTF-8 correctly.
 *
 * Install:
 *   Save to ~/.pi/agent/extensions/no-binary-read.ts (user scope)
 *   Save to .pi/extensions/no-binary-read.ts   (project scope)
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { open } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Check if a buffer appears to be binary by scanning for NUL bytes.
 *
 * ripgrep uses this same heuristic: NUL bytes are virtually absent from
 * real text files but present in almost all binary formats (PDF, ZIP, ELF,
 * images, compiled objects, etc.).
 *
 * 4KB is enough to catch binary headers: PDF's cross-reference table has
 * NULs, ZIP local file headers have NULs, ELF section headers have NULs.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
	return buffer.includes(0);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "read") {
			return undefined;
		}

		const rawPath = (event.input as Record<string, unknown>).path as string | undefined;
		if (!rawPath) {
			return undefined;
		}

		// Normalize tilde, then resolve against cwd. resolve() passes
		// absolute paths through unchanged, handles relative correctly.
		const resolvedPath = resolve(rawPath.replace(/^~(\/|$)/, `${homedir()}$1`));

		let fileHandle;
		try {
			fileHandle = await open(resolvedPath, "r");
		} catch {
			return undefined;
		}

		try {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await fileHandle.read(buffer, 0, 4096, 0);
			const bytes = buffer.subarray(0, bytesRead);

			if (isBinaryBuffer(bytes)) {
				return {
					block: true,
					reason: `File "${rawPath}" is binary.`,
				};
			}

			return undefined;
		} finally {
			await fileHandle.close();
		}
	});
}
