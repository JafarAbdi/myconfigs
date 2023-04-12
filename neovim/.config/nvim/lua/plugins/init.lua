-- load options here, before lazy init while sourcing plugin modules
-- this is needed to make sure options will be correctly applied
-- after installing missing plugins
require("config.options")
require("config.functions")
-- autocmds and keymaps can wait to load
vim.api.nvim_create_autocmd("User", {
  group = vim.api.nvim_create_augroup("lazy_configs", { clear = true }),
  pattern = "VeryLazy",
  callback = function()
    require("config.keymaps")
    require("config.commands")
  end,
})

return {
  -- the colorscheme should be available when starting Neovim
  {
    "JafarAbdi/onedark.nvim",
    lazy = false, -- make sure we load this during startup if it is your main colorscheme
    priority = 1000, -- make sure to load this before all the other start plugins
    config = function()
      -- load the colorscheme here
      vim.cmd.colorscheme("onedark")
      local links = {
        ["@lsp.type.namespace"] = "@namespace",
        ["@lsp.type.type"] = "@type",
        ["@lsp.type.class"] = "@type",
        ["@lsp.type.enum"] = "@type",
        ["@lsp.type.interface"] = "@type",
        ["@lsp.type.struct"] = "@type",
        ["@lsp.type.parameter"] = "@parameter",
        ["@lsp.type.variable"] = "@variable",
        ["@lsp.type.property"] = "@property",
        ["@lsp.type.enumMember"] = "@constant",
        ["@lsp.type.function"] = "@function",
        ["@lsp.type.method"] = "@method",
        ["@lsp.type.macro"] = "@macro",
        ["@lsp.type.decorator"] = "@function",
        ["@lsp.type.keyword"] = "@keyword",
        ["@lsp.type.operator"] = "@operator",
        ["@lsp.type.string"] = "@string",
        ["@lsp.type.number"] = "@number",
      }
      for semantic_tokens_group, treesitter_group in pairs(links) do
        vim.api.nvim_set_hl(0, semantic_tokens_group, { link = treesitter_group, default = true })
      end
    end,
  },
}
