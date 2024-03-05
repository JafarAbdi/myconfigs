return {
  {
    "nvimdev/epo.nvim",
    event = { "LspAttach" },
    config = function()
      require("epo").setup({
        -- fuzzy match
        fuzzy = false,
        -- increase this value can avoid trigger complete when delete character.
        debounce = 50,
        -- when completion confirm auto show a signature help floating window.
        signature = true,
        -- vscode style json snippet path
        snippet_path = nil,
        -- border for lsp signature popup, :h nvim_open_win
        signature_border = "rounded",
        -- lsp kind formatting, k is kind string "Field", "Struct", "Keyword" etc.
        kind_format = function(k)
          return k:lower()
        end,
      })
    end,
  },
}
