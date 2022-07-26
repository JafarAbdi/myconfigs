local handlers = require("configs.lsp.handlers")
local lspconfig = require("lspconfig")

-- lspconfig.jedi_language_server.setup({
--   -- cmd = {"jedi-language-server", "-vv", "--log-file", "/tmp/logging.txt"},
--   on_attach = handlers.on_attach,
--   capabilities = handlers.capabilities,
-- })
lspconfig.pylsp.setup({
  -- cmd = { "pylsp", "--verbose", "--log-file", "/tmp/asd.txt" },
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
  settings = {
    pylsp = {
      plugins = {
        pyflakes = { enabled = false },
        mccabe = { enabled = false },
        pycodestyle = { enabled = false },
        flake8 = { enabled = false },
        pylint = { enabled = true },
        pylsp_rope = { enabled = true },
        pyls_isort = { enabled = true },
        pylsp_mypy = { enabled = true },
        pylsp_black = { enabled = true },
      },
    },
  },
})
