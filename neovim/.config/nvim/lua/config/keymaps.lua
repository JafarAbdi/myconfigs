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

local edit_file = function(selection)
  if selection and vim.trim(selection) ~= "" then
    vim.cmd.edit(vim.trim(selection))
  end
end

vim.keymap.set({ "i", "s" }, "<Tab>", function()
  local ls = require("luasnip")
  return ls.jumpable(1) and ls.jump(1) or "<Tab>"
end, { expr = true, silent = true })
vim.keymap.set({ "i", "s" }, "<S-Tab>", function()
  local ls = require("luasnip")
  return ls.jumpable(-1) and ls.jump(-1) or "<S-Tab>"
end, { expr = true, silent = true })

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
      for _, client in pairs(vim.lsp.get_active_clients({ bufnr = 0 })) do
        if client.name == "clangd" then
          M.clangd_opening_root_dir = client.config.root_dir
          break
        end
      end
    end
    callback()
  end
end

M.lsp = function(bufnr)
  keymap({ "n", "i" }, "<C-k>", vim.lsp.buf.signature_help, bufnr)
  keymap({ "n", "v" }, "<F3>", vim.lsp.buf.code_action, bufnr)
  keymap("n", "K", vim.lsp.buf.hover, bufnr)
  keymap("n", "gi", set_clangd_opening_path(vim.lsp.buf.implementation), bufnr)
  keymap("n", "gr", set_clangd_opening_path(vim.lsp.buf.references), bufnr)
  keymap("n", "gt", set_clangd_opening_path(vim.lsp.buf.type_definition), bufnr)
  keymap("n", "gd", set_clangd_opening_path(vim.lsp.buf.definition), bufnr)
  keymap("n", "gs", q.lsp_tags, bufnr)
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
  fzy.execute("fd --hidden --type f --strip-cwd-prefix", edit_file)
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

keymap({ "n", "t" }, "<M-C-t>", function()
  local term = require("config.term")
  term.toggle()
end)
keymap({ "n" }, "<leader>m", function()
  local buffer_mark_names = "abcdefghijklmnopqrstuvwxyz"
  local global_mark_names = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  local marks = {}
  for i = 1, #buffer_mark_names do
    local letter = buffer_mark_names:sub(i, i)
    local ok, mark = pcall(vim.api.nvim_buf_get_mark, 0, letter) -- Returns (0, 0) if not set
    if ok and not (mark[1] == 0 and mark[2] == 0) then
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
        vim.api.nvim_buf_get_lines(item.value[3], item.value[1] - 1, item.value[1], true)[1]
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
      vim.cmd.normal("'" .. item.name)
    end
  end)
end)

return M
