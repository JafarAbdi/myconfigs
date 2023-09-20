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
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
  { "Exafunction/codeium.vim", event = "VeryLazy" },
  { "tpope/vim-commentary", keys = { { "gc", mode = "v" }, "gcc" } },
}
