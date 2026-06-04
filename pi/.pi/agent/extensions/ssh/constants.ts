import { homedir } from "node:os";
import { resolve } from "node:path";

export const REMOTE_AUTOCOMPLETE_CANDIDATES_MAX = 100;
export const REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX = 20;
export const SSH_CONTROL_DIR = resolve(homedir(), ".ssh", "sockets");
export const SSH_CONTROL_PATH = `${SSH_CONTROL_DIR}/%r@%h:%p`;
export const SSH_STATE_CUSTOM_TYPE = "ssh-remote-state";

export const REMOTE_FD_EXCLUDES = [
	".git",
	".git/*",
	".git/**",
	".pixi",
	"build",
	"devel",
	"gems",
	".idea",
	".jupyter",
	"logs",
	".mypy_cache",
	"__pycache__",
	".ruff_cache",
	"wandb",
];

export const REMOTE_RG_EXCLUDES = [
	".git",
	".pixi",
	"build",
	"devel",
	"gems",
	".idea",
	".jupyter",
	"logs",
	".mypy_cache",
	"__pycache__",
	".ruff_cache",
	"wandb",
];
