/** Normalize a caught value into an Error at the catch boundary. */
export function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
