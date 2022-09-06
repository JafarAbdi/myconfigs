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

g.mapleader = " "
g.maplocalleader = " "
g.indent_blankline_char = "┊"
g.indent_blankline_filetype_exclude = { "help", "packer" }
g.indent_blankline_buftype_exclude = { "terminal", "nofile" }
g.indent_blankline_show_trailing_blankline_indent = false

--Spell
opt.spell = false
opt.spelllang:append("en")
-- g["grammarous#jar_dir"] = vim.env.HOME .. "/.config/languagetool"
-- g["grammarous#default_comments_only_filetypes"] = { ["*"] = 1, ["help"] = 0, ["markdown"] = 0 }
-- g.languagetool_server_command='echo "Server Started"'
-- g.languagetool_server_jar =  vim.env.HOME .. "/.config/languagetool/languagetool_server.jar"
--Diagnostic virtual text
g.diagnostic_virtual_text = false

vim.opt.iskeyword:append("-")

vim.cmd("highlight link LspComment Comment")
vim.cmd("highlight TSCurrentScope guibg=#242830")

g.netrw_list_hide = vim.fn["netrw_gitignore#Hide"]() .. [[,\(^\|\s\s\)\zs\.\S\+]]
g.netrw_altv = 1
g.netrw_keepdir = 0
g.netrw_winsize = 20
g.netrw_localcopydircmd = "cp -r"
g.netrw_liststyle = 3
g.netrw_banner = 0

vim.g.do_filetype_lua = 1
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
