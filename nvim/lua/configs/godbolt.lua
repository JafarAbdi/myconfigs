local Path = require("plenary.path")

local user_arguments = ""
local scratch_path = Path:new(vim.env.CPP_SCREATCHES_DIR, "conanbuildinfo.args")
if scratch_path:exists() then
  user_arguments = scratch_path:read()
end

require("godbolt").setup({
  languages = {
    cpp = {
      compiler = "clangdefault",
      options = {
        userArguments = user_arguments,
        filters = {
          binary = false,
          commentOnly = true,
          demangle = true,
          directives = true,
          execute = false,
          intel = true,
          labels = true,
          libraryCode = true,
          trim = false,
        },
      },
    },
  },
  url = "http://localhost:10240",
})
