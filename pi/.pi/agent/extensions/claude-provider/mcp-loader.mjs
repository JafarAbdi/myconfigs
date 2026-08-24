import { writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const errorFile = process.env.PI_MCP_ERROR_FILE;
if (!errorFile) throw new Error("PI_MCP_ERROR_FILE is required");

try {
	const piEntry = process.env.PI_CODING_AGENT_ENTRY;
	const serverEntry = process.env.PI_MCP_SERVER_ENTRY;
	if (!piEntry || !serverEntry) {
		throw new Error("PI_CODING_AGENT_ENTRY and PI_MCP_SERVER_ENTRY are required");
	}

	// The MCP server lives outside pi's package tree but reuses extension modules that import pi's
	// bundled TypeBox dependency. Resolve those imports from the pi installation that launched us.
	const requireFromPi = createRequire(piEntry);
	const dependencyUrls = new Map(
		["typebox", "typebox/value"].map((specifier) => [
			specifier,
			pathToFileURL(requireFromPi.resolve(specifier)).href,
		]),
	);
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const url = dependencyUrls.get(specifier);
			return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
		},
	});

	await import(serverEntry);
} catch (error) {
	const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorFile, diagnostic);
	process.stderr.write(`${diagnostic}\n`);
	process.exitCode = 1;
}
