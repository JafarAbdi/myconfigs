if vim.fn.exists("$NVIMRUNNING") == 1 then
  -- can't run nvim inside terminal emulator
  vim.fn.jobstart({
    "nvim",
    -- No need to load plugins
    "-u",
    "NONE",
    "--server",
    vim.env.NVIMRUNNING,
    "--remote",
    -- Convert all paths to absolute form since the files will be opened w.r.t. the servers cwd
    vim.fn.join(
      vim.tbl_map(function(e)
        return vim.fn.fnamemodify(e, ":p")
      end, vim.fn.argv()),
      " "
    ),
  })
  vim.cmd("qall!")
else
  vim.fn.setenv("NVIMRUNNING", vim.api.nvim_get_vvar("servername"))
end

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
