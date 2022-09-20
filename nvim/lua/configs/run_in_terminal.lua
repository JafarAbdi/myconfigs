return function(cmd, args, opts)
  if cmd == "" then
    vim.notify("Could not run commands '" .. cmd .. "'")
    return
  end

  local terminal_name = "[Run Terminal]"

  local terminal_buffer = require("configs.functions").is_buffer_exists(terminal_name)
  if terminal_buffer then
    vim.api.nvim_buf_delete(terminal_buffer, { force = true, unload = false })
  end
  vim.cmd("botright " .. (opts.height or "15") .. "new")
  vim.fn.termopen(cmd .. " " .. vim.fn.join(args, " "), { cwd = opts.cwd })
  vim.api.nvim_buf_set_name(0, terminal_name)

  if opts.focus_terminal then
    vim.cmd([[startinsert!]])
  else
    vim.cmd.wincmd("p")
  end
end
