require("neotest-gtest").setup({
  test_path_pattern = { ".cpp", ".cc" }, -- The path pattern to detect test files
})
require("neotest").setup({
  adapters = {
    require("neotest-python")({}),
    require("neotest-gtest"),
    require("neotest-plenary"),
  },
})
require("configs.keymaps").neotest_keymaps()
