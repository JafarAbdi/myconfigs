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
vim.keymap.set("n", "<leader>gs", require("telescope.builtin").grep_string, { silent = true })
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
  local file_extension = vim.fn.expand("%:e")
  if vim.bo.filetype == "lua" then
    vim.cmd([[:luafile %]])
  elseif file_extension == "urdf" or file_extension == "xacro" then
    local request = "curl -X POST http://127.0.0.1:7777/set_reload_request"
    vim.fn.jobstart(request, {
      on_exit = function(_, data)
        vim.notify(vim.inspect(data), vim.log.levels.TRACE)
      end,
    })
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

vim.keymap.set("", "<F7>", function()
  vim.cmd("Lexplore")
end, { silent = true })

return {
  cmake_keymap = function()
    vim.keymap.set("n", "<leader>cm", function()
      local options = vim.fn.getcompletion("CMake ", "cmdline")
      vim.ui.select(options, { prompt = "Select Command: " }, function(command)
        if not command then
          return
        end
        -- Why it only work with defer? vim.schedule?
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
        -- Why it only work with defer?
        vim.defer_fn(function()
          local ok, error = pcall(vim.cmd, command)
          if not ok then
            vim.notify(error, vim.log.levels.ERROR)
          end
        end, 10)
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
    -- TODO: Debugging related keymaps
    vim.keymap.set("n", "<leader>nc", neotest.run.run, opts)
    vim.keymap.set("n", "<leader>nr", function()
      neotest.run.run(vim.fn.expand("%"))
    end, opts)
    -- TODO: Using this with high frequency is causing the async loop lua/neotest/consumers/summary/init.lua:77 to die with (cannot resume dead coroutine)
    -- vim.keymap.set("n", "<leader>na", function()
    --   for _, adapter_id in ipairs(neotest.run.adapters()) do
    --     neotest.run.run({ suite = true, adapter = adapter_id })
    --   end
    -- end, opts)
    vim.keymap.set("n", "<leader>nR", neotest.run.run_last, opts)
    vim.keymap.set("n", "<F4>", neotest.summary.toggle, opts)
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
