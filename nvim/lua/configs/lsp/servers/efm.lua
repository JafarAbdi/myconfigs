local lspconfig = require("lspconfig")
lspconfig.efm.setup({
  cmd = {
    "efm-langserver",
    "-c",
    vim.env.HOME .. "/myconfigs/nvim/lua/configs/lsp/servers/efm.yaml",
    -- "-logfile",
    -- "/tmp/efm-logging.txt",
    -- "-loglevel",
    -- "6",
  },
  root_dir = function(dir)
    return lspconfig.util.find_git_ancestor(dir) or vim.loop.cwd()
  end,
})
