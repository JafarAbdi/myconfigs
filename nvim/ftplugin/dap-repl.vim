inoremap <buffer> <F5> <ESC>:lua require'dap'.continue(); vim.cmd('startinsert!')<CR>
inoremap <buffer> <F10> <ESC>:lua require'dap'.step_out(); vim.cmd('startinsert!')<CR>
inoremap <buffer> <F11> <ESC>:lua require'dap'.step_over(); vim.cmd('startinsert!')<CR>
inoremap <buffer> <F12> <ESC>:lua require'dap'.step_into(); vim.cmd('startinsert!')<CR>

setlocal nonumber norelativenumber cc=-1 nocuc

lua require('dap.ext.autocompl').attach()
