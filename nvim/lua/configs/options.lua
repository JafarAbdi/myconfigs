local opt = vim.opt -- global (vim.opt is better than vim.o)
local g = vim.g -- global for let options
local wo = vim.wo -- window local
-- local bo = vim.bo -- buffer local

-- help options
opt.number = true
opt.mouse = "a"
opt.breakindent = true
opt.undofile = true
opt.ignorecase = true
opt.smartcase = true
opt.updatetime = 250
wo.signcolumn = "yes"
opt.tabstop = 2
opt.softtabstop = 2
opt.shiftwidth = 2
opt.expandtab = true
opt.autoindent = true
opt.copyindent = true
opt.cursorline = true
opt.termguicolors = true
opt.hlsearch = false
opt.completeopt = "menuone,noselect,noinsert"
opt.linebreak = true
opt.autowrite = true
opt.inccommand = "nosplit"
opt.scrolloff = 5
opt.wrap = false
opt.sidescrolloff = 10
opt.showmatch = true
opt.title = true
opt.wildmode = "list:longest,full"
opt.relativenumber = true
opt.titlestring = "NVIM: %{substitute(getcwd(), $HOME, '~', '')}%a%r%m "

g.mapleader = " "
g.maplocalleader = " "
g.indent_blankline_char = "┊"
g.indent_blankline_filetype_exclude = { "help", "packer" }
g.indent_blankline_buftype_exclude = { "terminal", "nofile" }
g.indent_blankline_show_trailing_blankline_indent = false

--Spell
opt.spell = false
opt.spelllang:append("en")
--Diagnostic virtual text
g.diagnostic_virtual_text = false

vim.opt.iskeyword:append("-")
g.copilot_no_tab_map = true
g.copilot_assume_mapped = true
g.copilot_tab_fallback = ""
g.copilot_filetypes = {
  ["*"] = true,
  gitcommit = false,
  TelescopePrompt = false,
  ["dap-repl"] = false,
  dapui_watches = false,
}

g.netrw_list_hide = [[,\(^\|\s\s\)\zs\.\S\+]]
g.netrw_altv = 1
g.netrw_keepdir = 0
g.netrw_winsize = 20
g.netrw_localcopydircmd = "cp -r"
g.netrw_liststyle = 3
g.netrw_banner = 0
g.netrw_bufsettings = "signcolumn=no noma nomod nu nobl nowrap ro"

vim.filetype.add({
  extension = {
    launch = "xml",
    test = "xml",
    urdf = "xml",
    xacro = "xml",
    install = "text",
    repos = "yaml",
    ["code-snippets"] = "json",
  },
})
