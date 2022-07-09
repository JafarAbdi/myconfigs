-- Debugging
vim.keymap.set("n", "<F5>", require("configs.dap").continue, { silent = true })
vim.keymap.set("n", "<F6>", require("configs.dap").terminate, { silent = true })
vim.keymap.set("n", "<F10>", require("configs.dap").step_out, { silent = true })
vim.keymap.set("n", "<F11>", require("configs.dap").step_over, { silent = true })
vim.keymap.set("n", "<F12>", require("configs.dap").step_into, { silent = true })
vim.keymap.set("n", "<leader>b", require("configs.dap").toggle_breakpoint, { silent = true })
vim.keymap.set("n", "<leader>B", function()
  require("configs.dap").toggle_breakpoint(vim.fn.input("Breakpoint Condition: "), nil, nil, true)
end, { silent = true })
vim.keymap.set("n", "<leader>lp", function()
  require("configs.dap").toggle_breakpoint(nil, nil, vim.fn.input("Log point message: "), true)
end, { silent = true })
vim.keymap.set("n", "<leader>dr", function()
  require("configs.dap").repl.toggle({ height = 10 })
end, { silent = true })
vim.keymap.set("n", "<leader>dl", require("configs.dap").run_last, { silent = true })
vim.keymap.set("n", "<leader>ds", require("dapui").float_element, { silent = true })
vim.keymap.set({ "n", "v" }, "<leader>dh", require("dapui").eval, { silent = true })
vim.keymap.set("n", "<leader>dc", require("configs.dap").run_to_cursor, { silent = true })
vim.keymap.set("n", "<leader>dj", require("configs.dap").down, { silent = true })
vim.keymap.set("n", "<leader>dk", require("configs.dap").up, { silent = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })
--Add leader shortcuts
vim.keymap.set("n", "<leader><space>", require("telescope.builtin").buffers, { silent = true })
vim.keymap.set(
  "n",
  "<leader>gc",
  require("telescope.builtin").current_buffer_fuzzy_find,
  { silent = true }
)
vim.keymap.set("n", "<leader>ml", require("telescope.builtin").marks, { silent = true })
vim.keymap.set("n", "<leader>h", require("telescope.builtin").help_tags, { silent = true })
-- vim.keymap.set("n", "<leader>gs", require("telescope.builtin").grep_string, { silent = true })
vim.keymap.set("n", "<leader>gl", require("telescope.builtin").live_grep, { silent = true })
vim.keymap.set("n", "<leader>o", require("telescope.builtin").find_files, { silent = true })
vim.keymap.set("n", "<leader>j", require("telescope.builtin").jumplist, { silent = true })

vim.keymap.set("", "<leader>f", vim.lsp.buf.formatting)
vim.keymap.set("v", "<leader>f", vim.lsp.buf.range_formatting)
--Remap for dealing with word wrap
vim.keymap.set("n", "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
vim.keymap.set("n", "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })

--Add move line shortcuts
vim.keymap.set("n", "<A-j>", ":m .+1<CR>==")
vim.keymap.set("n", "<A-k>", ":m .-2<CR>==")
vim.keymap.set("i", "<A-j>", "<Esc>:m .+1<CR>==gi")
vim.keymap.set("i", "<A-k>", "<Esc>:m .-2<CR>==gi")
vim.keymap.set("v", "<A-j>", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "<A-k>", ":m '<-2<CR>gv=gv")

-- Diagnostic keymaps
vim.keymap.set("n", "<leader>df", vim.diagnostic.open_float, { silent = true })
vim.keymap.set("n", "<leader>dp", vim.diagnostic.goto_prev, { silent = true })
vim.keymap.set("n", "<leader>dn", vim.diagnostic.goto_next, { silent = true })
vim.keymap.set("n", "<leader>dq", function()
  require("telescope.builtin").diagnostics(vim.tbl_deep_extend("error", { bufnr = 0 }, {}))
end, { silent = true })

-- <c-k> is my expansion key
-- this will expand the current item or jump to the next item within the snippet.
vim.keymap.set({ "i", "s" }, "<c-k>", function()
  local ls = require("luasnip")
  if ls.expand_or_jumpable() then
    ls.expand_or_jump()
  end
end, { silent = true })

-- <c-j> is my jump backwards key.
-- this always moves to the previous item within the snippet
vim.keymap.set({ "i", "s" }, "<c-j>", function()
  local ls = require("luasnip")
  if ls.jumpable(-1) then
    ls.jump(-1)
  end
end, { silent = true })

-- <c-l> is selecting within a list of options.
-- This is useful for choice nodes (introduced in the forthcoming episode 2)
vim.keymap.set("i", "<c-l>", function()
  local ls = require("luasnip")
  if ls.choice_active() then
    ls.change_choice(1)
  end
end)

-- Tab switching
vim.keymap.set("n", "<C-t>", ":tabedit<CR>")
vim.keymap.set("n", "<A-1>", "1gt")
vim.keymap.set("n", "<A-2>", "2gt")
vim.keymap.set("n", "<A-3>", "3gt")
vim.keymap.set("n", "<A-4>", "4gt")
vim.keymap.set("n", "<A-5>", "5gt")
vim.keymap.set("n", "<A-6>", "6gt")
vim.keymap.set("n", "<A-7>", "7gt")
vim.keymap.set("n", "<A-8>", "8gt")
vim.keymap.set("n", "<A-9>", "9gt")

vim.keymap.set("n", "<leader><leader>x", function()
  -- TODO: Adding make support to lua
  vim.cmd([[w]])
  if vim.bo.filetype == "lua" then
    vim.cmd([[:luafile %]])
  else
    vim.cmd([[Make]])
  end
end)

vim.keymap.set("", "<S-C-UP>", ":resize -1<CR>", { silent = true })
vim.keymap.set("", "<S-C-DOWN>", ":resize +1<CR>", { silent = true })
vim.keymap.set("", "<S-C-LEFT>", ":vertical resize -1<CR>", { silent = true })
vim.keymap.set("", "<S-C-RIGHT>", ":vertical resize +1<CR>", { silent = true })

-- F1-12 commands
vim.keymap.set("", "<F2>", function()
  if vim.opt.spell:get() then
    vim.opt.spell = false
    vim.api.nvim_echo({ { "Spellcheck off" } }, false, {})
  else
    vim.opt.spell = true
    vim.api.nvim_echo({ { "Spellcheck on" } }, false, {})
  end
end)

vim.keymap.set("", "<F3>", function()
  vim.cmd("UndotreeToggle")
  vim.cmd("UndotreeFocus")
end, { silent = true })

return {
  lsp_keymaps = function(bufnr)
    local opts = { silent = true, buffer = bufnr }
    vim.keymap.set("n", "gD", vim.lsp.buf.declaration, opts)
    vim.keymap.set("n", "gd", require("telescope.builtin").lsp_definitions, opts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "gi", require("telescope.builtin").lsp_implementations, opts)
    vim.keymap.set("n", "<C-k>", vim.lsp.buf.signature_help, opts)
    vim.keymap.set("n", "<leader>D", require("telescope.builtin").lsp_type_definitions, opts)
    vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)
    vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, opts)
    vim.api.nvim_buf_set_keymap(
      bufnr,
      "v",
      "<leader>ca",
      "<Esc><cmd>lua vim.lsp.buf.range_code_action()<CR>",
      { noremap = true, silent = true }
    )
    vim.keymap.set("n", "<leader>so", require("telescope.builtin").lsp_document_symbols, opts)
    vim.keymap.set("n", "<leader>ws", require("telescope.builtin").lsp_workspace_symbols, opts)
    vim.keymap.set("n", "<leader>r", require("telescope.builtin").lsp_references, opts)
  end,
}
