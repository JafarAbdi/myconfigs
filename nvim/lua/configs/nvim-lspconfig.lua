local nvim_status = require("lsp-status")

nvim_status.config({
  select_symbol = function(cursor_pos, symbol)
    if symbol.valueRange then
      local value_range = {
        ["start"] = {
          character = 0,
          line = vim.fn.byte2line(symbol.valueRange[1]),
        },
        ["end"] = {
          character = 0,
          line = vim.fn.byte2line(symbol.valueRange[2]),
        },
      }

      return require("lsp-status.util").in_range(cursor_pos, value_range)
    end
  end,
  diagnostics = false,
  spinner_frames = { "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷" },
})
nvim_status.register_progress()

-- Add additional capabilities supported by nvim-cmp
local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require("cmp_nvim_lsp").update_capabilities(capabilities)
capabilities = vim.tbl_extend("keep", capabilities, nvim_status.capabilities)
capabilities.textDocument.completion.completionItem.snippetSupport = true

local lsp_on_attach = function(client, bufnr)
  if client.resolved_capabilities.semantic_tokens_full then
    vim.cmd(
      [[autocmd BufEnter,CursorHold,InsertLeave <buffer> lua vim.lsp.buf.semantic_tokens_full()]]
    )
  end
  require("configs.keymaps").lsp_keymaps(bufnr)
  vim.cmd([[ command! Format execute 'lua vim.lsp.buf.formatting()' ]])
  nvim_status.on_attach(client)
end

---------
-- C++ --
---------

-- For testing inlayHints
local clangd_cmd = { vim.env.HOME .. "/.config/clangd-lsp/bin/clangd" }
local clangd_debug_cmd = vim.deepcopy(clangd_cmd)
table.insert(clangd_debug_cmd, "-log=verbose")
-- clangd_cmd = vim.deepcopy(clangd_debug_cmd)
local lspconfig = require("lspconfig")

require("clangd_extensions").setup({
  extensions = {
    -- TODO: Setting this to true is causing some strange glitches
    -- Reproduce: Open two windows and toggle between <C-w>= and <C-w>| and you will see the bug when maximizing
    autoSetHints = false,
    inlay_hints = {
      show_parameter_hints = false,
    },
  },
  server = {
    on_attach = lsp_on_attach,
    capabilities = capabilities,
    cmd = clangd_cmd,
    -- Required for lsp-status
    init_options = {
      clangdFileStatus = true,
    },
    on_new_config = function(new_config, new_root_dir)
      local Path = require("plenary.path")
      -- local current_file_dir = vim.fn.expand("%:p:h")
      local p = Path:new(new_root_dir, ".clangd_config") -- directory containing opened file
      local compile_commands_database_path = vim.trim(p:read())
      new_config.cmd = vim.deepcopy(clangd_cmd)
      table.insert(
        new_config.cmd,
        string.format("-compile-commands-dir=%s", compile_commands_database_path)
      )
    end,
    handlers = nvim_status.extensions.clangd.setup(),
    root_dir = function(startpath)
      local search_fn = require("lspconfig.util").root_pattern(
        ".clangd_config"
        -- "compile_commands.json",
        -- "compile_flags.txt"
      )
      local dir = search_fn(startpath)
      if not dir then
        -- If root directory not found set it to file's directory
        dir = search_fn(vim.fn.expand("%:p:h")) or vim.fn.getcwd()
      end
      vim.cmd(string.format("cd %s", dir))
      return dir
    end,
    single_file_support = true,
  },
})

-----------
-- CMake --
-----------
lspconfig.cmake.setup({
  cmd = { "cmake-language-server" },
  filetypes = { "cmake" },
  init_options = {
    buildDirectory = "build",
  },
  on_new_config = function(new_config, new_root_dir)
    local Path = require("plenary.path")
    local p = Path:new(new_root_dir):joinpath(".clangd_config")
    -- local compile_commands_database_path = (Path:new(new_root_dir):joinpath(vim.trim(p:read()))):absolute()
    new_config.cmd = { "cmake-language-server" }
    new_config.init_options = {
      buildDirectory = Path:new(new_root_dir):joinpath(vim.trim(p:read())),
    }
  end,
  root_dir = require("lspconfig.util").root_pattern(
    ".clangd_config",
    "compile_commands.json",
    "compile_flags.txt",
    ".git"
  ) or dirname,
  single_file_support = true,
})

require("rust-tools").setup({
  server = {
    capabilities = capabilities,
    -- on_attach is a callback called when the language server attachs to the buffer
    on_attach = lsp_on_attach,
    settings = {
      -- to enable rust-analyzer settings visit:
      -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
      ["rust-analyzer"] = {
        -- enable clippy diagnostics on save
        checkOnSave = {
          command = "clippy",
        },
      },
    },
  },
})

------------
-- PYTHON --
------------
-- local pylsp_debug_cmd = {"pylsp", "--verbose", "--log-file", "/tmp/asa.log"},
lspconfig.pylsp.setup({
  on_attach = lsp_on_attach,
  capabilities = capabilities,
  settings = {
    pylsp = {
      plugins = {
        autopep8 = { enabled = false },
        pyflakes = { enabled = false },
        mccabe = { enabled = false },
        pycodestyle = { enabled = false },
        flake = { enabled = true },
        pyls_flake8 = { enabled = false },
        flake8_lint = { enabled = false },
        pylint = { enabled = true },
        black = { enabled = true },
        rope_rename = { enabled = true },
        rope_completion = { enabled = true },
        -- jedi = { environment = vim.fn.exepath('python3') }
      },
    },
  },
})
lspconfig.efm.setup({
  cmd = { "efm-langserver", "-c", vim.env.HOME .. "/myconfigs/efm-langserver/config.yaml" },
  filetypes = { "lua", "cmake", "json", "markdown", "rst", "sh", "tex", "yaml" },
})

---------
-- LUA --
---------
local runtime_path = vim.split(package.path, ";")
table.insert(runtime_path, "lua/?.lua")
table.insert(runtime_path, "lua/?/init.lua")

lspconfig.sumneko_lua.setup({
  on_attach = lsp_on_attach,
  settings = {
    Lua = {
      runtime = {
        -- Tell the language server which version of Lua you're using (most likely LuaJIT in the case of Neovim)
        version = "LuaJIT",
        -- Setup your lua path
        path = runtime_path,
      },
      diagnostics = {
        -- Get the language server to recognize the `vim` global
        globals = { "vim" },
      },
      workspace = {
        -- Make the server aware of Neovim runtime files
        library = vim.api.nvim_get_runtime_file("", true),
      },
      -- Do not send telemetry data containing a randomized but unique identifier
      telemetry = {
        enable = false,
      },
    },
  },
})


----------------
-- Typescript --
----------------
require("lspconfig").tsserver.setup({})

vim.lsp.handlers["textDocument/publishDiagnostics"] = vim.lsp.with(
vim.lsp.diagnostic.on_publish_diagnostics,
{ underline = false }
)
