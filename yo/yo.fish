set -l __yo_file (realpath (status filename) 2>/dev/null)
if test -z "$__yo_file"
    echo 'yo: cannot resolve yo.fish path' >&2
    return 1
end

set -l __yo_root (dirname "$__yo_file")
set -g __yo_agent_dir "$__yo_root/pi/agent"

function __yo_pane_environment
    if not set -q __yo_agent_dir; or test -z "$__yo_agent_dir"
        __yo_error '__yo_agent_dir is not set; source yo-fish/conf.d/yo.fish'
        return 1
    end

    if not set -q WEZTERM_PANE; or test -z "$WEZTERM_PANE"
        __yo_error 'WEZTERM_PANE is not set; yo-fish requires WezTerm'
        return 1
    end

    if not set -q XDG_RUNTIME_DIR; or test -z "$XDG_RUNTIME_DIR"
        __yo_error 'XDG_RUNTIME_DIR is not set'
        return 1
    end
end

function __yo_environment
    __yo_pane_environment; or return $status

    for command_name in pi jq wezterm
        if not type -q $command_name
            __yo_error "$command_name is required"
            return 127
        end
    end
end

function __yo_color_stdout --argument-names color
    if isatty stdout
        set_color $color
    end
end

function __yo_color_stderr --argument-names color
    if isatty stderr
        set_color $color >&2
    end
end

function __yo_error --argument-names message
    __yo_color_stderr red
    printf 'yo: %s\n' "$message" >&2
    __yo_color_stderr normal
end

function __yo_info --argument-names message
    __yo_color_stdout brcyan
    printf '%s\n' "$message"
    __yo_color_stdout normal
end

function __yo_chat --argument-names message
    __yo_color_stdout cyan
    printf '%s\n' "$message"
    __yo_color_stdout normal
end

function __yo_warn --argument-names message
    __yo_color_stderr yellow
    printf '%s\n' "$message" >&2
    __yo_color_stderr normal
end

function __yo_thinking
    if isatty stderr
        __yo_color_stderr brcyan
        printf 'Thinking...\n' >&2
        __yo_color_stderr normal
    end
end

function __yo_cancel_commandline --description 'Cancel current commandline and clear yo state'
    __yo_clear_state 2>/dev/null
    commandline -f cancel-commandline repaint
end

function __yo_runtime_dir
    set -l path "$XDG_RUNTIME_DIR/yo-fish"
    mkdir -p "$path"
    printf '%s\n' "$path"
end

function __yo_sanitize_id --argument-names raw
    set -l safe (string replace -ra '[^A-Za-z0-9._-]+' '-' -- "$raw")
    set safe (string replace -ra '^[^A-Za-z0-9]+' '' -- "$safe")
    set safe (string replace -ra '[^A-Za-z0-9]+$' '' -- "$safe")
    if test -z "$safe"
        set safe yo
    end
    printf '%s\n' "$safe"
end

function __yo_pane_id
    if not set -q WEZTERM_PANE; or test -z "$WEZTERM_PANE"
        __yo_error 'WEZTERM_PANE is not set; yo-fish requires WezTerm'
        return 1
    end

    __yo_sanitize_id "pane-$WEZTERM_PANE"
end

function __yo_session_id
    set -l pane_id (__yo_pane_id); or return 1
    __yo_sanitize_id "yo-fish-$pane_id"
end

function __yo_session_dir
    printf '%s/sessions\n' (__yo_runtime_dir)
end

function __yo_state_path
    set -l pane_id (__yo_pane_id); or return 1
    printf '%s/%s.state.json\n' (__yo_runtime_dir) "$pane_id"
end

function __yo_detect_distro
    if not test -r /etc/os-release
        return 0
    end

    set -l line (string match -r '^PRETTY_NAME=' < /etc/os-release | head -n 1)
    if test -z "$line"
        return 0
    end

    set -l distro (string replace -r '^PRETTY_NAME=' '' -- "$line")
    set distro (string replace -ra '^"|"$' '' -- "$distro")
    printf '%s\n' "$distro"
end

function __yo_system_prompt_path
    printf '%s/SYSTEM.md\n' "$__yo_agent_dir"
end

function __yo_json_get --argument-names json key
    printf '%s' "$json" | jq -r --arg key "$key" '.[$key] // empty'
end

function __yo_state_is_current_shell --argument-names state_path
    if not test -s "$state_path"
        return 1
    end

    set -l matches (jq -r --argjson shell_pid "$fish_pid" '.shell_pid == $shell_pid' "$state_path" 2>/dev/null)
    test "$matches" = true
end

function __yo_capture_wezterm_scrollback
    if not set -q WEZTERM_PANE; or test -z "$WEZTERM_PANE"
        return 1
    end

    if not type -q wezterm
        return 1
    end

    command wezterm cli get-text \
        --pane-id "$WEZTERM_PANE" \
        --start-line -200 \
        2>/dev/null | string collect
end

function __yo_write_state --argument-names response_json query
    set -l state_path (__yo_state_path); or return 1
    mkdir -p (dirname "$state_path")

    set -l timestamp (date +%s)
    jq -nc \
        --argjson response "$response_json" \
        --arg query "$query" \
        --arg cwd "$PWD" \
        --argjson timestamp "$timestamp" \
        --argjson fish_pid "$fish_pid" \
        '{
            query: $query,
            suggested_command: ($response.command // ""),
            actual_command: "",
            edited: false,
            pending: (($response.pending // false) == true),
            cwd: $cwd,
            timestamp: $timestamp,
            shell_pid: $fish_pid,
            inserted: false,
            continuation_requested: false,
            exit_status: null,
        }' > "$state_path"
end

function __yo_state_update_actual --argument-names actual
    set -l state_path (__yo_state_path); or return 1
    if not test -s "$state_path"
        return 0
    end

    set -l tmp "$state_path.tmp"
    jq -c --arg actual "$actual" \
        '.actual_command = $actual | .edited = ($actual != (.suggested_command // ""))' \
        "$state_path" > "$tmp"
    set -l jq_status $status
    if test $jq_status -ne 0
        rm -f "$tmp"
        return $jq_status
    end
    mv "$tmp" "$state_path"
end

function __yo_state_mark_inserted
    set -l state_path (__yo_state_path); or return 1
    if not test -s "$state_path"
        return 0
    end

    set -l tmp "$state_path.tmp"
    jq -c '.inserted = true' "$state_path" > "$tmp"
    set -l jq_status $status
    if test $jq_status -ne 0
        rm -f "$tmp"
        return $jq_status
    end
    mv "$tmp" "$state_path"
end

function __yo_state_request_continuation --argument-names actual exit_status
    set -l state_path (__yo_state_path); or return 1
    if not test -s "$state_path"
        return 0
    end

    set -l tmp "$state_path.tmp"
    jq -c --arg actual "$actual" --argjson exit_status "$exit_status" \
        '.actual_command = $actual
        | .edited = ($actual != (.suggested_command // ""))
        | .exit_status = $exit_status
        | .continuation_requested = true
        | .inserted = true' \
        "$state_path" > "$tmp"
    set -l jq_status $status
    if test $jq_status -ne 0
        rm -f "$tmp"
        return $jq_status
    end
    mv "$tmp" "$state_path"
end

function __yo_state_clear_continuation_request
    set -l state_path (__yo_state_path); or return 1
    if not test -s "$state_path"
        return 0
    end

    set -l tmp "$state_path.tmp"
    jq -c '.continuation_requested = false' "$state_path" > "$tmp"
    set -l jq_status $status
    if test $jq_status -ne 0
        rm -f "$tmp"
        return $jq_status
    end
    mv "$tmp" "$state_path"
end

function __yo_clear_state
    set -l state_path (__yo_state_path); or return 1
    rm -f "$state_path"
end

function __yo_reset_context
    set -l session_dir (__yo_session_dir)
    set -l session_id (__yo_session_id); or return 1
    __yo_clear_state; or return 1

    if test -d "$session_dir"
        for path in (find "$session_dir" -type f -name '*.jsonl' 2>/dev/null)
            set -l id (head -n 1 "$path" | jq -r '.id // empty' 2>/dev/null)
            if test "$id" = "$session_id"
                rm -f "$path"
            end
        end
        find "$session_dir" -depth -type d -empty -delete 2>/dev/null
    end

    printf 'Context reset\n'
end

function __yo_build_user_prompt --argument-names query continuation executed_command exit_status
    if test "$continuation" = 1
        set -l state_path (__yo_state_path); or return 1
        if not test -r "$state_path"
            __yo_error 'no pending yo continuation'
            return 1
        end

        set -l state_json (string collect < "$state_path")
        set -l suggested (__yo_json_get "$state_json" suggested_command | string collect)
        set -l actual (__yo_json_get "$state_json" actual_command | string collect)
        set -l edited (__yo_json_get "$state_json" edited | string collect)
        if test -z "$actual"
            set actual "$executed_command"
        end

        printf 'Continue the pending shell task.\n'
        printf '\nOriginal suggested command:\n%s\n' "$suggested"
        printf '\nActual executed command:\n%s\n' "$actual"
        printf '\nEdited command:\n%s\n' "$edited"
        printf '\nExit status:\n%s\n' "$exit_status"
        printf '\nCurrent cwd:\n%s\n' "$PWD"

        set -l context (__yo_capture_wezterm_scrollback)
        if test -n "$context"
            printf '\nRecent WezTerm pane scrollback:\n<context>\n%s\n</context>\n' "$context"
        end
    else
        printf 'User request:\n%s\n\nCurrent cwd:\n%s\n' "$query" "$PWD"
    end
end

function __yo_parse_pi_events_file --argument-names path
    jq -sec 'map(select(.result.details.type == .toolName) | .result.details) | last // empty' "$path"
end

function __yo_handle_response_file --argument-names output_file query
    set -l json (__yo_parse_pi_events_file "$output_file" | string collect)
    if test $status -ne 0; or test -z "$json"
        __yo_error 'Pi did not return a yo command/chat tool result.'
        return 1
    end

    set -l type (__yo_json_get "$json" type | string collect)
    switch "$type"
        case command
            set -l command_text (__yo_json_get "$json" command | string collect)
            set -l explanation (__yo_json_get "$json" explanation | string collect)

            if test -n "$explanation"
                __yo_info "$explanation"
            end

            __yo_write_state "$json" "$query"; or return 1

            if not status is-interactive
                printf '%s\n' "$command_text"
            end
        case chat
            set -l response (__yo_json_get "$json" response | string collect)
            __yo_clear_state
            __yo_chat "$response"
        case '*'
            __yo_error "unknown yo response type: $type"
            printf '%s\n' "$json"
            return 1
    end
end

function __yo_kept_files --argument-names output_file error_file
    __yo_warn 'kept request files:'
    __yo_warn "  $output_file"
    __yo_warn "  $error_file"
end

function __yo_run_request --argument-names query continuation executed_command exit_status
    set -l runtime_dir (__yo_runtime_dir)
    set -l output_file "$runtime_dir/current.filtered.jsonl"
    set -l error_file "$runtime_dir/current.stderr.txt"
    rm -f "$output_file" "$error_file"

    set -l prompt (__yo_build_user_prompt "$query" "$continuation" "$executed_command" "$exit_status" | string collect)
    set -l prompt_status $pipestatus[1]
    if test $prompt_status -ne 0
        return $prompt_status
    end

    set -l system_prompt_path (__yo_system_prompt_path | string collect)
    set -l system_prompt_status $pipestatus[1]
    if test $system_prompt_status -ne 0
        return $system_prompt_status
    end

    set -l append_system_prompt
    set -l distro (__yo_detect_distro)
    if test -n "$distro"
        set append_system_prompt --append-system-prompt "The user is running $distro."
    end

    set -l session_dir (__yo_session_dir)
    set -l session_id (__yo_session_id); or return 1
    mkdir -p "$session_dir"

    __yo_thinking

    set -l jq_filter 'select(.type == "tool_execution_end" and (.toolName == "command" or .toolName == "chat"))'
    env PI_CODING_AGENT_DIR="$__yo_agent_dir" PI_TELEMETRY=0 \
        pi -nc --no-approve \
        --mode json \
        --session-dir "$session_dir" \
        --session-id "$session_id" \
        --offline \
        --no-extensions \
        --extension "$__yo_agent_dir/extensions/yo-tools.ts" \
        --no-skills \
        --no-prompt-templates \
        --no-themes \
        --no-builtin-tools \
        --tools command,chat,scrollback,docs \
        --system-prompt "$system_prompt_path" \
        $append_system_prompt \
        "$prompt" 2> "$error_file" | jq -c "$jq_filter" > "$output_file"
    set -l pipe_status $pipestatus
    set -l pi_status $pipe_status[1]
    set -l jq_status $pipe_status[2]

    if contains -- $pi_status 130 131 137 143
        rm -f "$output_file" "$error_file"
        __yo_warn 'Cancelled.'
        return 130
    end

    if test $jq_status -ne 0
        __yo_error "jq failed with status $jq_status"
        __yo_kept_files "$output_file" "$error_file"
        return $jq_status
    end

    if test $pi_status -ne 0
        set -l error_text (string collect < "$error_file")
        if test -n "$error_text"
            __yo_error "$error_text"
        else
            __yo_error "Pi failed with status $pi_status"
        end
        __yo_kept_files "$output_file" "$error_file"
        return $pi_status
    end

    __yo_handle_response_file "$output_file" "$query"
    set -l handle_status $status
    if test $handle_status -eq 0
        rm -f "$output_file" "$error_file"
    else
        __yo_kept_files "$output_file" "$error_file"
    end
    return $handle_status
end

function __yo_prompt_prefill --on-event fish_prompt --description 'Prefill completed yo commands'
    __yo_pane_environment; or return

    set -l state_path (__yo_state_path); or return
    __yo_state_is_current_shell "$state_path"; or return

    set -l state_json (string collect < "$state_path")
    set -l continuation_requested (__yo_json_get "$state_json" continuation_requested | string collect)
    if test "$continuation_requested" = true
        commandline --replace '__yo_continue'
        commandline -f execute
        return
    end

    set -l inserted (__yo_json_get "$state_json" inserted | string collect)
    if test "$inserted" = true
        return
    end

    set -l command_text (__yo_json_get "$state_json" suggested_command | string collect)
    if test -z "$command_text"
        return
    end

    if commandline --replace "$command_text" 2>/dev/null
        commandline --cursor (string length -- "$command_text")
        __yo_state_mark_inserted
    end
end

function __yo_preexec --on-event fish_preexec --description 'Capture edited yo commands'
    __yo_pane_environment; or return

    set -l state_path (__yo_state_path); or return
    __yo_state_is_current_shell "$state_path"; or return

    set -l actual (string join ' ' -- $argv)
    if test -z "$actual"
        return
    end

    if string match -qr '^(yo|__yo_request|__yo_continue)(\s|$)' -- (string trim -- "$actual")
        return
    end

    __yo_state_update_actual "$actual"
end

function __yo_postexec --on-event fish_postexec --description 'Automatically continue pending yo tasks'
    set -l last_status $status
    set -l executed_command (string join ' ' -- $argv)

    __yo_pane_environment; or return

    set -l state_path (__yo_state_path); or return
    __yo_state_is_current_shell "$state_path"; or return

    if string match -qr '^(yo|__yo_request|__yo_continue)(\s|$)' -- (string trim -- "$executed_command")
        return
    end

    set -l state_json (string collect < "$state_path")
    set -l pending (__yo_json_get "$state_json" pending | string collect)
    set -l actual (__yo_json_get "$state_json" actual_command | string collect)
    if test -z "$actual"
        set actual "$executed_command"
    end

    if test "$pending" != true
        __yo_clear_state
        return
    end

    __yo_state_request_continuation "$actual" "$last_status"
end

function __yo_continue --description 'Continue a pending yo task as a normal foreground command'
    __yo_environment; or return $status

    set -l state_path (__yo_state_path); or return 1
    if not __yo_state_is_current_shell "$state_path"
        __yo_error 'no pending yo continuation'
        return 1
    end

    set -l state_json (string collect < "$state_path")
    set -l actual (__yo_json_get "$state_json" actual_command | string collect)
    set -l exit_status (__yo_json_get "$state_json" exit_status | string collect)
    if test -z "$exit_status"
        set exit_status 0
    end

    __yo_state_clear_continuation_request
    __yo_run_request "" 1 "$actual" "$exit_status"
end

function __yo_accept_line --description 'Intercept Enter for yo-prefixed commandlines'
    set -l buffer (commandline | string trim)

    if test -z "$buffer"
        __yo_clear_state 2>/dev/null
        commandline -f execute
        return
    end

    if string match -qr '^yo(\s|$)' -- "$buffer"
        __yo_clear_state 2>/dev/null
        set -l query (string replace -r '^yo\s*' '' -- "$buffer")
        if test -z "$query"
            commandline --replace 'yo --help'
        else if test "$query" = reset
            commandline --replace 'yo reset'
        else
            commandline --replace " yo "(string escape -- "$query")
        end
    end

    commandline -f execute
end

function __yo_request --description 'Run a yo request from the Enter binding'
    __yo_environment; or return $status

    if test (count $argv) -eq 0
        __yo_error 'missing request'
        return 2
    end

    set -l query (string join ' ' -- $argv)
    __yo_clear_state; or return $status
    __yo_run_request "$query" 0 "" ""
end

function yo --description 'Ask Pi for shell help and prefill suggested commands'
    __yo_environment; or return $status

    set -l query_parts

    while test (count $argv) -gt 0
        switch $argv[1]
            case --help -h help
                printf '%s\n' \
                    'Usage: yo <request>' \
                    '       yo reset'
                return 0
            case reset
                __yo_reset_context
                return 0
            case '*'
                set --append query_parts $argv[1]
        end
        set --erase argv[1]
    end

    if test (count $query_parts) -eq 0
        __yo_error 'missing request'
        return 2
    end

    __yo_request $query_parts
end

if status is-interactive
    complete -e yo 2>/dev/null
    complete -c yo -a reset -d 'Clear yo context'

    bind \r __yo_accept_line
    bind \cc __yo_cancel_commandline
    bind --mode insert \r __yo_accept_line 2>/dev/null
    bind --mode insert \cc __yo_cancel_commandline 2>/dev/null
end
