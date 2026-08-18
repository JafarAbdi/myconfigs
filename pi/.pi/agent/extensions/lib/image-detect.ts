/**
 * Magic-byte image detection, returning the MIME type claude's vision accepts (jpeg/png/gif/webp)
 * or null for anything else. Ported from pi's `utils/mime.ts` (`detectSupportedImageMimeType`):
 * that function is neither a public export of `@earendil-works/pi-coding-agent` nor resolvable from
 * the bare-node MCP server, so it cannot be imported — this is a deliberate copy of the algorithm.
 *
 * BMP is intentionally dropped from pi's set: Anthropic vision does not accept it, so returning it
 * would only get the image bounced. Animated PNGs are rejected for the same reason.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	return null;
}

function isPng(buffer: Uint8Array): boolean {
	return buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function startsWith(buffer: Uint8Array, prefix: number[]): boolean {
	if (buffer.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (buffer[i] !== prefix[i]) return false;
	}
	return true;
}

function startsWithAscii(buffer: Uint8Array, offset: number, ascii: string): boolean {
	if (buffer.length < offset + ascii.length) return false;
	for (let i = 0; i < ascii.length; i++) {
		if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
	}
	return true;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0
	);
}
