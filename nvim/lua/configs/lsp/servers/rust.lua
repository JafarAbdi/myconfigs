local handlers = require("configs.lsp.handlers")
local lspconfig_utils = require("lspconfig.util")
local Project = require("projects").Project

-- Copied from rust-tools
local function get_root_dir(fname)
  local cargo_crate_dir = lspconfig_utils.root_pattern("Cargo.toml")(fname)
  local cmd = { "cargo", "metadata", "--no-deps", "--format-version", "1" }
  if cargo_crate_dir ~= nil then
    cmd[#cmd + 1] = "--manifest-path"
    cmd[#cmd + 1] = lspconfig_utils.path.join(cargo_crate_dir, "Cargo.toml")
  end
  local cargo_metadata = ""
  local cm = vim.fn.jobstart(cmd, {
    on_stdout = function(_, d, _)
      cargo_metadata = table.concat(d, "\n")
    end,
    cwd = vim.fn.fnamemodify(fname, ":p:h"),
    stdout_buffered = true,
  })
  if cm > 0 then
    cm = vim.fn.jobwait({ cm })[1]
  else
    cm = -1
  end
  local cargo_workspace_dir = nil
  if cm == 0 then
    cargo_workspace_dir = vim.fn.json_decode(cargo_metadata)["workspace_root"]
  end
  return cargo_workspace_dir
    or cargo_crate_dir
    or lspconfig_utils.root_pattern("rust-project.json")(fname)
    or lspconfig_utils.find_git_ancestor(fname)
end

require("rust-tools").setup({
  server = {
    cmd = { vim.env.RUST_ANALYZER_BIN },
    capabilities = handlers.capabilities,
    on_attach = handlers.on_attach,
    root_dir = function(fname)
      local dir = get_root_dir(fname)
      if dir then
        require("projects").add_project(
          dir,
          Project:new({ language = "rust", build_system = "cargo" })
        )
      else
        require("projects").add_project(
          fname,
          Project:new({ language = "rust", build_system = "standalone" })
        )
      end
      return dir
    end,
    settings = {
      -- to enable rust-analyzer settings visit:
      -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
      ["rust-analyzer"] = {
        -- enable clippy diagnostics on save
        checkOnSave = {
          command = "clippy",
        },
        -- TODO: Move all snippets from ../../../../snippets/snippets/rust.code-snippets
        completion = {
          snippets = {
            custom = {
              ["main"] = {
                prefix = "main_result",
                body = {
                  "fn main() -> Result<(), Box<dyn Error>> {",
                  "\t${1:unimplemented!();}",
                  "\tOk(())",
                  "}",
                },
                requires = "std::error::Error",
                description = "main function with Result",
                scope = "item",
              },
            },
          },
        },
      },
    },
  },
  dap = {
    adapter = require("configs.dap").adapters.lldb,
  },
})
