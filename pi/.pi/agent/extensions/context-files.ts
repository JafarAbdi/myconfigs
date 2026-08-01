import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function contextFilesExtension(pi: ExtensionAPI) {
	pi.registerCommand("context-files", {
		description: "List Pi context files loaded for this session",
		handler: async (_args, ctx) => {
			const files = ctx.getSystemPromptOptions().contextFiles ?? [];
			pi.sendMessage({
				customType: "context-files",
				content: files.map(({ path }) => path).join("\n") || "No context files loaded.",
				display: true,
			});
		},
	});
}
