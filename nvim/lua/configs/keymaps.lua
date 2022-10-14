-- Debugging
vim.keymap.set("t", "<ESC>", [[<C-\><C-n>]], { silent = true })
vim.keymap.set("n", "<leader>b", require("configs.dap").toggle_breakpoint, { silent = true })
vim.keymap.set("n", "<leader>B", function()
  require("configs.dap").toggle_breakpoint(vim.fn.input("Breakpoint Condition: "), nil, nil, true)
end, { silent = true })
vim.keymap.set("n", "<leader>dp", function()
  require("configs.dap").toggle_breakpoint(nil, nil, vim.fn.input("Log point message: "), true)
end, { silent = true })
vim.keymap.set("n", "<leader>dr", require("configs.dap").continue, { silent = true })
vim.keymap.set("n", "<leader>dl", require("configs.dap").run_last, { silent = true })
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
vim.keymap.set("n", "<leader>gr", require("telescope.builtin").resume, { silent = true })
vim.keymap.set("n", "<leader>h", require("telescope.builtin").help_tags, { silent = true })
vim.keymap.set("n", "<leader>gs", require("telescope.builtin").grep_string, { silent = true })
vim.keymap.set("n", "<leader>gl", require("telescope.builtin").live_grep, { silent = true })
vim.keymap.set("n", "<leader>o", require("telescope.builtin").find_files, { silent = true })
vim.keymap.set("n", "<leader>ro", require("telescope.builtin").oldfiles, { silent = true })
vim.keymap.set("n", "<leader>p", require("telescope").extensions.projects.cd, { silent = true })
vim.keymap.set("n", "<leader>j", function()
  require("telescope.builtin").jumplist({ fname_width = 0.8 })
end, { silent = true })

vim.keymap.set("", "<leader>f", function()
  vim.lsp.buf.format({ async = true })
end)

vim.keymap.set("t", "<A-h>", require("tmux").move_left, { silent = true })
vim.keymap.set("t", "<A-j>", require("tmux").move_bottom, { silent = true })
vim.keymap.set("t", "<A-k>", require("tmux").move_top, { silent = true })
vim.keymap.set("t", "<A-l>", require("tmux").move_right, { silent = true })
vim.keymap.set("n", "<A-h>", require("tmux").move_left, { silent = true })
vim.keymap.set("n", "<A-j>", require("tmux").move_bottom, { silent = true })
vim.keymap.set("n", "<A-k>", require("tmux").move_top, { silent = true })
vim.keymap.set("n", "<A-l>", require("tmux").move_right, { silent = true })

-- Diagnostic keymaps
vim.keymap.set("n", "<leader>df", vim.diagnostic.open_float, { silent = true })
vim.keymap.set("n", "<leader>dN", vim.diagnostic.goto_prev, { silent = true })
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

vim.keymap.set("n", "<leader>x", function()
  vim.cmd.write()
  vim.cmd.Make()
end)

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

return {
  cmake_keymap = function()
    vim.keymap.set("n", "<leader>cm", function()
      local options = vim.fn.getcompletion("CMake ", "cmdline")
      vim.ui.select(options, { prompt = "Select Command: " }, function(command)
        if not command then
          return
        end
        vim.schedule(function()
          require("configs.cmake").cmake_project(vim.fn.expand("%:p"))
          local ok, error = pcall(require("cmake")[command])
          if not ok then
            vim.notify(error, vim.log.levels.ERROR)
          end
        end)
      end)
    end)
  end,
  clangd_keymap = function()
    vim.keymap.set("n", "<leader>cd", function()
      local options = vim.fn.getcompletion("Clangd", "cmdline")
      vim.ui.select(options, { prompt = "Select Command: " }, function(command)
        if not command then
          return
        end
        vim.schedule(function()
          local ok, error = pcall(vim.cmd, command)
          if not ok then
            vim.notify(error, vim.log.levels.ERROR)
          end
        end)
      end)
    end)
  end,
  lsp_keymaps = function(bufnr)
    local opts = { silent = true, buffer = bufnr }
    vim.keymap.set("n", "gD", function()
      require("telescope.builtin").lsp_type_definitions({ fname_width = 0.55 })
    end, opts)
    vim.keymap.set("n", "gd", function()
      require("telescope.builtin").lsp_definitions({ fname_width = 0.55 })
    end, opts) -- Seem to be always same as declaration
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "gi", function()
      require("telescope.builtin").lsp_implementations({ fname_width = 0.55 })
    end, opts)
    vim.keymap.set("n", "<C-k>", vim.lsp.buf.signature_help, opts)
    vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)
    vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, opts)
    vim.keymap.set("n", "<leader>r", function()
      require("telescope.builtin").lsp_references({ fname_width = 0.55 })
    end, opts)
    vim.api.nvim_buf_set_keymap(
      bufnr,
      "v",
      "<leader>ca",
      "<Esc><cmd>lua vim.lsp.buf.range_code_action()<CR>",
      { noremap = true, silent = true }
    )
    vim.keymap.set("n", "<leader>so", function()
      require("telescope.builtin").lsp_document_symbols({
        symbol_width = 0.9,
        symbol_type_width = 0.1,
      })
    end, opts)
    vim.keymap.set("n", "<leader>ws", function()
      require("telescope.builtin").lsp_dynamic_workspace_symbols({
        symbol_width = 0.3,
        fname_width = 0.6,
        symbol_type_width = 0.1,
      })
    end, opts)
  end,
  neotest_keymaps = function()
    local neotest = require("neotest")
    local opts = { silent = true }
    local set_project = function()
      require("projects").get_project(vim.fn.expand("%:p:h")):set()
    end
    -- TODO: Debugging related keymaps
    vim.keymap.set("n", "<leader>nc", function()
      set_project()
      neotest.run.run()
    end, opts)
    vim.keymap.set("n", "<leader>nr", function()
      set_project()
      neotest.run.run(vim.fn.expand("%"))
    end, opts)
    -- TODO: Using this with high frequency is causing the async loop lua/neotest/consumers/summary/init.lua:77 to die with (cannot resume dead coroutine)
    -- vim.keymap.set("n", "<leader>na", function()
    --   for _, adapter_id in ipairs(neotest.run.adapters()) do
    --     neotest.run.run({ suite = true, adapter = adapter_id })
    --   end
    -- end, opts)
    vim.keymap.set("n", "<leader>nR", neotest.run.run_last, opts)
    vim.keymap.set("n", "<leader>nt", neotest.summary.toggle, opts)
    vim.keymap.set("n", "<leader>nm", neotest.summary.run_marked, opts)
    vim.keymap.set("n", "<leader>no", function()
      neotest.output.open({ enter = true })
    end, opts)
    vim.keymap.set("n", "<leader>nO", function()
      neotest.output.open({ enter = true, short = true })
    end, opts)
    vim.keymap.set("n", "]t", function()
      neotest.jump.next({ status = "failed" })
    end, opts)
    vim.keymap.set("n", "[t", function()
      neotest.jump.prev({ status = "failed" })
    end, opts)
  end,
}
