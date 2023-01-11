if not vim.g.vscode then
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
end

if not vim.g.vscode then
  require("configs.plugins")
end

require("configs.options")
require("configs.commands")
require("configs.disable_builtin")
require("configs.keymaps")
require("configs.autopairs")
require("configs.treesitter")

if not vim.g.vscode then
  require("configs.plugins")
  require("configs.functions")
  require("configs.colorscheme")
  require("configs.cmp")
  require("configs.luasnip")
  require("configs.lint")
  require("configs.dap")
  require("configs.lualine")
  require("configs.lsp")
  require("configs.telescope")
end
