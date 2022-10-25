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
capabilities.textDocument.completion.completionItem.snippetSupport = true
M.capabilities = capabilities

M.on_attach = function(client, bufnr)
  require("configs.keymaps").lsp_keymaps(bufnr)
  if client.server_capabilities.documentHighlightProvider then
    local group = vim.api.nvim_create_augroup("lsp_document_highlight", { clear = true })
    vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
      callback = function()
        vim.lsp.buf.clear_references()
        vim.lsp.buf.document_highlight()
      end,
      group = group,
      buffer = bufnr,
    })
  end
  vim.api.nvim_buf_create_user_command(bufnr, "ToggleVirtualText", function()
    vim.g.diagnostic_virtual_text = not vim.g.diagnostic_virtual_text
    config_diagnostic()
  end, {})
end

return M
