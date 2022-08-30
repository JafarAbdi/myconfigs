local M = {}

local nvim_status = require("lsp-status")

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

  nvim_status.config({
    diagnostics = false,
  })
  nvim_status.register_progress()
end

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require("cmp_nvim_lsp").update_capabilities(capabilities)
capabilities = vim.tbl_extend("keep", capabilities, nvim_status.capabilities)
capabilities.textDocument.completion.completionItem.snippetSupport = true
M.capabilities = capabilities

M.on_attach = function(client, bufnr)
  -- TODO: Uncomment once https://github.com/neovim/neovim/pull/15723 is merged
  -- if client.server_capabilities.semanticTokensProvider then
  --   -- TODO: Use lua autocmd interface
  --   vim.cmd(
  --     [[autocmd BufEnter,CursorHold,InsertLeave <buffer> lua vim.lsp.buf.semantic_tokens_full()]]
  --   )
  -- end
  if client.server_capabilities.definitionProvider == true then
    vim.api.nvim_buf_set_option(bufnr, "tagfunc", "v:lua.vim.lsp.tagfunc")
  end
  require("configs.keymaps").lsp_keymaps(bufnr)
  vim.api.nvim_buf_create_user_command(bufnr, "ToggleVirtualText", function()
    vim.g.diagnostic_virtual_text = not vim.g.diagnostic_virtual_text
    config_diagnostic()
  end, {})
  nvim_status.on_attach(client)
end

return M
