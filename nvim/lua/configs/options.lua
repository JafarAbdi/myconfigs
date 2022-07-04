local opt = vim.opt -- global (vim.opt is better than vim.o)
local g = vim.g -- global for let options
local wo = vim.wo -- window local
-- local bo = vim.bo -- buffer local

-- help options
opt.hlsearch = false
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
-- https://vim.fandom.com/wiki/Automatically_wrap_left_and_right
opt.whichwrap = vim.opt.whichwrap + "<,>,h,l,[,]"
opt.cursorline = true
opt.termguicolors = true
opt.completeopt = "menuone,noselect,noinsert"
opt.linebreak = true
opt.autowrite = true
opt.inccommand = "nosplit"
opt.scrolloff = 5
opt.wrap = false
opt.sidescrolloff = 10
opt.path:append("**")
opt.showmatch = true
opt.title = true
opt.wildmode = "list:longest,full"
opt.relativenumber = true

g.do_filetype_lua = 1
g.did_load_filetypes = 0
g.mapleader = " "
g.maplocalleader = " "
g.indent_blankline_char = "┊"
g.indent_blankline_filetype_exclude = { "help", "packer" }
g.indent_blankline_buftype_exclude = { "terminal", "nofile" }
g.indent_blankline_show_trailing_blankline_indent = false

--Spell
opt.spell = false
opt.spelllang:append("en")
g["grammarous#jar_dir"] = vim.env.HOME .. "/.config/languagetool"
-- g["grammarous#default_comments_only_filetypes"] = { ["*"] = 1, ["help"] = 0, ["markdown"] = 0 }
-- g.languagetool_server_command='echo "Server Started"'
-- g.languagetool_server_jar =  vim.env.HOME .. "/.config/languagetool/languagetool_server.jar"
--Diagnostic virtual text
g.diagnostic_virtual_text = false

vim.opt.iskeyword:append("-")

vim.cmd("highlight link LspComment Comment")
vim.cmd("highlight TSCurrentScope guibg=#242830")

vim.api.nvim_command("let g:surround_no_mappings = 1")
