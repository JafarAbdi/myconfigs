local M = {}

local fzy = require("fzy")
fzy.command = function(opts)
  return string.format(
    'fzf --height %d --prompt "%s" --no-multi --preview=""',
    -- 'fzf --height %d --prompt "%s" --preview-window="bottom,+{2}+3/3" --delimiter : --no-multi --ansi',
    opts.height,
    vim.F.if_nil(opts.prompt, "")
  )
end

local q = require("qwahl")

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
  keymap({ "n", "i" }, "<C-k>", vim.lsp.buf.signature_help, bufnr)
  keymap({ "n", "v" }, "<F3>", vim.lsp.buf.code_action, bufnr)
  keymap("n", "K", vim.lsp.buf.hover, bufnr)
  keymap("n", "gi", vim.lsp.buf.implementation, bufnr)
  keymap("n", "gr", vim.lsp.buf.references, bufnr)
  keymap("n", "gt", vim.lsp.buf.type_definition, bufnr)
  keymap("n", "gd", vim.lsp.buf.definition, bufnr)
  keymap("n", "gs", q.lsp_tags, bufnr)
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
    "--workspace-folder",
    root_dir,
    "--filetype",
    filetype,
    "--file-path",
    vim.fn.expand("%:p"),
  }
  local cmd = "build_project.py"
  if filetype ~= "python" then
    cmd = "micromamba"
    for _, v in
      ipairs(
        vim.fn.reverse({ "run", "-n", "myconfigs", "python3", "~/.local/bin/build_project.py" })
      )
    do
      table.insert(args, 1, v)
    end
  end
  if is_test then
    table.insert(args, "--test")
  end
  local run_in_terminal = require("config.run_in_terminal")
  run_in_terminal(cmd, args, { cwd = root_dir })
end
keymap("n", "<leader>t", function()
  run_file(true)
end)
keymap("n", "<leader>x", function()
  run_file(false)
end)
keymap("n", "<leader>h", function()
  local files = vim.api.nvim_get_runtime_file("**/doc/tags", true)
  local tags = {}
  for _, file_path in ipairs(files) do
    local file = io.open(file_path, "r")
    if file then
      for line in file:lines() do
        -- Parse line with the format: tag-name<TAB>file-path<TAB>tag-address
        local tag_name, _ = line:match("([^\t]+)\t([^\t]+)\t.*")
        table.insert(tags, tag_name)
      end
      file:close()
    end
  end
  fzy.pick_one(tags, "Help tags: ", nil, function(tag)
    if tag then
      vim.cmd.help(tag)
    end
  end)
end)
keymap("n", "<leader><space>", function()
  local bufs = vim.tbl_filter(function(b)
    return vim.api.nvim_buf_is_loaded(b)
      and vim.api.nvim_buf_get_option(b, "buftype") ~= "quickfix"
      and vim.api.nvim_buf_get_option(b, "buftype") ~= "nofile"
  end, vim.api.nvim_list_bufs())
  local format_bufname = function(b)
    local fullname = vim.api.nvim_buf_get_name(b)
    local name
    if #fullname == 0 then
      name = "[No Name] (" .. vim.api.nvim_buf_get_option(b, "buftype") .. ")"
    else
      name = q.format_bufname(b)
    end
    local modified = vim.api.nvim_buf_get_option(b, "modified")
    return modified and name .. " [+]" or name
  end
  local opts = {
    prompt = "Buffer: ",
    format_item = format_bufname,
  }
  vim.ui.select(bufs, opts, function(b)
    if b then
      vim.api.nvim_set_current_buf(b)
    end
  end)
end)
keymap("n", "<leader>gc", q.buf_lines)
keymap("n", "<C-M-s>", function()
  fzy.execute(
    "rg --no-messages --no-heading --trim --line-number --smart-case " .. vim.fn.expand("<cword>"),
    fzy.sinks.edit_live_grep
  )
end)
keymap("n", "<M-o>", function()
  fzy.execute("fd --hidden --type f --ignore --strip-cwd-prefix", fzy.sinks.edit_file)
end)
keymap("n", "<leader>j", q.jumplist)

-- Diagnostic keymaps
keymap("n", "<leader>df", vim.diagnostic.open_float)
keymap("n", "<leader>q", q.quickfix)
keymap("n", "<leader>dq", function()
  q.diagnostic(0)
end)
local win_pre_copen = nil
keymap("n", "<leader>c", function()
  local api = vim.api
  for _, win in pairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)
    if api.nvim_buf_get_option(buf, "buftype") == "quickfix" then
      api.nvim_command("cclose")
      if win_pre_copen then
        local ok, w = pcall(api.nvim_win_get_number, win_pre_copen)
        if ok and api.nvim_win_is_valid(w) then
          api.nvim_set_current_win(w)
        end
        win_pre_copen = nil
      end
      return
    end
  end

  -- no quickfix buffer found so far, so show it
  win_pre_copen = api.nvim_get_current_win()
  api.nvim_command("botright copen")
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

keymap("n", "]q", ":cnext<CR>")
keymap("n", "[q", ":cprevious<CR>")
keymap("n", "]Q", ":clast<CR>")
keymap("n", "[Q", ":cfirst<CR>")
keymap("n", "]l", ":lnext<CR>")
keymap("n", "[l", ":lprevious<CR>")
keymap("n", "]L", ":lfirst<CR>")
keymap("n", "[L", ":llast<CR>")
keymap("n", "]d", vim.diagnostic.goto_next)
keymap("n", "[d", vim.diagnostic.goto_prev)

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
