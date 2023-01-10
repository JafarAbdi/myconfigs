return {
  {
    "nvim-telescope/telescope.nvim",
    dependencies = {
      "nvim-telescope/telescope-ui-select.nvim",
      { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
    },
    config = function()
      -- TODO: Pretty sure _ will be telescope which remove the requirement to run require("telescope......")
      local actions_layout = require("telescope.actions.layout")
      local actions = require("telescope.actions")
      local finders = require("telescope.finders")
      local make_entry = require("telescope.make_entry")
      local action_state = require("telescope.actions.state")
      local fd_executable = (vim.fn.executable("fd") == 1 and "fd") or "fdfind"
      local fd_options = {
        hidden = false,
        cmd = { fd_executable, "--type", "f", "--strip-cwd-prefix", "--ignore" },
      }

      -- Telescope
      local dropdown_configs = {
        layout_strategy = "vertical",
        layout_config = {
          prompt_position = "bottom",
          vertical = {
            width = 0.8,
            height = 100,
          },
        },
      }

      -- TODO: Why multiple setup??
      require("telescope").setup({
        defaults = require("telescope.themes").get_dropdown(dropdown_configs),
      })

      require("telescope").setup({
        extensions = {
          ["ui-select"] = {
            require("telescope.themes").get_dropdown(dropdown_configs),
          },
        },
        pickers = {
          find_files = {
            find_command = fd_options.cmd,
            mappings = {
              i = {
                ["<C-h>"] = function(prompt_bufnr)
                  fd_options.hidden = not fd_options.hidden
                  local opts = {}
                  opts.entry_maker = make_entry.gen_from_file(opts)

                  local cmd = vim.deepcopy(fd_options.cmd)
                  if fd_options.hidden then
                    table.insert(cmd, "--hidden")
                  end
                  local current_picker = action_state.get_current_picker(prompt_bufnr)
                  current_picker:refresh(finders.new_oneshot_job(cmd, opts), {})
                end,
              },
            },
          },
        },
        defaults = {
          mappings = {
            i = {
              ["<F2>"] = actions_layout.toggle_preview,
              -- Change to C-j/k??? This conflict with moving between windows/panes
              ["<M-j>"] = actions.preview_scrolling_down,
              ["<M-k>"] = actions.preview_scrolling_up,
              ["<esc>"] = actions.close,
              ["<C-s>"] = actions.select_horizontal,
              ["<C-u>"] = false,
              ["<C-d>"] = false,
              ["<C-x>"] = false,
            },
          },
        },
      })

      -- Enable telescope extensions
      require("telescope").load_extension("ui-select")
      require("telescope").load_extension("fzf")
    end,
  },
}
