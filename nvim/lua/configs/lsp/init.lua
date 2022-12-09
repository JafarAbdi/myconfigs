local status_ok, _ = pcall(require, "lspconfig")
if not status_ok then
  return
end

require("configs.lsp.handlers").setup()
local servers = {
  "cpp",
  "rust",
  "cmake",
  "python",
  "efm",
  "ts",
  "lua",
  "yaml",
  "json",
  "markdown",
  "docker",
}
for _, server in pairs(servers) do
  require("configs.lsp.servers." .. server)
end
