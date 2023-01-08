require("lspconfig").dockerls.setup({
  cmd = { "micromamba", "run", "-n", "nodejs", "docker-langserver", "--stdio" },
})
