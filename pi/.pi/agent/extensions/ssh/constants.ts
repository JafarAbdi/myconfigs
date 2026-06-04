import { homedir } from "node:os";
import { resolve } from "node:path";

export const REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX = 20;
export const REMOTE_FD_CANDIDATES_MAX = 10000;
export const SSH_CONTROL_DIR = resolve(homedir(), ".ssh", "sockets");
export const SSH_CONTROL_PATH = `${SSH_CONTROL_DIR}/%r@%h:%p`;
export const SSH_STATE_CUSTOM_TYPE = "ssh-remote-state";

export const REMOTE_FD_EXCLUDES = [
	".cargo",
	".git",
	".git/*",
	".git/**",
	".idea",
	".jupyter",
	".mypy_cache",
	".pixi",
	".ruff_cache",
	"__pycache__",
	"build",
	"devel",
	"gems",
	"logs",
	"wandb",
];

export const REMOTE_RG_EXCLUDES = [
	".cargo",
	".git",
	".idea",
	".jupyter",
	".mypy_cache",
	".pixi",
	".ruff_cache",
	"__pycache__",
	"build",
	"devel",
	"gems",
	"logs",
	"wandb",
];
