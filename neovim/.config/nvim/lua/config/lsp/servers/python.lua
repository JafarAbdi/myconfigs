local handlers = require("config.lsp.handlers")
local lspconfig = require("lspconfig")
local Path = require("plenary.path")

local workspace_root = lspconfig.util.root_pattern(
  ".vscode",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "package.xml"
)
local init_options = {
  workspace = {
    extraPaths = { vim.env.HOME .. "/.cache/python-stubs" },
    environmentPath = "/usr/bin/python3",
  },
}
-- local cmd = { "jedi-language-server", "-vv", "--log-file", "/tmp/logging.txt" }
local cmd = { "micromamba", "run", "-n", "python-lsp", "jedi-language-server" }
lspconfig.jedi_language_server.setup({
  cmd = cmd,
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  init_options = init_options,
  on_new_config = function(new_config, new_root_dir)
    local root = Path:new(workspace_root(new_root_dir))
    local settings_dir = root:joinpath(".vscode", "settings.json")
    if settings_dir:exists() then
      local ok, settings = pcall(vim.json.decode, settings_dir:read())
      if not ok then
        vim.notify("Error parsing '" .. settings_dir.filename .. "'", vim.log.levels.WARN)
      end
      new_config.init_options.workspace.environmentPath = vim.env.HOME
        .. "/micromamba/envs/"
        .. settings["micromamba.env"]
        .. "/bin/python"
    end
  end,
  root_dir = function(startpath)
    local dir = workspace_root(startpath)
    return dir or vim.loop.cwd()
  end,
})

-- Add scripts to generate stubs
-- lspconfig.pylsp.setup({
--   cmd = { "pylsp", "--verbose", "--log-file", "/tmp/asd.txt" },
--   on_attach = handlers.on_attach,
--   capabilities = handlers.capabilities,
--   settings = {
--     pylsp = {
--       plugins = {
--         -- jedi = {
--         --   extra_paths = { vim.env.HOME .. "/.cache/python-stubs" },
--         -- },
--         pyflakes = { enabled = false },
--         mccabe = { enabled = false },
--         pycodestyle = { enabled = false },
--         flake8 = { enabled = false },
--         pylint = { enabled = true },
--         pylsp_rope = { enabled = true },
--         pyls_isort = { enabled = true },
--         pylsp_mypy = { enabled = true },
--         pylsp_black = { enabled = true },
--       },
--     },
--   },
-- })
