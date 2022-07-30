local terminal_buf

-- Maybe replace with something similar to https://github.com/bobrown101/minimal-nnn.nvim ?
return function(cmd, args, opts)
  if cmd == "" then
    vim.notify("Could not run commands '" .. cmd .. "'")
    return
  end
  local cur_buf = vim.api.nvim_get_current_buf()
  local cur_win = vim.api.nvim_get_current_win()

  if terminal_buf and vim.api.nvim_buf_is_valid(terminal_buf) then
    vim.api.nvim_buf_delete(terminal_buf, { force = true, unload = false })
  end

  vim.api.nvim_command("belowright new")
  terminal_buf = vim.api.nvim_get_current_buf()
  local terminal_win = vim.api.nvim_get_current_win()
  vim.api.nvim_set_current_win(cur_win)

  if terminal_win then
    vim.wo[terminal_win].number = false
    vim.wo[terminal_win].relativenumber = false
    vim.wo[terminal_win].signcolumn = "no"
  end
  vim.api.nvim_win_set_height(terminal_win, opts.height or 10)
  vim.api.nvim_buf_set_name(terminal_buf, "[neovim-cmake-terminal]")

  local ok, path = pcall(vim.api.nvim_buf_get_option, cur_buf, "path")
  if ok then
    vim.api.nvim_buf_set_option(terminal_buf, "path", path)
  end

  local jobid

  local chan = vim.api.nvim_open_term(terminal_buf, {
    on_input = function(_, _, _, data)
      pcall(vim.api.nvim_chan_send, jobid, data)
    end,
  })

  jobid = vim.fn.jobstart(vim.list_extend({ cmd }, args), {
    cwd = opts.cwd,
    pty = true,
    on_stderr = function(_, data)
      vim.api.nvim_chan_send(chan, table.concat(data, "\n"))
    end,
    on_stdout = function(_, data)
      vim.api.nvim_chan_send(chan, table.concat(data, "\n"))
    end,
    on_exit = function(_, exit_code)
      vim.api.nvim_chan_send(chan, "\r\n[Process exited " .. tostring(exit_code) .. "]")
      vim.api.nvim_buf_set_keymap(
        terminal_buf,
        "t",
        "<CR>",
        "<cmd>bd!<CR>",
        { noremap = true, silent = true }
      )
    end,
  })

  if opts.focus_terminal then
    for _, win in pairs(vim.api.nvim_tabpage_list_wins(0)) do
      if vim.api.nvim_win_get_buf(win) == terminal_buf then
        vim.api.nvim_set_current_win(win)
        break
      end
    end
  end
  if jobid == 0 or jobid == -1 then
    vim.notify("Could not spawn terminal", jobid)
  end
end
