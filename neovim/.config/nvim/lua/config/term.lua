local function bo(option, value)
  vim.api.nvim_buf_set_option(0, option, value)
end

local M = {}
local jobid = nil
local bufnr = nil
local open_bufnr = nil

function M.close_term()
  if not jobid then
    return
  end
  vim.fn.jobstop(jobid)
  vim.fn.jobwait({ jobid })
end

local new_window = function()
  -- Why I can't call this by indexing vim.cmd???
  vim.cmd("botright " .. math.floor(vim.opt.lines:get() / 4) .. " new")
end

function M.create_term(cmd, args, opts)
  if open_bufnr and vim.api.nvim_buf_is_valid(open_bufnr) then
    vim.api.nvim_buf_delete(open_bufnr, { force = true, unload = false })
    open_bufnr = nil
  end
  opts = vim.tbl_extend("keep", opts or {}, {
    auto_close = true,
    focus_terminal = false,
  })
  args = args or {}
  new_window()
  bufnr = vim.api.nvim_win_get_buf(vim.fn.win_getid())
  bo("buftype", "nofile")
  bo("bufhidden", "wipe")
  bo("buflisted", false)
  bo("swapfile", false)
  local term_opts = {
    cwd = opts.cwd or vim.loop.cwd(),
    on_exit = function()
      jobid = nil
      if opts.auto_close then
        if vim.api.nvim_buf_is_valid(bufnr) then
          vim.api.nvim_buf_delete(bufnr, { force = true, unload = false })
        end
      else
        if open_bufnr then
          print(
            string.format(
              "open_bufnr: %s -- it should be nil you forgot to cleanup the previous terminal buffer",
              open_bufnr
            )
          )
        end
        open_bufnr = bufnr
      end
      bufnr = nil
    end,
  }
  if opts.env and not vim.tbl_isempty(opts.env) then
    term_opts.env = opts.env
  end
  jobid = vim.fn.termopen(cmd .. " " .. vim.fn.join(args, " "), term_opts)

  if opts.focus_terminal then
    vim.cmd.startinsert({ bang = true })
  else
    vim.cmd.wincmd("p")
  end
end

function M.run(cmd, args, opts)
  M.close_term()
  M.create_term(cmd, args, opts)
end

return M
