-- Debugging
vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

if vim.g.vscode then
  -- https://github.com/vscode-neovim/vscode-neovim/tree/master/vim
  local keymap = function(mode, lhs, rhs)
    vim.keymap.set(mode, lhs, rhs, { silent = true })
  end
  local replace_keymap = function(mode, old_lhs, new_lhs, rhs)
    vim.keymap.del(mode, old_lhs)
    if new_lhs and rhs then
      keymap(mode, new_lhs, rhs)
    end
  end
  replace_keymap(
    "n",
    "=",
    "<leader>f",
    "<Cmd>call VSCodeNotify('editor.action.formatDocument')<CR>"
  )
  replace_keymap(
    "x",
    "=",
    "<leader>f",
    "<Cmd>call VSCodeNotifyVisual('editor.action.formatSelection', 1)<CR>"
  )
  replace_keymap({ "x", "n" }, "gh")
  replace_keymap({ "x", "n" }, "gf")
  -- replace_keymap({"x", "n"}, "<C-]>")
  replace_keymap({ "x", "n" }, "gO")
  replace_keymap({ "x", "n" }, "gF")
  replace_keymap({ "x", "n" }, "gD")
  replace_keymap({ "x", "n" }, "gH")
  keymap("n", "gi", "<Cmd>call VSCodeNotify('editor.action.goToImplementation')<CR>")
  keymap("n", "gr", "<Cmd>call VSCodeNotify('editor.action.goToReferences')<CR>")
  keymap("n", "gt", "<Cmd>call VSCodeNotify('editor.action.goToTypeDefinition')<CR>")
  -- keymap("n", "gf", "<Cmd>call VSCodeNotify('editor.action.revealDeclaration')<CR>")
  keymap("n", "gs", "<Cmd>call VSCodeNotify('workbench.action.gotoSymbol')<CR>")
  keymap(
    "n",
    "<leader>x",
    "<Cmd>call VSCodeNotify('workbench.action.tasks.runTask', 'Run current file')<CR>"
  )
  vim.keymap.set("n", "<M-h>", "<Cmd>call VSCodeNotify('workbench.action.navigateLeft')<CR>")
  vim.keymap.set("n", "<M-j>", "<Cmd>call VSCodeNotify('workbench.action.navigateDown')<CR>")
  vim.keymap.set("n", "<M-l>", "<Cmd>call VSCodeNotify('workbench.action.navigateRight')<CR>")
  vim.keymap.set("n", "<M-k>", "<Cmd>call VSCodeNotify('workbench.action.navigateUp')<CR>")
else
  --Add leader shortcuts
  vim.keymap.set("n", "<leader><space>", require("telescope.builtin").buffers, { silent = true })
  vim.keymap.set(
    "n",
    "<leader>gc",
    require("telescope.builtin").current_buffer_fuzzy_find,
    { silent = true }
  )
  vim.keymap.set("n", "<leader>gr", require("telescope.builtin").resume, { silent = true })
  vim.keymap.set("n", "<leader>h", require("telescope.builtin").help_tags, { silent = true })
  vim.keymap.set("n", "<leader>gs", require("telescope.builtin").grep_string, { silent = true })
  vim.keymap.set("n", "<leader>gl", require("telescope.builtin").live_grep, { silent = true })
  vim.keymap.set("n", "<leader>o", require("telescope.builtin").find_files, { silent = true })
  vim.keymap.set("n", "<leader>ro", require("telescope.builtin").oldfiles, { silent = true })
  vim.keymap.set("n", "<leader>j", function()
    require("telescope.builtin").jumplist({ fname_width = 0.6 })
  end, { silent = true })

  vim.keymap.set("", "<leader>f", function()
    vim.lsp.buf.format({ async = true })
  end)

  vim.keymap.set("t", "<A-h>", function()
    require("tmux").move_left()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("t", "<A-j>", function()
    require("tmux").move_bottom()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("t", "<A-k>", function()
    require("tmux").move_top()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("t", "<A-l>", function()
    require("tmux").move_right()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("n", "<A-h>", function()
    require("tmux").move_left()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("n", "<A-j>", function()
    require("tmux").move_bottom()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("n", "<A-k>", function()
    require("tmux").move_top()
    vim.cmd.checktime()
  end, { silent = true })
  vim.keymap.set("n", "<A-l>", function()
    require("tmux").move_right()
    vim.cmd.checktime()
  end, { silent = true })

  -- Diagnostic keymaps
  vim.keymap.set("n", "<leader>df", vim.diagnostic.open_float, { silent = true })
  vim.keymap.set("n", "<leader>d<Up>", function()
    vim.diagnostic.goto_prev({ severity = vim.diagnostic.severity.ERROR })
  end, { silent = true })
  vim.keymap.set("n", "<leader>d<Down>", function()
    vim.diagnostic.goto_next({ severity = vim.diagnostic.severity.ERROR })
  end, { silent = true })
  vim.keymap.set("n", "<leader>dq", function()
    require("telescope.builtin").diagnostics(vim.tbl_deep_extend("error", { bufnr = 0 }, {}))
  end, { silent = true })

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

  vim.keymap.set("", "<M-C-h>", require("tmux").resize_left, { silent = true })
  vim.keymap.set("", "<M-C-j>", require("tmux").resize_bottom, { silent = true })
  vim.keymap.set("", "<M-C-k>", require("tmux").resize_top, { silent = true })
  vim.keymap.set("", "<M-C-l>", require("tmux").resize_right, { silent = true })

  local is_win_exists = function(bufnr)
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == bufnr then
        return win
      end
    end
  end

  vim.keymap.set("", "<M-C-t>", function()
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
  end, { silent = true })
end
