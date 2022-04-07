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
vim.api.nvim_create_autocmd("FocusGained", { command = "checktime", group = general_group })
-- Highlight on yank
vim.api.nvim_create_autocmd("TextYankPost", {
  callback = vim.highlight.on_yank,
  group = general_group,
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

vim.cmd(
  [[ command! Notes execute 'lua require("telescope.builtin").find_files({cwd="~/myconfigs/mynotes"})']]
)

vim.cmd(
  [[ command! NvimConfigs execute 'lua require("telescope.builtin").find_files({cwd="~/myconfigs/nvim"})']]
)

vim.cmd(
  [[ command! -nargs=1 -complete=dir ClangdConfig execute '!config_clangd --build-dir <f-args>']]
)

vim.cmd([[ command! ExpandMacro execute "lua ExpandMacro()" ]])

vim.cmd([[ command! Scratch execute "lua Scratch()" ]])
vim.cmd([[ command! CleanWhitespaces execute "lua CleanWhitespaces()" ]])

vim.cmd([[ command! RunGtest execute "lua RunGtest({})" ]])
vim.cmd([[ command! DebugGtest execute "lua RunGtest({at_cursor = true, debug = true})" ]])
vim.cmd([[ command! CppDocumentation execute "lua require('telescope_zeal').show('cpp')" ]])
vim.cmd([[ command! CMakeDocumentation execute "lua require('telescope_zeal').show('cmake')" ]])
vim.cmd([[ command! BoostDocumentation execute "lua require('telescope_zeal').show('boost')" ]])
