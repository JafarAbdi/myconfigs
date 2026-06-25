import { spawn } from "node:child_process";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type YoMessage = {
    role?: string;
    content?: unknown;
    [key: string]: unknown;
};

const HISTORY_EXCHANGES_MAX = 10;
const HISTORY_TOKEN_BUDGET = 4096;
const CHARS_PER_TOKEN = 4;

function clampScrollbackLines(lines: number): number {
    if (!Number.isFinite(lines)) return 50;
    if (lines < 1) return 50;
    if (lines > 1000) return 1000;
    return Math.floor(lines);
}

function estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

function splitTurns(messages: YoMessage[]): YoMessage[][] {
    const turns: YoMessage[][] = [];
    for (const message of messages) {
        if (message.role === "user" || turns.length === 0) {
            turns.push([message]);
        } else {
            turns[turns.length - 1].push(message);
        }
    }
    return turns;
}

function pruneYoMessages(messages: YoMessage[]): YoMessage[] {
    const turns = splitTurns(messages);
    if (turns.length === 0) return messages;

    const current = turns[turns.length - 1];
    let tokens = estimateTokens(current);
    const selected: YoMessage[][] = [current];

    for (let index = turns.length - 2; index >= 0; index--) {
        if (selected.length > HISTORY_EXCHANGES_MAX) break;

        const turn = turns[index];
        const turnTokens = estimateTokens(turn);
        if (tokens + turnTokens > HISTORY_TOKEN_BUDGET) break;

        selected.unshift(turn);
        tokens += turnTokens;
    }

    return selected.flat();
}

async function run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { env: process.env });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        child.stderr.resume();
        child.on("error", () => {
            resolve("(No terminal output available)");
        });
        child.on("close", (code) => {
            if (code !== 0) {
                resolve("(No terminal output available)");
                return;
            }
            resolve(output.trimEnd() || "(No terminal output available)");
        });
    });
}

const commandTool = defineTool({
    name: "command",
    label: "Command",
    description: "Return a Fish command for prompt prefill.",
    parameters: Type.Object({
        command: Type.String({ description: "The Fish shell command to prefill" }),
        explanation: Type.String({ description: "Brief explanation shown before the command" }),
        pending: Type.Optional(Type.Boolean({ description: "True for a multi-step sequence that needs output before the next command" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
        return {
            content: [{ type: "text", text: params.explanation }],
            details: {
                type: "command",
                command: params.command,
                explanation: params.explanation,
                pending: params.pending === true,
            },
            terminate: true,
        };
    },
});

const chatTool = defineTool({
    name: "chat",
    label: "Chat",
    description: "Return a text response.",
    parameters: Type.Object({
        response: Type.String({ description: "Text response to the user" }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
        return {
            content: [{ type: "text", text: params.response }],
            details: {
                type: "chat",
                response: params.response,
            },
            terminate: true,
        };
    },
});

const scrollbackTool = defineTool({
    name: "scrollback",
    label: "Scrollback",
    description: "Return recent WezTerm pane text.",
    parameters: Type.Object({
        lines: Type.Integer({ description: "Number of recent lines to retrieve, max 1000" }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
        const lines = clampScrollbackLines(params.lines);
        const paneId = process.env.WEZTERM_PANE;
        if (!paneId) {
            return {
                content: [{ type: "text", text: "(No terminal output available)" }],
                details: { type: "scrollback", lines, available: false },
            };
        }

        const text = await run("wezterm", [
            "cli",
            "get-text",
            "--pane-id",
            paneId,
            "--start-line",
            `-${lines}`,
        ]);
        return {
            content: [{ type: "text", text }],
            details: { type: "scrollback", lines, available: text !== "(No terminal output available)" },
        };
    },
});

const docsTool = defineTool({
    name: "docs",
    label: "Docs",
    description: "Return Fish syntax notes.",
    parameters: Type.Object({
        request: Type.Optional(Type.String({ description: "Fish syntax topic" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
        const topic = params.request ? `Topic: ${params.request}\n\n` : "";
        const text = `${topic}Fish syntax reminders:\n- Variables: \`set name value\`.\n- Exported variables: \`set -gx NAME value\`.\n- Command substitution: \`(command)\`, not \`$(command)\`.\n- Conditionals: \`if test ...; ...; end\`.\n- Loops: \`for item in ...; ...; end\`.\n- Functions: \`function name; ...; end\`.\n- Avoid Bash-only syntax: \`[[ ... ]]\`, arrays, \`\${var}\`, and \`export NAME=value\`.`;
        return {
            content: [{ type: "text", text }],
            details: { type: "docs", request: params.request ?? "" },
        };
    },
});

export default function (pi: ExtensionAPI) {
    pi.on("context", async (event) => {
        return { messages: pruneYoMessages(event.messages as YoMessage[]) as typeof event.messages };
    });

    pi.registerTool(commandTool);
    pi.registerTool(chatTool);
    pi.registerTool(scrollbackTool);
    pi.registerTool(docsTool);
}
