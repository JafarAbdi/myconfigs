require("neotest").setup({
  adapters = {
    require("neotest-python")({}),
    require("neotest-gtest"),
    require("neotest-plenary"),
  },
})
require("configs.keymaps").neotest_keymaps()
