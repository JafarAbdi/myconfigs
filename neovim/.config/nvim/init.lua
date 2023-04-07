if vim.fn.exists("$NVIMRUNNING") == 1 then
  -- can't run nvim inside terminal emulator
  vim.fn.jobstart({
    "nvim",
    -- No need to load plugins
    "-u",
    "NONE",
    "--server",
    vim.env.NVIMRUNNING,
    "--remote",
    -- Convert all paths to absolute form since the files will be opened w.r.t. the servers cwd
    unpack(vim.tbl_map(function(e)
      return vim.fn.fnamemodify(e, ":p")
    end, vim.fn.argv())),
  })
  vim.cmd.qall({ bang = true })
else
  vim.fn.setenv("NVIMRUNNING", vim.api.nvim_get_vvar("servername"))
end

require("config.lazy")
