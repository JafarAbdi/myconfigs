vim.cmd[[
if exists('$NVIMRUNNING')
    "can't run nvim inside terminal emulator
    qall!
else
    let $NVIMRUNNING = 1
endif
]]

-- TODO: Cleanup this file
local opt = vim.opt -- global (vim.opt is better than vim.o)
local g = vim.g -- global for let options
local wo = vim.wo -- window local
local bo = vim.bo -- buffer local

--Set highlight on search
vim.o.hlsearch = false
--Make line numbers default
vim.wo.number = true
--Enable mouse mode
vim.o.mouse = "a"
--Enable break indent
vim.o.breakindent = true
--Save undo history
vim.opt.undofile = true
--Case insensitive searching UNLESS /C or capital in search
vim.o.ignorecase = true
vim.o.smartcase = true
--Decrease update time
vim.o.updatetime = 249
vim.wo.signcolumn = "yes"
-- number of visual spaces per TAB
vim.opt.tabstop = 2
-- number of spaces in tab when editing
vim.opt.softtabstop = 2
-- number of spaces to use for autoindent
vim.opt.shiftwidth = 2
-- tabs are space
vim.opt.expandtab = true
vim.opt.autoindent = true
-- copy indent from the previous line
vim.opt.copyindent = true
-- https://vim.fandom.com/wiki/Automatically_wrap_left_and_right
vim.opt.whichwrap = vim.opt.whichwrap + "<,>,h,l,[,]"
-- Hightlight current selected line.
vim.opt.cursorline = true
--Set colorscheme
vim.o.termguicolors = true
vim.cmd([[colorscheme onedark]])

-- Set completeopt to have a better completion experience
-- menuone: popup even when there's only one match
-- noinsert: Do not insert text until a selection is made
-- noselect: Do not select, force user to select one from the menu
vim.o.completeopt = "menuone,noselect,noinsert"

vim.o.linebreak = true
vim.o.autowrite = true
vim.o.inccommand = "nosplit"
vim.o.scrolloff = 2
vim.o.showmatch = true
vim.o.title = true
vim.o.wildmode = "list:longest,full"

vim.g.mapleader = " "
vim.g.maplocalleader = " "

--Map blankline
vim.g.indent_blankline_char = "┊"
vim.g.indent_blankline_filetype_exclude = { "help", "packer" }
vim.g.indent_blankline_buftype_exclude = { "terminal", "nofile" }
vim.g.indent_blankline_show_trailing_blankline_indent = false

--Spell
vim.o.spell = false
vim.o.spelllang = "en"

--Ranger
-- https://github.com/kevinhwang91/rnvimr#advanced-configuration
vim.g.rnvimr_enable_bw = 1
vim.g.rnvimr_enable_picker = 1
vim.g.rnvimr_enable_ex = 1
vim.cmd("highlight link LspComment Comment")
vim.cmd("highlight TSCurrentScope guibg=#242830")

vim.api.nvim_command("let g:surround_no_mappings = 1")

require("configs.disable_builtin")
require("configs.packer")
require("configs")
