require("neotest-gtest").setup({
  test_path_pattern = { ".*%.cpp", ".*%.cc" }, -- The path pattern to detect test files
})
require("neotest").setup({
  icons = {
    passed = "✔",
    running = "🗘",
    failed = "✖",
    skipped = "ﰸ",
    unknown = "?",
  },
  adapters = {
    require("neotest-python")({}),
    require("neotest-gtest"),
    require("neotest-plenary"),
    require("neotest-rust"),
  },
})
require("configs.keymaps").neotest_keymaps()
