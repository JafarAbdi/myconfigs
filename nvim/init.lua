-- vim.cmd([[
-- if exists('$NVIMRUNNING')
--     "can't run nvim inside terminal emulator
--     qall!
-- else
--     let $NVIMRUNNING = 1
-- endif
-- ]])

require("configs.options")
require("configs.plugins")
-- Settings
require("configs.cmp")
require("configs.colorscheme")
require("configs.commands")
require("configs.dap").setup()
require("configs.disable_builtin")
require("configs.functions")
require("configs.keymaps")
require("configs.lsp")
require("configs.lualine")
require("configs.luasnip")
require("configs.nvim-treesitter")
require("configs.telescope")
require("configs.autopairs")
require("configs.godbolt")
require("configs.neotest")
