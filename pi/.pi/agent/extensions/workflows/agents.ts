import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_COUNT_MAX,
	AGENT_DEFINITION_BYTES_MAX,
	AGENT_DESCRIPTION_BYTES_MAX,
	AGENT_DIRECTORY_ENTRY_COUNT_MAX,
	AGENT_NAME_BYTES_MAX,
	AGENT_TOOL_COUNT_MAX,
	AGENT_TOOL_NAME_BYTES_MAX,
} from "./limits.ts";

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
// Manual mirror of Pi's read-only tool names, and the read/write access boundary: a
// "read"-access agent may list only these. Adding a genuinely non-mutating Pi tool (or a
// Pi rename) requires editing this set; validation is fail-closed until then.
const READ_TOOLS = new Set(["fetch_content", "find", "grep", "ls", "read", "web_search"]);

export type AgentAccess = "read" | "write";
export type AgentSkills = "all" | "none";
export type SystemPromptMode = "append" | "replace";

export interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	tools: string[];
	access: AgentAccess;
	skills: AgentSkills;
	systemPrompt: string;
	systemPromptMode: SystemPromptMode;
}

export function agentWithDefaultModel(agent: AgentDefinition, defaultModel?: string): AgentDefinition {
	if (agent.model || !defaultModel) return agent;
	return { ...agent, model: defaultModel };
}

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

export type FrontmatterParser = (content: string) => ParsedFrontmatter;

function parseScalar(value: unknown, field: string, required = false): string | undefined {
	if (value === undefined) {
		if (required) throw new Error(`${field} is required`);
		return undefined;
	}
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const parsed = value.trim();
	if (!parsed) throw new Error(`${field} must not be empty`);
	return parsed;
}

function parseList(value: unknown, field: string): string[] {
	if (value === undefined) throw new Error(`${field} is required`);
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error(`${field} must be a string or string array`);
	}
	const values = Array.isArray(value) ? value : value.split(",");
	if (!values.every((item) => typeof item === "string")) {
		throw new Error(`${field} must contain only strings`);
	}
	const parsed = values.map((item) => item.trim()).filter(Boolean);
	if (parsed.length === 0) throw new Error(`${field} must not be empty`);
	if (new Set(parsed).size !== parsed.length) throw new Error(`${field} contains duplicates`);
	return parsed;
}

function parseSystemPromptMode(value: unknown): SystemPromptMode {
	const mode = parseScalar(value, "systemPromptMode") ?? "append";
	if (mode !== "append" && mode !== "replace") {
		throw new Error("systemPromptMode must be append or replace");
	}
	return mode;
}

function validateTools(tools: unknown, access: AgentAccess): string[] {
	if (!Array.isArray(tools) || tools.length === 0 || tools.length > AGENT_TOOL_COUNT_MAX) {
		throw new Error("invalid agent tools");
	}
	if (
		!tools.every((tool) => {
			return typeof tool === "string" && tool.length > 0 && Buffer.byteLength(tool) <= AGENT_TOOL_NAME_BYTES_MAX;
		})
	) {
		throw new Error("invalid agent tool name");
	}
	if (new Set(tools).size !== tools.length) throw new Error("duplicate agent tool");
	if (access === "read" && tools.some((tool) => !READ_TOOLS.has(tool))) {
		throw new Error("read access cannot include mutation-capable tools");
	}
	return [...tools];
}

export function validateAgentDefinition(value: unknown): AgentDefinition {
	if (typeof value !== "object" || value === null) throw new Error("invalid agent definition");
	const agent = value as Partial<AgentDefinition>;
	if (typeof agent.name !== "string" || !AGENT_NAME_PATTERN.test(agent.name)) {
		throw new Error("invalid agent name");
	}
	if (Buffer.byteLength(agent.name) > AGENT_NAME_BYTES_MAX) throw new Error("agent name too long");
	if (typeof agent.description !== "string" || !agent.description.trim()) {
		throw new Error("invalid agent description");
	}
	if (Buffer.byteLength(agent.description) > AGENT_DESCRIPTION_BYTES_MAX) {
		throw new Error("agent description too long");
	}
	if (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model.trim())) {
		throw new Error("invalid agent model");
	}
	if (agent.access !== "read" && agent.access !== "write") throw new Error("invalid agent access");
	const tools = validateTools(agent.tools, agent.access);
	if (agent.skills !== "all" && agent.skills !== "none") throw new Error("invalid agent skills");
	if (typeof agent.systemPrompt !== "string" || !agent.systemPrompt.trim()) {
		throw new Error("invalid agent system prompt");
	}
	if (Buffer.byteLength(agent.systemPrompt) > AGENT_DEFINITION_BYTES_MAX) {
		throw new Error("agent system prompt exceeds limit");
	}
	if (agent.systemPromptMode !== "append" && agent.systemPromptMode !== "replace") {
		throw new Error("invalid agent system prompt mode");
	}
	return { ...(agent as AgentDefinition), tools };
}

function parseAgent(content: string, parseFrontmatter: FrontmatterParser): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content);
	const access = parseScalar(frontmatter.access, "access", true);
	const skills = parseScalar(frontmatter.skills, "skills", true);
	return validateAgentDefinition({
		name: parseScalar(frontmatter.name, "name", true),
		description: parseScalar(frontmatter.description, "description", true),
		model: parseScalar(frontmatter.model, "model"),
		tools: parseList(frontmatter.tools, "tools"),
		access,
		skills,
		systemPrompt: body.trim(),
		systemPromptMode: parseSystemPromptMode(frontmatter.systemPromptMode),
	});
}

export function discoverAgents(directory: string, parseFrontmatter: FrontmatterParser): AgentDefinition[] {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (entries.length > AGENT_DIRECTORY_ENTRY_COUNT_MAX) {
		throw new Error(`agent directory entry limit exceeded: ${directory}`);
	}
	const agents: AgentDefinition[] = [];
	const names = new Set<string>();
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".md")) continue;
		const filePath = join(directory, entry.name);
		if (statSync(filePath).size > AGENT_DEFINITION_BYTES_MAX) {
			throw new Error(`agent definition exceeds limit: ${filePath}`);
		}
		const agent = parseAgent(readFileSync(filePath, "utf8"), parseFrontmatter);
		if (names.has(agent.name)) throw new Error(`duplicate agent: ${agent.name}`);
		names.add(agent.name);
		agents.push(agent);
	}
	if (agents.length > AGENT_COUNT_MAX) throw new Error("too many agent definitions");
	return agents.sort((left, right) => left.name.localeCompare(right.name));
}
