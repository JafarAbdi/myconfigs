local M = {}

-- Debugging
vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("i", "<C-e>", function()
  return vim.fn["copilot#Accept"]()
end, { expr = true })
vim.keymap.set("i", "<c-;>", function()
  return vim.fn["copilot#Next"]()
end, { expr = true })
vim.keymap.set("i", "<c-,>", function()
  return vim.fn["copilot#Previous"]()
end, { expr = true })
vim.keymap.set("i", "<c-c>", function()
  -- Leave insert mode and cancel completion
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
  return vim.fn["copilot#Dismiss"]()
end, { expr = true })
local function accept_word()
  vim.fn["copilot#Accept"]("")
  local bar = vim.fn["copilot#TextQueuedForInsertion"]()
  return vim.fn.split(bar, [[[ .]\zs]])[1]
end
local function accept_line()
  vim.fn["copilot#Accept"]("")
  local bar = vim.fn["copilot#TextQueuedForInsertion"]()
  return vim.fn.split(bar, [[[\n]\zs]])[1]
end

vim.keymap.set("i", "<C-M-l>", accept_line, { expr = true, remap = false })
vim.keymap.set("i", "<C-M-e>", accept_word, { expr = true, remap = false })
-- https://github.com/vscode-neovim/vscode-neovim/tree/master/vim
local keymap = function(mode, lhs, callback, bufnr)
  vim.keymap.set(
    mode,
    lhs,
    callback,
    bufnr and { silent = true, buffer = bufnr } or { silent = true }
  )
end

keymap("n", "<leader>f", function()
  vim.lsp.buf.format({ async = true })
end)
M.lsp = function(bufnr)
  if bufnr then
    vim.api.nvim_buf_set_keymap(
      bufnr,
      "v",
      "<leader>ca",
      "<Esc><cmd>lua vim.lsp.buf.range_code_action()<CR>",
      { noremap = true, silent = true }
    )
  end
  keymap("n", "<C-k>", vim.lsp.buf.signature_help, bufnr)
  keymap("n", "<leader>ca", vim.lsp.buf.code_action, bufnr)
  keymap("n", "gw", function()
    require("telescope.builtin").lsp_dynamic_workspace_symbols({
      symbol_width = 0.3,
      fname_width = 0.6,
      symbol_type_width = 0.1,
    })
  end, bufnr)
  keymap("n", "K", vim.lsp.buf.hover, bufnr)
  local lsp_action = function(callback)
    return function()
      callback({ fname_width = 0.55 })
    end
  end
  keymap("n", "gi", lsp_action(require("telescope.builtin").lsp_implementations), bufnr)
  keymap("n", "gr", lsp_action(require("telescope.builtin").lsp_references), bufnr)
  keymap("n", "gt", lsp_action(require("telescope.builtin").lsp_type_definitions), bufnr)
  keymap("n", "gd", lsp_action(require("telescope.builtin").lsp_definitions), bufnr)
  keymap("n", "gs", function()
    require("telescope.builtin").lsp_document_symbols({
      symbol_width = 0.9,
      symbol_type_width = 0.1,
    })
  end, bufnr)
  keymap("n", "<F2>", vim.lsp.buf.rename, bufnr)
end
local run_file = function(is_test)
  local filetype = require("plenary.filetype").detect(vim.fn.expand("%:p"))
  if filetype == "markdown" then
    vim.cmd.write()
    return
  end

  local dirname = vim.fn.expand("%:p:h")
  local root_dir = require("config.functions").root_dirs[filetype]
  if root_dir then
    root_dir = root_dir(dirname) or dirname
  else
    root_dir = dirname
    for dir in vim.fs.parents(vim.api.nvim_buf_get_name(0)) do
      if vim.env.HOME == dir then
        break
      end
      if vim.fn.isdirectory(dir .. "/.vscode") == 1 then
        root_dir = dir
        break
      end
    end
  end

  vim.cmd.write()
  local args = {
    "run",
    "-n",
    "myconfigs",
    "python3",
    "~/.local/bin/build_project.py",
    "--workspace-folder",
    root_dir,
    "--filetype",
    filetype,
    "--file-path",
    vim.fn.expand("%:p"),
  }
  if is_test then
    table.insert(args, "--test")
  end
  local run_in_terminal = require("config.run_in_terminal")
  run_in_terminal("micromamba", args, { cwd = root_dir })
  -- run_in_terminal("build_project.py", args, { cwd = root_dir })
end
keymap("n", "<leader>t", function()
  run_file(true)
end)
keymap("n", "<leader>x", function()
  run_file(false)
end)
keymap("n", "<leader><space>", require("telescope.builtin").buffers)
keymap("n", "<leader>gc", require("telescope.builtin").current_buffer_fuzzy_find)
keymap("n", "<leader>gr", require("telescope.builtin").resume)
keymap("n", "<leader>h", require("telescope.builtin").help_tags)
keymap("n", "<C-S-s>", require("telescope.builtin").grep_string)
keymap("n", "<C-M-s>", function()
  require("telescope.builtin").grep_string({ grep_open_files = true })
end)
keymap("n", "<C-M-f>", function()
  require("telescope.builtin").live_grep({ grep_open_files = true })
end)
keymap("n", "<C-S-f>", require("telescope.builtin").live_grep)
keymap("n", "<M-o>", require("telescope.builtin").find_files)
keymap("n", "<C-S-p>", require("telescope.builtin").commands)
keymap("n", "<leader>ro", require("telescope.builtin").oldfiles)
keymap("n", "<C-S-e>", vim.cmd.Lexplore)
keymap("n", "<leader>j", function()
  require("telescope.builtin").jumplist({ fname_width = 0.6 })
end)

-- Diagnostic keymaps
keymap("n", "<leader>df", vim.diagnostic.open_float)
keymap("n", "<leader>d<Up>", function()
  vim.diagnostic.goto_prev({ severity = vim.diagnostic.severity.ERROR })
end)
keymap("n", "<leader>d<Down>", function()
  vim.diagnostic.goto_next({ severity = vim.diagnostic.severity.ERROR })
end)
keymap("n", "<leader>dq", function()
  require("telescope.builtin").diagnostics(vim.tbl_deep_extend("error", { bufnr = 0 }, {}))
end)

-- This will expand the current item or jump to the next item within the snippet.
keymap({ "i", "s" }, "<c-j>", function()
  local ls = require("luasnip")
  if ls.expand_or_jumpable() then
    ls.expand_or_jump()
  end
end)

-- This always moves to the previous item within the snippet
keymap({ "i", "s" }, "<c-k>", function()
  local ls = require("luasnip")
  if ls.jumpable(-1) then
    ls.jump(-1)
  end
end)

-- This is useful for choice nodes (introduced in the forthcoming episode 2)
keymap("i", "<c-l>", function()
  local ls = require("luasnip")
  if ls.choice_active() then
    ls.change_choice(1)
  end
end)

-- Tab switching
keymap("n", "<C-t>", ":tabedit<CR>")
keymap("n", "<A-1>", "1gt")
keymap("n", "<A-2>", "2gt")
keymap("n", "<A-3>", "3gt")
keymap("n", "<A-4>", "4gt")
keymap("n", "<A-5>", "5gt")
keymap("n", "<A-6>", "6gt")
keymap("n", "<A-7>", "7gt")
keymap("n", "<A-8>", "8gt")
keymap("n", "<A-9>", "9gt")

local is_win_exists = function(bufnr)
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == bufnr then
      return win
    end
  end
end

keymap("", "<M-C-t>", function()
  local bufnr = require("config.functions").is_buffer_exists("[Terminal]")
  if bufnr then
    local win = is_win_exists(bufnr)
    if win then
      vim.api.nvim_set_current_win(win)
    else
      vim.api.nvim_set_current_buf(bufnr)
    end
  else
    vim.cmd.terminal()
    vim.api.nvim_buf_set_name(0, "[Terminal]")
  end
  vim.cmd.startinsert({ bang = true })
end)

return M
