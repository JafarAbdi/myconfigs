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
    local resolved_fname = vim.fn.fnameescape(vim.fn.resolve(fname))
    if fname == resolved_fname or (vim.bo.filetype ~= "cpp" and vim.bo.filetype ~= "c") then
      return
    end
    P("Symlink detected redirecting to '" .. resolved_fname .. "' instead")
    if vim.fn.exists(":Bwipeout") then
      vim.schedule(function()
        local cursor = vim.api.nvim_win_get_cursor(0)
        vim.api.nvim_command("silent! Bwipeout")
        vim.api.nvim_command("edit " .. resolved_fname)
        vim.api.nvim_win_set_cursor(0, cursor)
      end)
    end
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
          local ok, error = pcall(vim.cmd, "CMake " .. command)
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

-- TODO: This's not ready yet
-- vim.cmd([[ command! ExpandMacro execute "lua ExpandMacro()" ]])

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

-- https://phelipetls.github.io/posts/async-make-in-nvim-with-lua
vim.api.nvim_create_user_command("Make", function(params)
  local lines = { "" }
  local winnr = vim.fn.win_getid()
  local bufnr = vim.api.nvim_win_get_buf(winnr)

  local makeprg = vim.api.nvim_buf_get_option(bufnr, "makeprg")
  if not makeprg then
    return
  end

  local cmd = vim.fn.expandcmd(makeprg .. " " .. params.args)

  local function on_event(on_success_cb)
    return function(job_id, data, event)
      if event == "stdout" or event == "stderr" then
        if data then
          vim.list_extend(lines, data)
        end
      end

      if event == "exit" then
        lines = vim.tbl_filter(function(item)
          return item ~= ""
        end, lines)
        vim.fn.setqflist({}, " ", {
          title = cmd,
          lines = lines,
          efm = vim.api.nvim_buf_get_option(bufnr, "errorformat"),
        })
        vim.cmd("copen")
        vim.cmd("wincmd p")
        if data == 0 then
          if vim.is_callable(on_success_cb) then
            on_success_cb()
          end
        end
      end
    end
  end

  local job_id = vim.fn.jobstart(cmd, {
    on_stderr = on_event(),
    on_stdout = on_event(),
    on_exit = on_event(function()
      if vim.bo.filetype == "cpp" then
        local job_id = vim.fn.jobstart(vim.fn.expand("%:p:r") .. ".out", {
          on_stderr = on_event(),
          on_stdout = on_event(),
          on_exit = on_event(),
          stdout_buffered = true,
          stderr_buffered = true,
          cwd = vim.fn.expand("%:p:h"),
        })
      end
    end),
    stdout_buffered = true,
    stderr_buffered = true,
    cwd = vim.fn.expand("%:p:h"),
  })
end, { nargs = "*" })
