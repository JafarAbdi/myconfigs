import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentFromFrontmatter, type Agent } from "./runtimes.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(EXTENSION_DIR, "agents");

export interface AgentCatalog {
	agents: Agent[];
	broken: string[];
}

/**
 * Every readable agent, and the reason each unreadable one was skipped. A malformed definition
 * costs only that role rather than taking `delegate` off the table during extension startup.
 */
export function loadAgents(): AgentCatalog {
	if (!existsSync(AGENTS_DIR)) return { agents: [], broken: [] };
	const agents: Agent[] = [];
	const broken: string[] = [];
	for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const name = entry.name.slice(0, -3);
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
				readFileSync(join(AGENTS_DIR, entry.name), "utf-8"),
			);
			agents.push(agentFromFrontmatter(name, frontmatter, body.trim()));
		} catch (error) {
			broken.push(`${name}: ${error instanceof Error ? error.message : error}`);
		}
	}
	return {
		agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
		broken,
	};
}

/** The current readable definition for one role, if any. */
export function loadAgent(name: string): Agent | undefined {
	return loadAgents().agents.find((agent) => agent.name === name);
}
