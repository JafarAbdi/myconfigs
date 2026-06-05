import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BudgetLevel = "off" | "low" | "medium" | "high" | "max" | "xhigh";

type RequestPayload = {
    model?: string;
    reasoning_effort?: unknown;
    thinking_budget_tokens?: number;
    chat_template_kwargs?: Record<string, unknown>;
};

const DEFAULT_BUDGETS: Record<BudgetLevel, number> = {
    off: 0,
    low: 1024,
    medium: 4096,
    high: 8192,
    max: 16384,
    xhigh: -1,
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(payload: RequestPayload, ctxModelId: string | undefined): string {
    if (typeof payload.model === "string" && payload.model.length > 0) return payload.model;
    return ctxModelId ?? "";
}

function isQwen(model: string): boolean {
    return model.toLowerCase().includes("qwen");
}

function isLlamaCppProvider(provider: string | undefined): boolean {
    return provider === "llama.cpp";
}

function budgetForLevel(level: BudgetLevel): number {
    return DEFAULT_BUDGETS[level];
}

function payloadThinkingEnabled(payload: RequestPayload): boolean | undefined {
    const enabled = payload.chat_template_kwargs?.enable_thinking;
    if (typeof enabled === "boolean") return enabled;
    return undefined;
}

function normalizeLevel(level: unknown): BudgetLevel {
    if (level === "minimal") return "low";
    if (typeof level === "string" && level in DEFAULT_BUDGETS) return level as BudgetLevel;
    return "medium";
}

function currentLevel(pi: ExtensionAPI, payload: RequestPayload): BudgetLevel {
    if (payloadThinkingEnabled(payload) === false) return "off";
    return normalizeLevel(pi.getThinkingLevel());
}

export default function (pi: ExtensionAPI) {
    pi.on("before_provider_request", (event, ctx) => {
        if (!isObject(event.payload)) return;

        const payload = event.payload as RequestPayload;
        const model = modelId(payload, ctx.model?.id);
        if (!isLlamaCppProvider(ctx.model?.provider)) return;
        if (ctx.model?.reasoning === false) return;

        const chat_template_kwargs = { ...(payload.chat_template_kwargs ?? {}) };
        if (!isQwen(model)) {
            delete chat_template_kwargs.preserve_thinking;
        }

        const level = currentLevel(pi, payload);
        return {
            ...payload,
            reasoning_effort: undefined,
            thinking_budget_tokens: budgetForLevel(level),
            chat_template_kwargs,
        };
    });
}
