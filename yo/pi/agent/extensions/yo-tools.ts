import { spawn } from "node:child_process";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function clampScrollbackLines(lines: number): number {
    if (!Number.isFinite(lines)) return 50;
    if (lines < 1) return 50;
    if (lines > 1000) return 1000;
    return Math.floor(lines);
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
    // Force a tool call every turn so the model never replies with free prose.
    // Requires the llama.cpp server to run with --jinja.
    pi.on("before_provider_request", (event) => {
        const payload = event.payload;
        if (payload && typeof payload === "object") {
            (payload as Record<string, unknown>).tool_choice = "required";
        }
        return payload;
    });

    pi.registerTool(commandTool);
    pi.registerTool(chatTool);
    pi.registerTool(scrollbackTool);
    pi.registerTool(docsTool);
}
