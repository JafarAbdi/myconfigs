----------------
-- Highlights --
----------------

vim.cmd([[
highlight! link SignColumn LineNr
highlight SpellBad guifg=red gui=underline
]])
-------------------
-- Auto-commands --
-------------------

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})
local cpp_group = vim.api.nvim_create_augroup("CppCommands", {})
local templates_group = vim.api.nvim_create_augroup("TemplatesGroup", {})

vim.api.nvim_create_autocmd("BufWritePost", {
  callback = function()
    vim.api.nvim_command(":luafile " .. vim.fn.expand("<afile>"))
    vim.api.nvim_command(":PackerCompile")
  end,
  pattern = vim.env.HOME .. "/myconfigs/nvim/lua/**",
  group = general_group,
})
-- A terrible way to handle symlinks
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function()
    local fname = vim.fn.expand("<afile>")
    local resolved_fname = vim.fn.resolve(fname)
    if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
      return
    end
    P("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
    vim.schedule(function()
      local cursor = vim.api.nvim_win_get_cursor(0)
      require("bufdelete").bufwipeout(0, true)
      vim.api.nvim_command("edit " .. resolved_fname)
      vim.api.nvim_win_set_cursor(0, cursor)
    end)
  end,
  group = cpp_group,
})
vim.api.nvim_create_autocmd(
  "User",
  { pattern = "LanguageToolCheckDone", command = "LanguageToolSummary", group = general_group }
)
vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })
-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

vim.api.nvim_create_autocmd(
  { "BufNewFile", "BufRead" },
  { pattern = { "*.launch", "*.test" }, command = "setf xml", group = general_group }
)

vim.api.nvim_create_autocmd(
  { "BufNewFile", "BufRead" },
  { pattern = "*.install", command = "setf text", group = general_group }
)

vim.api.nvim_create_autocmd(
  { "BufNewFile", "BufRead" },
  { pattern = "*.repos", command = "setf yaml", group = general_group }
)

vim.api.nvim_create_autocmd(
  { "BufNewFile", "BufRead" },
  { pattern = { "*.urdf", "*.xacro" }, command = "setf xml", group = general_group }
)

vim.api.nvim_create_autocmd(
  { "BufNewFile", "BufRead" },
  { pattern = "*.code-snippets", command = "setf json", group = general_group }
)

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "qf", "git", "gitAnnotate", "Outline", "diff", "help" },
  callback = function()
    vim.o.spell = false
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("BufWritePost", {
  callback = function()
    -- Deletes all trailing whitespaces in a file if it's not binary nor a diff.
    if not vim.o.binary and vim.o.filetype ~= "diff" then
      _G.CleanWhitespaces()
    end
  end,
  group = general_group,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "cpp", "c" },
  group = cpp_group,
  callback = function()
    vim.keymap.set("n", "<leader>rt", function()
      _G.RunGtest({ at_cursor = true })
    end)
    vim.keymap.set("n", "<leader>cd", function()
      local options = vim.fn.getcompletion("Clangd", "cmdline")
      vim.ui.select(options, { prompt = "Select Command: " }, function(command)
        if not command then
          return
        end
        -- Why it only work with defer?
        vim.defer_fn(function()
          local ok, error = pcall(vim.cmd, command)
          if not ok then
            vim.notify(error, vim.log.levels.ERROR)
          end
        end, 10)
      end)
    end)
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "cpp", "c", "cmake" },
  group = cpp_group,
  callback = function()
    vim.keymap.set("n", "<leader>cm", function()
      local options = vim.fn.getcompletion("CMake ", "cmdline")
      vim.ui.select(options, { prompt = "Select Command: " }, function(command)
        if not command then
          return
        end
        -- Why it only work with defer? vim.schedule?
        vim.defer_fn(function()
          require("configs.cmake").cmake_project(vim.fn.expand("%:p"))
          local ok, error = pcall(require("cmake")[command])
          if not ok then
            vim.notify(error, vim.log.levels.ERROR)
          end
        end, 10)
      end)
    end)
  end,
})

---------------
-- Templates --
---------------
local create_file_templates = function()
  local templates_dir = vim.env.HOME .. "/myconfigs/nvim/file-templates"
  for _, template in ipairs(require("plenary.scandir").scan_dir(templates_dir)) do
    local type_extension = template:match("[^.]+$")
    vim.api.nvim_create_autocmd("BufNewFile", {
      pattern = "*." .. type_extension,
      group = templates_group,
      command = "0r " .. template,
    })
  end
end

create_file_templates()

--------------
-- Commands --
--------------

vim.api.nvim_create_user_command("NvimConfigs", function()
  require("telescope.builtin").find_files({ cwd = "~/myconfigs/nvim" })
end, { desc = "List all nvim configs using telescope" })

vim.api.nvim_create_user_command(
  "ClangdConfig",
  "!config_clangd --build-dir <f-args>",
  { nargs = 1, complete = "dir" }
)

vim.api.nvim_create_user_command("CleanWhitespaces", function()
  _G.CleanWhitespaces()
end, {})

vim.api.nvim_create_user_command("RunGtest", function()
  _G.RunGtest({})
end, {})
vim.api.nvim_create_user_command("DebugGtest", function()
  _G.RunGtest({ at_cursor = true, debug = true })
end, {})

vim.api.nvim_create_user_command("LuaSnipEdit", function()
  require("luasnip.loaders.from_lua").edit_snippet_files()
end, {})

local utils = require("cmake.utils")

local run_in_terminal = require("configs.run_in_terminal")

vim.api.nvim_create_user_command("Make", function(params)
  if not utils.ensure_no_job_active() then
    return
  end

  local winnr = vim.fn.win_getid()
  local bufnr = vim.api.nvim_win_get_buf(winnr)

  local makeprg = vim.api.nvim_buf_get_option(bufnr, "makeprg")
  if not makeprg then
    return
  end

  local cmd = vim.fn.expandcmd(makeprg)
  local args = vim.split(cmd, " ")

  if vim.bo.filetype == "cpp" then
    return utils.run(args[1], vim.list_slice(args, 2), { cwd = vim.fn.expand("%:p:h") }):after_success(
      function()
        vim.schedule(function()
          run_in_terminal(
            vim.fn.expand("%:p:r") .. ".out",
            params.fargs,
            { cwd = vim.fn.expand("%:p:h"), focus_terminal = true }
          )
        end)
      end
    )
  end
  return run_in_terminal(args[1], vim.list_slice(args, 2), { cwd = vim.fn.expand("%:p:h") })
end, { nargs = "*" })

vim.api.nvim_create_user_command("DapAttach", function()
  local finders = require("telescope.finders")
  local pickers = require("telescope.pickers")
  local sorters = require("telescope.sorters")
  local actions = require("telescope.actions")
  local actions_state = require("telescope.actions.state")

  local command = { "ps", "ah" }

  pickers.new({}, {
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

        local parts = vim.fn.split(vim.fn.trim(actions_state.get_selected_entry().value), separator)
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
  }):find()
end, {})

vim.api.nvim_create_user_command("DapLaunch", function()
  require("dap").run(require("configs.dap").launch_in_terminal)
end, {})
