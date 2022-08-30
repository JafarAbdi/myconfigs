local handlers = require("configs.lsp.handlers")
local nvim_status = require("lsp-status")
-- For testing inlayHints
local clangd_cmd = {
  vim.env.HOME .. "/.config/clangd-lsp/bin/clangd",
  "--completion-style=detailed",
}
-- local clangd_debug_cmd = vim.deepcopy(clangd_cmd)
-- table.insert(clangd_debug_cmd, "-log=verbose")
-- clangd_cmd = vim.deepcopy(clangd_debug_cmd)

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
    on_attach = handlers.on_attach,
    capabilities = handlers.capabilities,
    cmd = clangd_cmd,
    -- Required for lsp-status
    init_options = {
      clangdFileStatus = true,
    },
    on_new_config = function(new_config, new_root_dir)
      -- local current_file_dir = vim.fn.expand("%:p:h")
      local compile_commands_database_path = require("configs.functions").load_clangd_config(
        new_root_dir
      )
      new_config.cmd = vim.deepcopy(clangd_cmd)
      table.insert(
        new_config.cmd,
        string.format("-compile-commands-dir=%s", compile_commands_database_path)
      )
    end,
    handlers = nvim_status.extensions.clangd.setup(),
    root_dir = require("configs.functions").clangd_root_dir,
    single_file_support = true,
  },
})
