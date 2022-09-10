local M = {}

----------------
-- Highlights --
----------------

vim.cmd([[
highlight! link SignColumn LineNr
highlight SpellBad guifg=red gui=underline
highlight LspComment guifg=#454a54
highlight TSCurrentScope guibg=#242830
]])

-------------------
-- Auto-commands --
-------------------

local general_group = vim.api.nvim_create_augroup("GeneralCommands", {})
local cpp_group = vim.api.nvim_create_augroup("CppCommands", {})
local templates_group = vim.api.nvim_create_augroup("TemplatesGroup", {})

vim.api.nvim_create_autocmd("BufWritePost", {
  callback = function()
    -- Deletes all trailing whitespaces in a file if it's not binary nor a diff.
    if not vim.o.binary and vim.o.filetype ~= "diff" then
      require("configs.functions").clean_whitespaces()
    end
  end,
  group = general_group,
})
vim.api.nvim_create_autocmd("BufWritePost", {
  callback = function()
    vim.api.nvim_command(":luafile " .. vim.fn.expand("<afile>"))
    vim.api.nvim_command(":PackerCompile")
  end,
  pattern = vim.env.HOME .. "/myconfigs/nvim/lua/**",
  group = general_group,
})

vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })

-- Highlight on yank
vim.api.nvim_create_autocmd({ "TextYankPost" }, {
  group = general_group,
  callback = function()
    vim.highlight.on_yank()
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "qf", "git", "gitAnnotate", "Outline", "diff", "help" },
  callback = function()
    vim.o.spell = false
  end,
  group = general_group,
})
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "cpp", "c" },
  group = cpp_group,
  callback = function()
    require("configs.keymaps").clangd_keymap()
    -- This fixes an issue with nvim-cmp -- see https://github.com/hrsh7th/nvim-cmp/issues/1035#issuecomment-1195456419
    vim.opt_local.cindent = false
  end,
})

-- TODO: Handle make/cmake/gcc cases
local compilers = { cpp = "clang", c = "clang", python = "python", fish = "fish" }
for language, compiler in pairs(compilers) do
  vim.api.nvim_create_autocmd("FileType", {
    pattern = language,
    callback = function()
      vim.cmd.compiler(compiler)
    end,
    group = general_group,
  })
end

M.semantic_tokens_autocmd = function(bufnr)
  vim.api.nvim_create_autocmd({ "CursorHold", "InsertLeave" }, {
    buffer = bufnr,
    group = general_group,
    callback = vim.lsp.buf.semantic_tokens_full,
  })
  -- fire it first time on load as well
  vim.lsp.buf.semantic_tokens_full()
end

---------------
-- Templates --
---------------
-- File shebang
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

vim.api.nvim_create_user_command(
  "ClangdConfig",
  "!config_clangd --build-dir <f-args>",
  { nargs = 1, complete = "dir" }
)
vim.api.nvim_create_user_command("CleanWhitespaces", function()
  require("configs.functions").clean_whitespaces()
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
    return utils.run(
      args[1],
      vim.list_slice(args, 2),
      { cwd = vim.fn.expand("%:p:h"), force_quickfix = false }
    ):after_success(function()
      vim.schedule(function()
        run_in_terminal(
          vim.fn.expand("%:p:r") .. ".out",
          params.fargs,
          { cwd = vim.fn.expand("%:p:h"), focus_terminal = true }
        )
      end)
    end)
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

vim.api.nvim_create_user_command("GenerateAllStubs", function()
  require("configs.functions").generate_all_python_stubs()
end, {})

vim.api.nvim_create_user_command("GenerateStubs", function(params)
  require("configs.functions").generate_python_stubs(params.fargs)
end, { nargs = "*" })

return M
