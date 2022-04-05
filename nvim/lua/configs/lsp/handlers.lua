local M = {}

local nvim_status = require("lsp-status")

M.setup = function()
  vim.diagnostic.config({ underline = false })

  nvim_status.config({
    select_symbol = function(cursor_pos, symbol)
      if symbol.valueRange then
        local value_range = {
          ["start"] = {
            character = 0,
            line = vim.fn.byte2line(symbol.valueRange[1]),
          },
          ["end"] = {
            character = 0,
            line = vim.fn.byte2line(symbol.valueRange[2]),
          },
        }

        return require("lsp-status.util").in_range(cursor_pos, value_range)
      end
    end,
    diagnostics = false,
    spinner_frames = { "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷" },
  })
  nvim_status.register_progress()
end

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require("cmp_nvim_lsp").update_capabilities(capabilities)
capabilities = vim.tbl_extend("keep", capabilities, nvim_status.capabilities)
capabilities.textDocument.completion.completionItem.snippetSupport = true
M.capabilities = capabilities

M.on_attach = function(client, bufnr)
  if client.resolved_capabilities.semantic_tokens_full then
    -- TODO: Use lua autocmd interface
    vim.cmd(
      [[autocmd BufEnter,CursorHold,InsertLeave <buffer> lua vim.lsp.buf.semantic_tokens_full()]]
    )
  end
  require("configs.keymaps").lsp_keymaps(bufnr)
  vim.cmd([[ command! Format execute 'lua vim.lsp.buf.formatting()' ]])
  nvim_status.on_attach(client)
end

return M