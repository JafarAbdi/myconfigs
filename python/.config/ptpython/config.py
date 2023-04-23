# https://github.com/prompt-toolkit/ptpython/blob/master/examples/ptpython_config/config.py


def configure(repl):
    repl.show_signature = True
    repl.show_docstring = True
    repl.enable_open_in_editor = True
    repl.enable_auto_suggest = True
    repl.enable_fuzzy_completion = True
    repl.confirm_exit = False
    repl.color_depth = "DEPTH_24_BIT"
    repl.prompt_style = "ipython"
    repl.use_code_colorscheme("one-dark")
