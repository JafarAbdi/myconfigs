require("impatient")
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
    unpack(vim.tbl_map(function(e)
      return vim.fn.fnamemodify(e, ":p")
    end, vim.fn.argv())),
  })
  vim.cmd.qall({ bang = true })
else
  -- servername is empty inside schroots
  -- TODO: is this a bug????
  local servername = vim.api.nvim_get_vvar("servername")
  if servername == "" then
    servername = vim.fn.serverstart(vim.fn.tempname())
  end
  vim.fn.setenv("NVIMRUNNING", servername)
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
require("configs.neotest")
