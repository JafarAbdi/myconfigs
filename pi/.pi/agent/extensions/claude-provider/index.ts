/**
 * claude-provider — run the local `claude` CLI as pi's main model.
 *
 * Registers a `claude-cli` provider whose `streamSimple` handler (bridge.ts) spawns host-local
 * `claude -p` per turn, with claude's built-in tools replaced by an MCP server we control, and
 * streams claude's output back as pi assistant events. Auth is the claude CLI's own session; the
 * baseUrl/apiKey here are inert placeholders that only satisfy pi's registration gate (proven in
 * Phase 0: a streamSimple provider still requires api at provider level, plus baseUrl and apiKey).
 *
 * Load-order: this is the directory entry point. There must be no loose `claude-provider.ts` beside
 * it, or both would register the same provider.
 */
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CLAUDE_MODELS } from "../lib/claude-models.ts";
import { runClaudeTurn } from "./bridge.ts";

const PROVIDER_ID = "claude-cli";
const API_TAG = "claude-cli";

// Models come from the shared canonical list (../lib/claude-models.ts); we layer on the fields pi's
// catalog needs. cost is left at zero because the bridge reports claude's actual `total_cost_usd` per
// turn — pi's per-token estimate is never the source of truth here.
export default function (pi: ExtensionAPI): void {
	const config: ProviderConfig = {
		name: "Claude CLI",
		api: API_TAG,
		// Inert: streamSimple bypasses HTTP entirely. The .invalid host guarantees a loud DNS failure
		// if pi ever falls back to a real request; the apiKey is never sent anywhere.
		baseUrl: "https://claude-cli.local.invalid",
		apiKey: "managed-by-claude-cli",
		models: CLAUDE_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			api: API_TAG,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
		streamSimple: (model, context, options) => runClaudeTurn(model, context, options),
	};
	pi.registerProvider(PROVIDER_ID, config);
}
