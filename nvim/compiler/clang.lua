vim.g.current_compiler = "clang"

vim.opt_local.makeprg = "clang++ %:p -o %:p:r.out"

if vim.fn.filereadable(vim.fn.expand("%:p:h") .. "/conanbuildinfo.args") == 1 then
  if vim.fn.executable("mold") == 1 then
    vim.opt_local.makeprg:append(" -fuse-ld=mold")
  end
  vim.opt_local.makeprg:append(" @conanbuildinfo.args")
end
vim.opt_local.errorformat = "%f:%l:%c: %m"
