local handlers = require("configs.lsp.handlers")
local lspconfig = require("lspconfig")

-- local cmd = { "jedi-language-server", "-vv", "--log-file", "/tmp/logging.txt" }
lspconfig.jedi_language_server.setup({
  -- cmd = cmd,
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  init_options = {
    workspace = {
      extraPaths = { vim.env.HOME .. "/.cache/python-stubs" },
    },
  },
  root_dir = function(startpath)
    local dir = lspconfig.util.root_pattern(
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "package.xml"
    )(startpath)
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
