/**
 * No Binary Read Extension
 *
 * Blocks the `read` tool from reading binary files.
 * Saves you from mojibake when accidentally reading a PDF, .zip, .exe, etc.
 *
 * How it works:
 *   Hooks into the `tool_call` event before any tool executes.
 *   When the tool is `read`, reads the first 4096 bytes of the target file:
 *
 *   1. Checks magic bytes for common image formats (PNG, JPEG, GIF, WebP,
 *      BMP, TIFF, ICO). If matched, allows the read tool to handle the image.
 *   2. Scans for NUL bytes (`\x00`). If found, blocks as generic binary.
 *
 *   Magic-byte detection lets supported images bypass the generic binary
 *   NUL scan. The NUL scan catches everything else (PDF, ZIP, ELF,
 *   compiled objects, etc.).
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
 * Magic bytes for common image formats.
 *
 * Detected at offset 0 (or 0 + variants for TIFF byte-order).
 * This lets images bypass the generic binary NUL-byte scan.
 */
const IMAGE_SIGNATURES: Array<{ ext: string; offset: number; bytes: Buffer }> = [
	// 89 50 4E 47 0D 0A 1A 0A
	{ ext: "PNG",   offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
	// FF D8 FF
	{ ext: "JPEG",  offset: 0, bytes: Buffer.from([0xFF, 0xD8, 0xFF]) },
	// GIF87a / GIF89a
	{ ext: "GIF",   offset: 0, bytes: Buffer.from([0x47, 0x49, 0x46, 0x38]) },
	// RIFF....WEBP (check both the RIFF header and the WEBP fourcc at offset 8)
	{ ext: "WebP",  offset: 0, bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]) },
	// BM
	{ ext: "BMP",   offset: 0, bytes: Buffer.from([0x42, 0x4D]) },
	// II*\x00 / MM\x00*
	{ ext: "TIFF",  offset: 0, bytes: Buffer.from([0x49, 0x49, 0x2A, 0x00]) },
	{ ext: "TIFF",  offset: 0, bytes: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]) },
	// 00 00 01 00 (ICO)
	{ ext: "ICO",   offset: 0, bytes: Buffer.from([0x00, 0x00, 0x01, 0x00]) },
];

/**
 * Check for known image magic bytes. Returns the format name or null.
 *
 * WebP is special: it starts with a RIFF header (shared with AVI, WAV, etc.)
 * and must also have the WEBP fourcc at offset 8.
 */
function detectImageFormat(buffer: Buffer): string | null {
	for (const sig of IMAGE_SIGNATURES) {
		if (buffer.length < sig.offset + sig.bytes.length) continue;
		if (!sig.bytes.equals(buffer.subarray(sig.offset, sig.offset + sig.bytes.length))) continue;

		if (sig.ext === "WebP") {
			const webpFourcc = Buffer.from([0x57, 0x45, 0x42, 0x50]);
			if (buffer.length < 12 || !webpFourcc.equals(buffer.subarray(8, 12))) continue;
		}

		return sig.ext;
	}
	return null;
}

/**
 * Check if a buffer appears to be binary by scanning for NUL bytes.
 *
 * ripgrep uses this same heuristic: NUL bytes are virtually absent from
 * real text files but present in almost all binary formats (PDF, ZIP, ELF,
 * compiled objects, etc.).
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

			const imageFormat = detectImageFormat(bytes);
			if (imageFormat) {
				return undefined;
			}

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
