vim.g.tex_flavor = "latex"
vim.g.vimtex_view_method = "zathura"
vim.g.vimtex_quickfix_mode = 0
vim.opt.conceallevel = 1
vim.g.tex_conceal = "abdmg"
vim.g.vimtex_imaps_enabled = 0
vim.g.vimtex_quickfix_ignore_filters = {
  "Underfull \\hbox",
  "Overfull \\hbox",
  "LaTeX Warning: .+ float specifier changed to",
  "LaTeX hooks Warning",
  'Package siunitx Warning: Detected the "physics" package:',
  "Package hyperref Warning: Token not allowed in a PDF string",
}
