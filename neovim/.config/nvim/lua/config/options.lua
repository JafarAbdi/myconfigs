vim.opt.number = true
vim.opt.mouse = "a"
vim.opt.undofile = true
vim.opt.breakindent = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.updatetime = 250
vim.opt.tabstop = 2
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.autoindent = true
vim.opt.copyindent = true
vim.opt.cursorline = true
vim.opt.termguicolors = true
vim.opt.hlsearch = false
vim.opt.linebreak = true
vim.opt.autowrite = true
vim.opt.inccommand = "nosplit"
vim.opt.wrap = false
vim.opt.showmatch = true
vim.opt.title = true
vim.opt.relativenumber = true
vim.opt.titlestring = "NVIM: %{substitute(getcwd(), $HOME, '~', '')}%a%r%m "
vim.opt.shortmess:append("wIA")
vim.opt.matchtime = 2
vim.opt.matchpairs:append("<:>")
vim.opt.swapfile = false
vim.opt.signcolumn = "number"
vim.opt.laststatus = 3
vim.opt.statusline =
  [[%<%f %m%r%{luaeval("require('config.functions').lsp_status()")} %{luaeval("require('config.functions').codeium_status()")} %= %{luaeval("require('config.functions').dap_status()")}]]
vim.opt.smartindent = false
vim.opt.pumheight = 20
vim.opt.completeopt = "menuone,noselect,noinsert"
vim.opt.complete:append({ "U", "i", "d" })
vim.opt.wildmode = "longest:full,full"
vim.opt.wildignore:append({ "*.pyc", ".git", ".idea", "*.o" })
vim.opt.wildoptions = "pum,tagfile,fuzzy"
vim.opt.suffixes:append({ ".pyc", ".tmp" })

if vim.fn.executable("rg") == 1 then
  vim.opt.grepprg = "rg --no-messages --vimgrep --no-heading --smart-case"
  vim.opt.grepformat = "%f:%l:%c:%m,%f:%l:%m"
end

vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.g.codeium_disable_bindings = 1
vim.g.codeium_filetypes = {
  gitcommit = false,
  ["dap-repl"] = false,
}

vim.g.netrw_list_hide = [[,\(^\|\s\s\)\zs\.\S\+]]
vim.g.netrw_altv = 1
vim.g.netrw_keepdir = 0
vim.g.netrw_winsize = 20
vim.g.netrw_localcopydircmd = "cp -r"
vim.g.netrw_liststyle = 3
vim.g.netrw_banner = 0
vim.g.netrw_bufsettings = "signcolumn=no noma nomod nu nobl nowrap ro"

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

-- https://github.com/neovim/neovim/pull/26641
vim.cmd.colorscheme("vim")
vim.cmd.colorscheme("onedark")
