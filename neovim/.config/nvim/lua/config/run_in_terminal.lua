return function(cmd, args, opts)
  if cmd == "" then
    vim.notify("Could not run commands '" .. cmd .. "'")
    return
  end

  local terminal_name = "[Run Terminal]"

  local terminal_buffer = require("config.functions").is_buffer_exists(terminal_name)
  if terminal_buffer then
    vim.api.nvim_buf_delete(terminal_buffer, { force = true, unload = false })
  end
  -- Why I can't call this by indexing vim.cmd???
  vim.cmd("botright " .. (opts.height or "15") .. "new")
  -- Start sh shell is way faster than initializing the default shell (Fish in my case)
  local shell = vim.opt_local.shell
  vim.opt_local.shell = "/usr/bin/sh"
  local term_opts = { cwd = opts.cwd or vim.loop.cwd() }
  if opts.env and not vim.tbl_isempty(opts.env) then
    term_opts.env = opts.env
  end
  vim.fn.termopen(cmd .. " " .. vim.fn.join(args, " "), term_opts)
  vim.opt_local.shell = shell
  vim.api.nvim_buf_set_name(0, terminal_name)

  if opts.focus_terminal then
    vim.cmd.startinsert({ bang = true })
  else
    vim.cmd.wincmd("p")
  end
end
