local M = {}
local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})
----------------
-- Highlights --
----------------

vim.api.nvim_set_hl(0, "SpellBad", { sp = "red", underline = true })
vim.api.nvim_set_hl(0, "SignColumn", { link = "LineNr" })

-------------------
-- Auto-commands --
-------------------

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "cpp", "c" },
  group = general_group,
  callback = function()
    -- This fixes an issue with nvim-cmp -- see https://github.com/hrsh7th/nvim-cmp/issues/1035#issuecomment-1195456419
    vim.opt_local.cindent = false
  end,
})
-- A terrible way to handle symlinks
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function(params)
    local fname = params.file
    local resolved_fname = vim.fn.resolve(fname)
    if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
      return
    end
    P("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
    vim.schedule(function()
      local cursor = vim.api.nvim_win_get_cursor(0)
      require("bufdelete").bufwipeout(params.buf, true)
      vim.api.nvim_command("edit " .. resolved_fname)
      vim.api.nvim_win_set_cursor(0, cursor)
    end)
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("TermOpen", {
  callback = function()
    vim.opt_local.signcolumn = "no"
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.winbar = "%#lualine_a_terminal#%=%f%="
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("BufWritePost", {
  callback = function()
    -- Deletes all trailing whitespaces in a file if it's not binary nor a diff.
    if not vim.o.binary and vim.o.filetype ~= "diff" then
      require("config.functions").clean_whitespaces()
    end
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "qf", "git", "gitAnnotate", "Outline", "diff", "help" },
  callback = function()
    vim.o.spell = false
  end,
  group = general_group,
})

--------------
-- Commands --
--------------

vim.api.nvim_create_user_command("CleanWhitespaces", function()
  require("config.functions").clean_whitespaces()
end, {})

vim.api.nvim_create_user_command("SpellToggle", function()
  if vim.opt.spell:get() then
    vim.opt.spell = false
  else
    vim.opt.spell = true
  end
end, {})

vim.api.nvim_create_user_command("DapAttach", function()
  local finders = require("telescope.finders")
  local pickers = require("telescope.pickers")
  local sorters = require("telescope.sorters")
  local actions = require("telescope.actions")
  local actions_state = require("telescope.actions.state")

  local command = { "ps", "ah" }

  pickers
    .new({}, {
      prompt_title = "Select process",
      finder = finders.new_oneshot_job(command),
      sorter = sorters.get_fzy_sorter(),
      attach_mappings = function(prompt_bufnr, _)
        actions.select_default:replace(function()
          local separator = " \\+"
          -- output format for ps ah
          --    " 107021 pts/4    Ss     0:00 /bin/zsh <args>"
          local get_pid = function(parts)
            return parts[1]
          end

          local parts =
            vim.fn.split(vim.fn.trim(actions_state.get_selected_entry().value), separator)
          local pid = get_pid(parts)
          pid = tonumber(pid)
          require("dap").run({
            -- If you get an "Operation not permitted" error using this, try disabling YAMA:
            --  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
            name = "lldb: Attach to process",
            type = "lldb",
            request = "attach",
            pid = pid,
            args = {},
            -- env = function()
            --   local variables = {}
            --   for k, v in pairs(vim.fn.environ()) do
            --     table.insert(variables, string.format("%s=%s", k, v))
            --   end
            --   return variables
            -- end,
          })
          actions.close(prompt_bufnr)
        end)
        return true
      end,
    })
    :find()
end, {})

vim.api.nvim_create_user_command("DapLaunch", function()
  require("dap").run(require("config.dap").launch_in_terminal)
end, {})

vim.api.nvim_create_user_command("DapLaunchPython", function()
  require("dap").run({
    type = "python",
    request = "launch",
    name = "Launch file with arguments",
    program = function()
      return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
    end,
    args = function()
      local args_string = vim.fn.input("Arguments: ")
      return vim.split(args_string, " +")
    end,
    console = "integratedTerminal",
    pythonPath = nil,
    justMyCode = false,
  })
end, {})

vim.api.nvim_create_user_command("DapBreakpointLogMessage", function(params)
  require("dap").toggle_breakpoint(nil, nil, params.args, true)
end, { nargs = "*" })

vim.api.nvim_create_user_command("DapBreakpointConditional", function(params)
  require("dap").toggle_breakpoint(params.args, nil, nil, true)
end, { nargs = "*" })

vim.api.nvim_create_user_command("DapRerunLast", function()
  require("dap").run_last()
end, {})

vim.api.nvim_create_user_command("GenerateAllStubs", function()
  require("config.functions").generate_all_python_stubs()
end, {})

vim.api.nvim_create_user_command("GenerateStubs", function(params)
  require("config.functions").generate_python_stubs(params.fargs)
end, { nargs = "*" })
vim.api.nvim_create_user_command("CESetup", function(opts)
  local options = {
    autocmd = {
      enable = true,
      hl = "Cursorline",
    },
  }
  pcall(vim.api.nvim_clear_autocmds, { group = "CompilerExplorerLive" })
  if opts.args == "local" then
    local Path = require("plenary.path")

    local user_arguments = ""
    local scratch_path = Path:new(vim.env.CPP_SCREATCHES_DIR, "conanbuildinfo.args")
    if scratch_path:exists() then
      user_arguments = scratch_path:read()
    end
    options = vim.tbl_deep_extend(
      "force",
      options,
      { url = "http://localhost:10240", compiler_flags = user_arguments }
    )
    require("compiler-explorer").setup(options)
  elseif opts.args == "online" then
    options =
      vim.tbl_deep_extend("force", options, { url = "https://godbolt.org", compiler_flags = "" })
    require("compiler-explorer").setup(options)
  end
end, {
  nargs = 1,
  complete = function()
    return { "local", "online" }
  end,
})

local compile_md_group = vim.api.nvim_create_augroup("CompileMD", { clear = true })
M.preview_jobs = {}

M.compile_md = function(filename)
  -- TODO: Add an option to select tmp/cwd
  -- vim.fn.fnamemodify(filename, ":p:r") .. ".pdf"
  -- local output_filename = M.preview_jobs[filename] and M.preview_jobs[filename].output_filename
  --   or (vim.fn.tempname() .. ".pdf")
  local output_filename = M.preview_jobs[filename] and M.preview_jobs[filename].output_filename
    or (vim.fn.fnamemodify(filename, ":p:r") .. ".pdf")
  local Job = require("plenary.job")
  local job = Job:new({
    command = "pandoc",
    args = {
      filename,
      "-V",
      "geometry:top=1cm",
      "-V",
      "geometry:left=1cm",
      "-V",
      "geometry:right=1cm",
      "-V",
      "geometry:bottom=2cm",
      "--highlight-style",
      "tango",
      "--filter=" .. debug.getinfo(1).source:match("@?(.*/)") .. "pandoc-svg.py",
      "-o",
      output_filename,
    },
    on_stderr = function(_, data)
      P(data)
    end,
  })
  if M.preview_jobs[filename] and M.preview_jobs[filename].job.is_shutdown then
    M.preview_jobs[filename] = nil
  end
  if not M.preview_jobs[filename] then
    local zathura_job = Job:new({
      command = "zathura",
      args = { output_filename },
    })
    job:and_then_on_success(zathura_job)
    local autocmd_id = vim.api.nvim_create_autocmd({ "BufWritePost" }, {
      group = compile_md_group,
      buffer = vim.fn.bufnr("%"),
      callback = function()
        M.compile_md(filename)
      end,
    })
    M.preview_jobs[filename] = {
      job = zathura_job,
      output_filename = output_filename,
      autocmd_id = autocmd_id,
    }
  end
  job:start()
end

vim.api.nvim_create_user_command("PandocPreview", function()
  local filename = vim.fn.expand("%:p")
  M.compile_md(filename)
end, {})
vim.api.nvim_create_user_command("PandocPreviewStop", function()
  local filename = vim.fn.expand("%:p")
  local pid = M.preview_jobs[filename] and M.preview_jobs[filename].job.pid
  if M.preview_jobs[filename] then
    vim.api.nvim_del_autocmd(M.preview_jobs[filename].autocmd_id)
  end
  if pid then
    vim.loop.kill(pid, 9)
    M.preview_jobs[filename] = nil
  end
end, {})
vim.api.nvim_create_autocmd({ "VimLeavePre" }, {
  group = compile_md_group,
  callback = function()
    for _, preview_job in pairs(M.preview_jobs) do
      local pid = preview_job and preview_job.job and preview_job.job.pid
      if pid then
        vim.loop.kill(pid, 9)
      end
    end
  end,
})

return M
