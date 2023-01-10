local handlers = require("config.lsp.handlers")
local lspconfig = require("lspconfig")
lspconfig.marksman.setup({
  -- cmd = { "marksman", "server", "--verbose", "5" },
  on_attach = handlers.on_attach,
  capabilities = handlers.capabilities,
})
