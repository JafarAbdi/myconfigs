local ok, _ = pcall(vim.cmd.colorscheme, "onedark")
if not ok then
  vim.cmd.colorscheme("default")
  vim.opt.background = "dark"
end
