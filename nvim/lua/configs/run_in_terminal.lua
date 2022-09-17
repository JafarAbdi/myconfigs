return function(cmd, args, opts)
  if cmd == "" then
    vim.notify("Could not run commands '" .. cmd .. "'")
    return
  end

  vim.cmd("botright " .. (opts.height or "15") .. "new")
  vim.fn.termopen(cmd .. " " .. vim.fn.join(args, " "), { cwd = opts.cwd })

  if opts.focus_terminal then
    vim.cmd([[startinsert!]])
  else
    vim.cmd.wincmd("p")
  end
end
