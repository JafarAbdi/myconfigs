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

local function try_jump(direction, key)
  if vim.snippet.jumpable(direction) then
    return string.format("<cmd>lua vim.snippet.jump(%d)<cr>", direction)
  end
  return key
end

vim.keymap.set({ "i", "s" }, "<Tab>", function()
  return try_jump(1, "<Tab>")
end, { expr = true })
vim.keymap.set({ "i", "s" }, "<S-Tab>", function()
  return try_jump(-1, "<S-Tab>")
end, { expr = true })

vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set({ "i", "s" }, "<ESC>", function()
  if vim.snippet then
    vim.snippet.exit()
  end
  return "<ESC>"
end, { expr = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

vim.keymap.set("i", "<M-e>", function()
  return vim.api.nvim_feedkeys(vim.fn["codeium#Accept"](), "n", true)
end, { expr = true })
vim.keymap.set("i", "<c-;>", function()
  return vim.fn["codeium#CycleCompletions"](1)
end, { expr = true })
vim.keymap.set("i", "<c-,>", function()
  return vim.fn["codeium#CycleCompletions"](-1)
end, { expr = true })
vim.keymap.set("i", "<c-c>", function()
  -- Leave insert mode and cancel completion
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<ESC>", true, true, true), "n", true)
  return vim.fn["codeium#Clear"]()
end, { expr = true })

vim.keymap.set("i", "<c-j>", require("config.snippet").maybe)

local keymap = function(mode, lhs, callback, bufnr)
  vim.keymap.set(
    mode,
    lhs,
    callback,
    bufnr and { silent = true, buffer = bufnr } or { silent = true }
  )
end

M.clangd_opening_root_dir = nil

local set_clangd_opening_path = function(callback)
  return function()
    local ft = vim.api.nvim_get_option_value("filetype", {})
    if ft == "cpp" or ft == "c" then
      for _, client in pairs(vim.lsp.get_clients({ bufnr = 0 })) do
        if client.name == "clangd" then
          M.clangd_opening_root_dir = client.config.root_dir
          break
        end
      end
    end
    callback()
  end
end

keymap("n", "gs", function()
  q.try(q.lsp_tags, q.buf_tags)
end)
M.lsp = function(bufnr)
  keymap("i", "<c-space>", function()
    require("lsp_compl").trigger_completion()
  end, bufnr)
  vim.keymap.set("i", "<CR>", function()
    return require("lsp_compl").accept_pum() and "<c-y>" or "<CR>"
  end, { expr = true, buffer = bufnr })
  keymap({ "n", "i" }, "<C-k>", function()
    if tonumber(vim.fn.pumvisible()) == 1 then
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<c-y>", true, false, true), "n", true)
    end
    vim.lsp.buf.signature_help()
  end, bufnr)
  keymap({ "n", "v" }, "<F3>", vim.lsp.buf.code_action, bufnr)
  keymap("n", "gi", set_clangd_opening_path(vim.lsp.buf.implementation), bufnr)
  keymap("n", "gr", set_clangd_opening_path(vim.lsp.buf.references), bufnr)
  keymap("n", "gd", set_clangd_opening_path(vim.lsp.buf.definition), bufnr)
  keymap("n", "<F2>", vim.lsp.buf.rename, bufnr)
  keymap("n", "<leader>f", function()
    vim.lsp.buf.format({ async = true })
  end, bufnr)
  keymap({ "i", "n" }, "<M-i>", function()
    return vim.lsp.inlay_hint(0)
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
  keymap({ "n", "v" }, "<leader>dh", widgets.hover)
  keymap({ "n", "v" }, "<leader>dp", widgets.preview)
end

keymap("n", "<leader>t", function()
  require("config.functions").run_file(true)
end)
keymap("n", "<leader>x", function()
  require("config.functions").run_file(false)
end)
keymap("n", "<leader>h", q.helptags)
keymap("n", "<leader><space>", q.buffers)
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
  fzy.execute("fd --hidden --type f --strip-cwd-prefix", fzy.sinks.edit_file)
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
    if api.nvim_get_option_value("buftype", { buf = buf }) == "quickfix" then
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
keymap("n", "]t", center_screen(vim.cmd.tn))
keymap("n", "[t", center_screen(vim.cmd.tp))

keymap({ "n" }, "<leader>m", function()
  local buffer_mark_names = "abcdefghijklmnopqrstuvwxyz"
  local global_mark_names = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  local marks = {}
  for i = 1, #buffer_mark_names do
    local letter = buffer_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_buf_get_mark, 0, letter) -- Returns (0, 0) if not set
    if ok and mark[1] ~= 0 then
      table.insert(marks, { name = letter, value = mark })
    end
  end
  for i = 1, #global_mark_names do
    local letter = global_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_get_mark, letter, {}) -- Returns (0, 0, 0, "") if not set
    if ok and not (mark[1] == 0 and mark[2] == 0 and mark[3] == 0 and mark[4] == "") then
      table.insert(marks, { name = letter, value = mark })
    end
  end
  local current_bufnr = vim.api.nvim_get_current_buf()
  fzy.pick_one(marks, "Mark: ", function(item)
    if item == nil then
      return
    end
    if #item.value == 4 then
      return string.format(
        "%s(%s): %s",
        item.value[4],
        item.name,
        item.value[3] ~= 0
            and vim.api.nvim_buf_get_lines(item.value[3], item.value[1] - 1, item.value[1], true)[1]
          or "Unloaded Buffer"
      )
    end
    return string.format(
      "%s(%s): %s",
      "Current Buffer",
      item.name,
      vim.api.nvim_buf_get_lines(current_bufnr, item.value[1] - 1, item.value[1], true)[1]
    )
  end, function(item)
    if item ~= nil then
      vim.cmd.normal("`" .. item.name)
    end
  end)
end)

return M
