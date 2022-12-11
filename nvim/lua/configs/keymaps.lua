local M = {}

-- Debugging
vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })

--Remap space as leader key
vim.keymap.set("", "<Space>", "<Nop>", { silent = true })

-- https://github.com/vscode-neovim/vscode-neovim/tree/master/vim
local keymap = function(mode, lhs, editor, bufnr)
  if vim.g.vscode and editor.vscode then
    vim.keymap.set(mode, lhs, editor.vscode, { silent = true })
  elseif editor.neovim then
    vim.keymap.set(
      mode,
      lhs,
      editor.neovim,
      bufnr and { silent = true, buffer = bufnr } or { silent = true }
    )
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
  keymap("n", "<C-k>", { neovim = vim.lsp.buf.signature_help }, bufnr)
  keymap("n", "<leader>ca", { neovim = vim.lsp.buf.code_action }, bufnr)
  keymap("n", "gw", {
    vscode = "<Cmd>call VSCodeNotify('workbench.action.showAllSymbols')<CR>",
    neovim = function()
      require("telescope.builtin").lsp_dynamic_workspace_symbols({
        symbol_width = 0.3,
        fname_width = 0.6,
        symbol_type_width = 0.1,
      })
    end,
  }, bufnr)
  keymap("n", "K", { neovim = vim.lsp.buf.hover }, bufnr)
  local lsp_action = function(callback)
    return function()
      -- Because tooling is c++ is horrible, we set the path to the directory of the file that called this callback
      -- to use it later as a fallback when we can't find a settings file with the path to the compile_commands.json
      local filetype = require("plenary.filetype")
      if filetype.detect(vim.fn.expand("%:p")) == "cpp" then
        vim.g.clangd_opening_dir = vim.fn.expand("%:p:h")
      end
      callback({ fname_width = 0.55 })
    end
  end
  keymap("n", "gi", {
    vscode = "<Cmd>call VSCodeNotify('editor.action.goToImplementation')<CR>",
    neovim = lsp_action(require("telescope.builtin").lsp_implementations),
  }, bufnr)
  keymap("n", "gr", {
    vscode = "<Cmd>call VSCodeNotify('editor.action.goToReferences')<CR>",
    neovim = lsp_action(require("telescope.builtin").lsp_references),
  }, bufnr)
  keymap("n", "gt", {
    vscode = "<Cmd>call VSCodeNotify('editor.action.goToTypeDefinition')<CR>",
    neovim = lsp_action(require("telescope.builtin").lsp_type_definitions),
  }, bufnr)
  -- keymap("n", "gf", "<Cmd>call VSCodeNotify('editor.action.revealDeclaration')<CR>")
  keymap("n", "gd", {
    vscode = "<Cmd>call VSCodeNotify('editor.action.revealDefinition')<CR>",
    neovim = lsp_action(require("telescope.builtin").lsp_definitions),
  }, bufnr)
  keymap("n", "gs", {
    vscode = "<Cmd>call VSCodeNotify('workbench.action.gotoSymbol')<CR>",
    neovim = function()
      require("telescope.builtin").lsp_document_symbols({
        symbol_width = 0.9,
        symbol_type_width = 0.1,
      })
    end,
  }, bufnr)
  keymap("n", "<F2>", { neovim = vim.lsp.buf.rename }, bufnr)
end
keymap("n", "<leader>x", {
  neovim = function()
    local run_in_terminal = require("configs.run_in_terminal")

    local root_dir = vim.fn.expand("%:p:h")
    for dir in vim.fs.parents(vim.api.nvim_buf_get_name(0)) do
      if vim.env.HOME == dir then
        break
      end
      if vim.fn.isdirectory(dir .. "/.vscode") == 1 then
        root_dir = dir
        break
      end
    end

    vim.cmd.write()
    run_in_terminal("micromamba", {
      "run",
      "-n",
      "myconfigs",
      "build_project.py",
      "--workspace-folder",
      root_dir,
      "--file-path",
      vim.fn.expand("%:p"),
    }, { cwd = root_dir })
  end,
  vscode = "<Cmd>call VSCodeNotify('workbench.action.tasks.runTask', 'Run current file')<CR>",
})
keymap("n", "<leader><space>", { neovim = require("telescope.builtin").buffers })
keymap("n", "<leader>gc", { neovim = require("telescope.builtin").current_buffer_fuzzy_find })
keymap("n", "<leader>gr", { neovim = require("telescope.builtin").resume })
keymap("n", "<leader>h", { neovim = require("telescope.builtin").help_tags })
keymap("n", "<C-S-s>", { neovim = require("telescope.builtin").grep_string })
keymap("n", "<C-S-f>", { neovim = require("telescope.builtin").live_grep })
keymap("n", "<C-p>", { neovim = require("telescope.builtin").find_files })
keymap("n", "<C-S-p>", { neovim = require("telescope.builtin").commands })
keymap("n", "<leader>ro", { neovim = require("telescope.builtin").oldfiles })
keymap("n", "<C-S-e>", { neovim = vim.cmd.Lexplore })
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
})
keymap("n", "<leader>d<Down>", {
  neovim = function()
    vim.diagnostic.goto_next({ severity = vim.diagnostic.severity.ERROR })
  end,
})
keymap("n", "<leader>dq", {
  neovim = function()
    require("telescope.builtin").diagnostics(vim.tbl_deep_extend("error", { bufnr = 0 }, {}))
  end,
})

keymap("", "<M-C-h>", { neovim = require("tmux").resize_left })
keymap("", "<M-C-j>", { neovim = require("tmux").resize_bottom })
keymap("", "<M-C-k>", { neovim = require("tmux").resize_top })
keymap("", "<M-C-l>", { neovim = require("tmux").resize_right })

-- Tab switching
keymap("n", "<C-t>", { neovim = ":tabedit<CR>" })
keymap("n", "<A-1>", { neovim = "1gt" })
keymap("n", "<A-2>", { neovim = "2gt" })
keymap("n", "<A-3>", { neovim = "3gt" })
keymap("n", "<A-4>", { neovim = "4gt" })
keymap("n", "<A-5>", { neovim = "5gt" })
keymap("n", "<A-6>", { neovim = "6gt" })
keymap("n", "<A-7>", { neovim = "7gt" })
keymap("n", "<A-8>", { neovim = "8gt" })
keymap("n", "<A-9>", { neovim = "9gt" })

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

return M
