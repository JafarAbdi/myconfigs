local M = {}

local function program()
  return vim.fn.input({
    prompt = "Path to executable: ",
    default = vim.fn.getcwd() .. "/",
    completion = "file",
  })
end

M.launch_lldb_in_console = {
  name = "lldb: Launch (console)",
  type = "lldb",
  request = "launch",
  program = program,
  cwd = "${workspaceFolder}",
  stopOnEntry = false,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " ")
  end,
  runInTerminal = false,
}

M.launch_lldb_in_terminal = {
  name = "lldb: Launch (integratedTerminal)",
  type = "lldb",
  request = "launch",
  program = program,
  cwd = "${workspaceFolder}",
  stopOnEntry = false,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " ")
  end,
  runInTerminal = true,
}

M.launch_python_in_terminal = {
  type = "python",
  request = "launch",
  name = "Launch file with arguments",
  program = program,
  args = function()
    local args_string = vim.fn.input("Arguments: ")
    return vim.split(args_string, " +")
  end,
}

return M
