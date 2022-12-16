local M = {}

local config_diagnostic = function()
  local virtual_text
  if vim.g.diagnostic_virtual_text then
    virtual_text = true
  else
    virtual_text = { severity = vim.diagnostic.severity.ERROR }
  end
  vim.diagnostic.config({
    underline = false,
    virtual_text = virtual_text,
  })
end

M.setup = function()
  config_diagnostic()
end

local capabilities = require("cmp_nvim_lsp").default_capabilities()
-- capabilities.textDocument.completion.completionItem.snippetSupport = true
M.capabilities = capabilities

M.on_attach = function(_, bufnr)
  require("configs.keymaps").lsp(bufnr)
  -- TODO: Add support back
  -- if client.server_capabilities.documentHighlightProvider then
  -- end
  vim.api.nvim_buf_create_user_command(bufnr, "ToggleVirtualText", function()
    vim.g.diagnostic_virtual_text = not vim.g.diagnostic_virtual_text
    config_diagnostic()
  end, {})
end

return M
