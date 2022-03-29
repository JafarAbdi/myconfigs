vim.cmd([[
if exists('$NVIMRUNNING')
    "can't run nvim inside terminal emulator
    qall!
else
    let $NVIMRUNNING = 1
endif
]])

require("configs.packer")
-- TODO: Cleanup this file
local opt = vim.opt -- global (vim.opt is better than vim.o)
local g = vim.g -- global for let options
local wo = vim.wo -- window local
-- local bo = vim.bo -- buffer local

--Set highlight on search
opt.hlsearch = false
--Make line numbers default
wo.number = true
--Enable mouse mode
opt.mouse = "a"
--Enable break indent
opt.breakindent = true
--Save undo history
opt.undofile = true
--Case insensitive searching UNLESS /C or capital in search
opt.ignorecase = true
opt.smartcase = true
--Decrease update time
opt.updatetime = 249
wo.signcolumn = "yes"
-- number of visual spaces per TAB
opt.tabstop = 2
-- number of spaces in tab when editing
opt.softtabstop = 2
-- number of spaces to use for autoindent
opt.shiftwidth = 2
-- tabs are space
opt.expandtab = true
opt.autoindent = true
-- copy indent from the previous line
opt.copyindent = true
-- https://vim.fandom.com/wiki/Automatically_wrap_left_and_right
opt.whichwrap = vim.opt.whichwrap + "<,>,h,l,[,]"
-- Highlight current selected line.
opt.cursorline = true
--Set colorscheme
opt.termguicolors = true
vim.cmd([[colorscheme onedark]])

-- Set completeopt to have a better completion experience
-- menuone: popup even when there's only one match
-- noinsert: Do not insert text until a selection is made
-- noselect: Do not select, force user to select one from the menu
opt.completeopt = "menuone,noselect,noinsert"

opt.linebreak = true
opt.autowrite = true
opt.inccommand = "nosplit"
opt.scrolloff = 2
opt.showmatch = true
opt.title = true
opt.wildmode = "list:longest,full"

g.mapleader = " "
g.maplocalleader = " "

--Map blankline
g.indent_blankline_char = "┊"
g.indent_blankline_filetype_exclude = { "help", "packer" }
g.indent_blankline_buftype_exclude = { "terminal", "nofile" }
g.indent_blankline_show_trailing_blankline_indent = false

--Spell
opt.spell = false
opt.spelllang = "en"

--Ranger
-- https://github.com/kevinhwang91/rnvimr#advanced-configuration
g.rnvimr_enable_bw = 1
g.rnvimr_enable_picker = 1
g.rnvimr_enable_ex = 1
vim.cmd("highlight link LspComment Comment")
vim.cmd("highlight TSCurrentScope guibg=#242830")

vim.api.nvim_command("let g:surround_no_mappings = 1")

require("configs.disable_builtin")
require("configs")
