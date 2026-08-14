if status is-interactive
    for mode in default insert
        set -l enter_binding (bind --user --mode $mode enter 2>/dev/null | string collect)
        if string match -q '*__yo_accept_line*' -- "$enter_binding"
            bind --user --mode $mode --erase enter
        end
        set -l cancel_binding (bind --user --mode $mode ctrl-c 2>/dev/null | string collect)
        if string match -q '*__yo_cancel_commandline*' -- "$cancel_binding"
            bind --user --mode $mode --erase ctrl-c
        end
    end
    complete --erase yo 2>/dev/null
end
for function_name in (functions --all | string match '__yo_*')
    functions --erase $function_name
end
set --erase __yo_agent_dir __yo_model

set -l __yo_source (realpath (status filename) 2>/dev/null)
if test -z "$__yo_source"
    echo 'yo: cannot resolve yo.fish path' >&2
    return 1
end
set -g __yo_script (dirname "$__yo_source")/yo.py

function __yo_message --argument-names color message
    if isatty stderr
        set_color $color >&2
    end
    printf 'yo: %s\n' "$message" >&2
    if isatty stderr
        set_color normal >&2
    end
end

function yo --description 'Ask for shell help and prefill a Fish command'
    if test (count $argv) -eq 0
        printf 'Usage: yo <request>\n'
        return 0
    end

    switch $argv[1]
        case --help -h help
            printf 'Usage: yo <request>\n'
            return 0
    end

    if not type -q uv
        __yo_message red 'uv is required'
        return 127
    end
    if not test -r "$__yo_script"
        __yo_message red "cannot read $__yo_script"
        return 1
    end

    set -l query (string join ' ' -- $argv)
    set -l command_text (command uv run --script "$__yo_script" "$query")
    set -l run_status $status
    if test $run_status -ne 0
        return $run_status
    end
    if test -z "$command_text"
        return 0
    end

    if status is-interactive
        commandline --replace "$command_text" 2>/dev/null
        or begin
            __yo_message yellow 'could not prefill commandline; printing suggestion instead'
            printf '%s\n' "$command_text"
            return 1
        end
        commandline --cursor (string length -- "$command_text") 2>/dev/null
        commandline -f repaint 2>/dev/null
    else
        printf '%s\n' "$command_text"
    end
end
