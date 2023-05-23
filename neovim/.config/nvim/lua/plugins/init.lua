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
      vim.api.nvim_set_hl(0, "SpellBad", { sp = "gray", undercurl = true })
      vim.api.nvim_set_hl(0, "SignColumn", { link = "LineNr" })
    end,
  },
  { "mfussenegger/nvim-qwahl" },
  { "mfussenegger/nvim-fzy" },
  -- Used to fix symlink files
  { "famiu/bufdelete.nvim", lazy = false },
  { "github/copilot.vim", event = "VeryLazy" },
  -- Heuristically set buffer options
  { "tpope/vim-sleuth", lazy = false },
  { "tpope/vim-commentary", keys = { { "gc", mode = "v" }, "gcc" } },
  { "wsdjeg/vim-fetch", lazy = false },
  "nvim-lua/plenary.nvim",
}
