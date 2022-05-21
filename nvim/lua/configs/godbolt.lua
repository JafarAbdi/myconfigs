local Path = require("plenary.path")

require("godbolt").setup({
  languages = {
    cpp = {
      compiler = "clangdefault",
      options = {
        userArguments = Path
          :new(vim.env.WORKSPACE_DIR, "cpp", "scratches", "conanbuildinfo.args")
          :read(),
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
