local M = {}

local fzy = require("fzy")
fzy.command = function(opts)
  return string.format(
    'fzf --height %d --prompt "%s" --no-multi --preview=""',
    opts.height,
    vim.F.if_nil(opts.prompt, "")
  )
end

local q = require("qwahl")

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
  keymap("n", "<leader>f", function()
    vim.lsp.buf.format({ async = true })
  end, bufnr)
  keymap({ "i", "n" }, "<c-i>", function()
    return vim.lsp.buf.inlay_hint(0)
  end, bufnr)
end

M.dap = function()
  local dap = require("dap")
  local widgets = require("dap.ui.widgets")
  keymap("n", "<F5>", dap.continue)
  keymap("n", "<leader>b", dap.toggle_breakpoint)
  keymap("n", "<leader>db", function()
    dap.toggle_breakpoint(vim.fn.input({ prompt = "Breakpoint Condition: " }), nil, nil, true)
  end)
  keymap("n", "<leader>dl", function()
    dap.list_breakpoints(true)
  end)
  keymap("n", "<leader>dr", function()
    dap.repl.toggle({ height = 15 })
  end)
  keymap("n", "<leader>dj", dap.down)
  keymap("n", "<leader>dk", dap.up)
  keymap("n", "<leader>dc", dap.run_to_cursor)
  keymap("n", "<leader>dS", function()
    widgets.centered_float(widgets.frames)
  end)
  keymap("n", "<leader>dt", function()
    widgets.centered_float(widgets.threads)
  end)
  keymap("n", "<leader>ds", function()
    widgets.centered_float(widgets.scopes)
  end)
  keymap({ "n", "v" }, "<leader>dh", widgets.hover)
  keymap({ "n", "v" }, "<leader>dp", widgets.preview)
end

keymap("n", "<leader>t", function()
  require("config.functions").run_file(true)
end)
keymap("n", "<leader>x", function()
  require("config.functions").run_file(false)
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
  local cword = vim.fn.expand("<cword>")
  if cword ~= "" then
    fzy.execute(
      "rg --no-messages --no-heading --trim --line-number --smart-case " .. cword,
      fzy.sinks.edit_live_grep
    )
  end
end)
keymap("n", "<M-o>", function()
  fzy.execute("fd --hidden --type f --strip-cwd-prefix", function(selection)
    if selection and vim.trim(selection) ~= "" then
      vim.cmd.edit(vim.trim(selection))
    end
  end)
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

local center_screen = function(command)
  return function()
    local ok, _ = pcall(command)
    if ok then
      vim.cmd.normal("zz")
    end
  end
end

keymap("n", "]q", center_screen(vim.cmd.cnext))
keymap("n", "[q", center_screen(vim.cmd.cprevious))
keymap("n", "]Q", center_screen(vim.cmd.clast))
keymap("n", "[Q", center_screen(vim.cmd.cfirst))
keymap("n", "]a", center_screen(vim.cmd.next))
keymap("n", "[a", center_screen(vim.cmd.previous))
keymap("n", "]A", center_screen(vim.cmd.last))
keymap("n", "[A", center_screen(vim.cmd.first))
keymap("n", "]l", center_screen(vim.cmd.lnext))
keymap("n", "[l", center_screen(vim.cmd.lprevious))
keymap("n", "]L", center_screen(vim.cmd.lfirst))
keymap("n", "[L", center_screen(vim.cmd.llast))
keymap("n", "]d", center_screen(vim.diagnostic.goto_next))
keymap("n", "[d", center_screen(vim.diagnostic.goto_prev))

keymap({ "n", "t" }, "<M-C-t>", function()
  local term = require("config.term")
  term.toggle()
end)

return M
