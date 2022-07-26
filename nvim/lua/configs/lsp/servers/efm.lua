local lspconfig = require("lspconfig")
lspconfig.efm.setup({
  cmd = { "efm-langserver", "-c", vim.env.HOME .. "/myconfigs/efm-langserver/config.yaml" },
  filetypes = { "lua", "cmake", "json", "markdown", "rst", "sh", "tex", "yaml" },
})
