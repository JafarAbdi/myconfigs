local handlers = require("configs.lsp.handlers")
local Path = require("plenary.path")

-- For testing inlayHints
local clangd_cmd = {
  vim.env.HOME .. "/.config/clangd-lsp/bin/clangd",
}
-- local clangd_debug_cmd = vim.deepcopy(clangd_cmd)
-- table.insert(clangd_debug_cmd, "-log=verbose")
-- clangd_cmd = vim.deepcopy(clangd_debug_cmd)

local workspace_root = function(startpath)
  local util = require("lspconfig.util")
  local search_fn = util.root_pattern(
    ".vscode",
    ".clangd",
    ".clang-tidy",
    ".clang-format",
    "compile_commands.json",
    "compile_flags.txt",
    "configure.ac",
    ".git"
  )
  -- If root directory not found set it to file's directory
  local dir = vim.F.if_nil(search_fn(startpath), search_fn(vim.fn.expand("%:p:h")))
    or search_fn(vim.g.clangd_opening_dir)
    or vim.fn.getcwd()
  return dir
end

require("lspconfig").clangd.setup({
  on_attach = function(client, bufnr)
    handlers.on_attach(client, bufnr)
  end,
  capabilities = handlers.capabilities,
  cmd = clangd_cmd,
  init_options = {
    clangdFileStatus = true,
  },
  on_new_config = function(new_config, new_root_dir)
    new_config.cmd = vim.deepcopy(clangd_cmd)
    local root = Path:new(workspace_root(new_root_dir))
    local settings_dir = root:joinpath(".vscode", "settings.json")
    if settings_dir:exists() then
      local settings = vim.json.decode(settings_dir:read())
      vim.list_extend(new_config.cmd, settings["clangd.arguments"])
    end
  end,
  root_dir = workspace_root,
  single_file_support = true,
})
