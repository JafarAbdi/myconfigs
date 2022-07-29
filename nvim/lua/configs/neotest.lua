require("neotest").setup({
  adapters = {
    require("neotest-python")({}),
    require("neotest-gtest"),
  },
})
require("configs.keymaps").neotest_keymaps()
