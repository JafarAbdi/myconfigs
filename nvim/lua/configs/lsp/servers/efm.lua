local lspconfig = require("lspconfig")
lspconfig.efm.setup({
  cmd = {
    "efm-langserver",
    "-c",
    vim.env.HOME .. "/myconfigs/efm-langserver/config.yaml",
    "-logfile",
    "/tmp/efm-logging.txt",
    "-loglevel",
    "6",
  },
  filetypes = { "lua", "cmake", "json", "markdown", "rst", "sh", "tex", "yaml", "python" },
  root_dir = function(dir)
    return lspconfig.util.find_git_ancestor(dir) or vim.loop.cwd()
  end,
})
