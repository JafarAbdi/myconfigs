-- Debugging
vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

-- https://github.com/vscode-neovim/vscode-neovim/tree/master/vim
local keymap = function(mode, lhs, editor)
  if vim.g.vscode and editor.vscode then
    vim.keymap.set(mode, lhs, editor.vscode, { silent = true })
  elseif editor.neovim then
    vim.keymap.set(mode, lhs, editor.neovim, { silent = true })
  end
end
local del = vim.keymap.del

keymap("n", "<leader>f", {
  vscode = "<Cmd>call VSCodeNotify('editor.action.formatDocument')<CR>",
  neovim = function()
    vim.lsp.buf.format({ async = true })
  end,
})
keymap(
  "x",
  "<leader>f",
  { vscode = "<Cmd>call VSCodeNotifyVisual('editor.action.formatSelection', 1)<CR>" }
)
if vim.g.vscode then
  -- replace_keymap({"x", "n"}, "<C-]>")
  del({ "x", "n" }, "gh")
  del({ "x", "n" }, "=")
  del({ "x", "n" }, "gf")
  del({ "x", "n" }, "gO")
  del({ "x", "n" }, "gF")
  del({ "x", "n" }, "gD")
  del({ "x", "n" }, "gH")
end
keymap("n", "gi", { vscode = "<Cmd>call VSCodeNotify('editor.action.goToImplementation')<CR>" })
keymap("n", "gr", { vscode = "<Cmd>call VSCodeNotify('editor.action.goToReferences')<CR>" })
keymap("n", "gt", { vscode = "<Cmd>call VSCodeNotify('editor.action.goToTypeDefinition')<CR>" })
-- keymap("n", "gf", "<Cmd>call VSCodeNotify('editor.action.revealDeclaration')<CR>")
keymap("n", "gs", { vscode = "<Cmd>call VSCodeNotify('workbench.action.gotoSymbol')<CR>" })
keymap(
  "n",
  "<leader>x",
  { vscode = "<Cmd>call VSCodeNotify('workbench.action.tasks.runTask', 'Run current file')<CR>" }
)
keymap("n", "<leader><space>", { neovim = require("telescope.builtin").buffers })
keymap("n", "<leader>gc", { neovim = require("telescope.builtin").current_buffer_fuzzy_find })
keymap("n", "<leader>gr", { neovim = require("telescope.builtin").resume })
keymap("n", "<leader>h", { neovim = require("telescope.builtin").help_tags })
keymap("n", "<leader>gs", { neovim = require("telescope.builtin").grep_string })
keymap("n", "<leader>gl", { neovim = require("telescope.builtin").live_grep })
keymap("n", "<leader>o", { neovim = require("telescope.builtin").find_files })
keymap("n", "<leader>ro", { neovim = require("telescope.builtin").oldfiles })
keymap("n", "<leader>j", {
  neovim = function()
    require("telescope.builtin").jumplist({ fname_width = 0.6 })
  end,
})

keymap("t", "<A-h>", {
  neovim = function()
    require("tmux").move_left()
    vim.cmd.checktime()
  end,
})
keymap("t", "<A-j>", {
  neovim = function()
    require("tmux").move_bottom()
    vim.cmd.checktime()
  end,
})
keymap("t", "<A-k>", {
  neovim = function()
    require("tmux").move_top()
    vim.cmd.checktime()
  end,
})
keymap("t", "<A-l>", {
  neovim = function()
    require("tmux").move_right()
    vim.cmd.checktime()
  end,
})
keymap("n", "<A-h>", {
  neovim = function()
    require("tmux").move_left()
    vim.cmd.checktime()
  end,
  vscode = "<Cmd>call VSCodeNotify('workbench.action.navigateLeft')<CR>",
})
keymap("n", "<A-j>", {
  neovim = function()
    require("tmux").move_bottom()
    vim.cmd.checktime()
  end,
  vscode = "<Cmd>call VSCodeNotify('workbench.action.navigateDown')<CR>",
})
keymap("n", "<A-k>", {
  neovim = function()
    require("tmux").move_top()
    vim.cmd.checktime()
  end,
  vscode = "<Cmd>call VSCodeNotify('workbench.action.navigateUp')<CR>",
})
keymap("n", "<A-l>", {
  neovim = function()
    require("tmux").move_right()
    vim.cmd.checktime()
  end,
  vscode = "<Cmd>call VSCodeNotify('workbench.action.navigateRight')<CR>",
})

-- Diagnostic keymaps
keymap("n", "<leader>df", { neovim = vim.diagnostic.open_float })
keymap("n", "<leader>d<Up>", {
  neovim = function()
    vim.diagnostic.goto_prev({ severity = vim.diagnostic.severity.ERROR })
  end,
}, { silent = true })
keymap("n", "<leader>d<Down>", {
  neovim = function()
    vim.diagnostic.goto_next({ severity = vim.diagnostic.severity.ERROR })
  end,
}, { silent = true })
keymap("n", "<leader>dq", {
  neovim = function()
    require("telescope.builtin").diagnostics(vim.tbl_deep_extend("error", { bufnr = 0 }, {}))
  end,
}, { silent = true })

keymap("", "<M-C-h>", { neovim = require("tmux").resize_left })
keymap("", "<M-C-j>", { neovim = require("tmux").resize_bottom })
keymap("", "<M-C-k>", { neovim = require("tmux").resize_top })
keymap("", "<M-C-l>", { neovim = require("tmux").resize_right })

local is_win_exists = function(bufnr)
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == bufnr then
      return win
    end
  end
end

keymap("", "<M-C-t>", {
  neovim = function()
    local bufnr = require("configs.functions").is_buffer_exists("[Terminal]")
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
  end,
})
