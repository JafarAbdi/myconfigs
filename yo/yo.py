#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Direct llama-server client for the Fish `yo` function."""

import dataclasses
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from typing import Any

API_URL = "http://desktop.tail79ed4.ts.net:8080/v1/chat/completions"
MODEL = "qwen38-instruct"
MAX_MODEL_ROUNDS = 3
MAX_QUERY_CHARS = 8_000
MAX_SCROLLBACK_CHARS = 32_000
MAX_SCROLLBACK_LINES = 200
REQUEST_TIMEOUT = 120
SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
SPINNER_INTERVAL = 0.08

RESET = "\033[0m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
USE_COLOR = sys.stderr.isatty() and "NO_COLOR" not in os.environ

type JsonObject = dict[str, Any]
type Spinner = tuple[threading.Event, threading.Thread] | None

SYSTEM_PROMPT = """\
You are yo, a concise Fish shell assistant running in WezTerm on Linux.

Use the command tool whenever the user asks to do, inspect, install, remove,
configure, fix, create, delete, move, or otherwise accomplish something. The
command is prefilled for review and is never executed automatically. Return one
short, single-line Fish command and a brief explanation.

Reply with ordinary assistant content only for knowledge questions that need no
command. Use the scrollback tool when the request depends on recent terminal
output, such as an error, failure, previous command, or ambiguous reference.
Never ask the user to paste terminal output.

Generate Fish syntax, not Bash syntax. Use `(command)` substitutions, `set` for
variables, and `if ...; end` for conditionals. Avoid `$(command)`, `${name}`,
`[[ ... ]]`, and `export NAME=value`.
"""

TOOLS: tuple[JsonObject, ...] = (
    {
        "type": "function",
        "function": {
            "name": "command",
            "description": "Return one Fish command for the user to review; do not execute it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "A single-line Fish command to prefill",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "A brief explanation shown before the command",
                    },
                },
                "required": ["command", "explanation"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scrollback",
            "description": "Read recent text from the current WezTerm pane.",
            "parameters": {
                "type": "object",
                "properties": {
                    "lines": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SCROLLBACK_LINES,
                        "description": "Number of recent terminal lines to read",
                    }
                },
                "required": ["lines"],
                "additionalProperties": False,
            },
        },
    },
)


class YoError(RuntimeError):
    """Expected request, protocol, or tool failure."""


@dataclasses.dataclass(slots=True)
class ToolCall:
    identifier: str = ""
    name: str = ""
    arguments: str = ""

    def as_openai(self) -> JsonObject:
        return {
            "id": self.identifier,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments},
        }


def make_request(messages: list[JsonObject]) -> urllib.request.Request:
    payload = {
        "model": MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "stream": True,
        "max_tokens": 2_048,
        "chat_template_kwargs": {
            "enable_thinking": False,
            "preserve_thinking": False,
        },
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 20,
        "min_p": 0.0,
        "presence_penalty": 1.5,
        "repeat_penalty": 1.0,
    }
    return urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        },
        method="POST",
    )


def merge_tool_delta(tool_calls: list[ToolCall], raw_calls: object) -> None:
    if not isinstance(raw_calls, list):
        raise YoError("llama-server returned malformed tool calls")

    for raw_call in raw_calls:
        if not isinstance(raw_call, dict) or raw_call.get("index") != 0:
            raise YoError("parallel tool calls are not supported")
        if not tool_calls:
            tool_calls.append(ToolCall())

        tool_call = tool_calls[0]
        if identifier := raw_call.get("id"):
            if not isinstance(identifier, str):
                raise YoError("llama-server returned a malformed tool-call ID")
            tool_call.identifier = identifier

        function = raw_call.get("function")
        if not isinstance(function, dict):
            raise YoError("llama-server returned malformed tool-call arguments")
        if name := function.get("name"):
            if not isinstance(name, str):
                raise YoError("llama-server returned a malformed tool name")
            tool_call.name += name
        if arguments := function.get("arguments"):
            if not isinstance(arguments, str):
                raise YoError("llama-server returned malformed tool arguments")
            tool_call.arguments += arguments


def color(text: str, code: str) -> str:
    if not USE_COLOR:
        return text
    return f"{code}{text}{RESET}"


def print_tool(name: str, detail: str = "") -> None:
    suffix = color(f"  {detail}", DIM) if detail else ""
    print(f"{color('●', GREEN)} {name}{suffix}", file=sys.stderr, flush=True)


def animate_spinner(stop: threading.Event) -> None:
    frame_index = 0
    while not stop.is_set():
        frame = color(SPINNER_FRAMES[frame_index], CYAN)
        thinking = color("Thinking...", DIM)
        print(f"\r{frame} {thinking}", end="", file=sys.stderr, flush=True)
        frame_index = (frame_index + 1) % len(SPINNER_FRAMES)
        stop.wait(SPINNER_INTERVAL)


def start_spinner() -> Spinner:
    if not sys.stderr.isatty():
        return None
    stop = threading.Event()
    thread = threading.Thread(target=animate_spinner, args=(stop,), daemon=True)
    thread.start()
    return stop, thread


def stop_spinner(spinner: Spinner) -> None:
    if spinner is None:
        return
    stop, thread = spinner
    stop.set()
    thread.join()
    print("\r\033[K", end="", file=sys.stderr, flush=True)


def stream_completion(messages: list[JsonObject]) -> tuple[str, list[ToolCall]]:
    content_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    done = False
    spinner = start_spinner()

    try:
        with urllib.request.urlopen(
            make_request(messages), timeout=REQUEST_TIMEOUT
        ) as response:
            for raw_line in response:
                line = raw_line.decode().strip()
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").lstrip()
                if data == "[DONE]":
                    done = True
                    break

                try:
                    event = json.loads(data)
                except json.JSONDecodeError as error:
                    raise YoError("llama-server returned invalid event JSON") from error
                if not isinstance(event, dict):
                    raise YoError("llama-server returned a malformed event")
                if error := event.get("error"):
                    raise YoError(f"llama-server error: {error}")

                choices = event.get("choices")
                if not choices:
                    continue
                if not isinstance(choices, list) or not isinstance(choices[0], dict):
                    raise YoError("llama-server returned malformed choices")
                delta = choices[0].get("delta")
                if not isinstance(delta, dict):
                    raise YoError("llama-server returned a malformed delta")

                content = delta.get("content")
                if isinstance(content, str) and content:
                    stop_spinner(spinner)
                    spinner = None
                    content_parts.append(content)
                    print(content, end="", file=sys.stderr, flush=True)

                if raw_calls := delta.get("tool_calls"):
                    stop_spinner(spinner)
                    spinner = None
                    merge_tool_delta(tool_calls, raw_calls)
    except urllib.error.HTTPError as error:
        detail = error.read(4_096).decode(errors="replace").strip()
        message = f"llama-server returned HTTP {error.code}"
        if detail:
            message += f": {detail}"
        raise YoError(message) from error
    except urllib.error.URLError as error:
        raise YoError(f"cannot reach llama-server: {error.reason}") from error
    except TimeoutError as error:
        raise YoError("llama-server request timed out") from error
    finally:
        stop_spinner(spinner)

    if not done:
        raise YoError("llama-server closed the stream before [DONE]")
    return "".join(content_parts), tool_calls


def parse_arguments(tool_call: ToolCall) -> JsonObject:
    try:
        arguments = json.loads(tool_call.arguments)
    except json.JSONDecodeError as error:
        raise YoError(f"{tool_call.name} returned invalid JSON arguments") from error
    if not isinstance(arguments, dict):
        raise YoError(f"{tool_call.name} returned non-object arguments")
    return arguments


def read_scrollback(lines: int) -> str:
    pane_id = os.environ.get("WEZTERM_PANE")
    if not pane_id:
        return "(No terminal output available: WEZTERM_PANE is not set.)"

    try:
        result = subprocess.run(
            [
                "wezterm",
                "cli",
                "get-text",
                "--pane-id",
                pane_id,
                "--start-line",
                f"-{lines}",
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        return "(No terminal output available: wezterm is not installed.)"
    except subprocess.TimeoutExpired:
        return "(No terminal output available: wezterm timed out.)"

    if result.returncode != 0:
        return "(No terminal output available.)"
    text = result.stdout.rstrip()
    if not text:
        return "(No terminal output available.)"
    if len(text) > MAX_SCROLLBACK_CHARS:
        text = "(Earlier output truncated.)\n" + text[-MAX_SCROLLBACK_CHARS:]
    return text


def run_agent(query: str) -> str | None:
    messages: list[JsonObject] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"User request:\n{query}\n\nCurrent cwd:\n{os.getcwd()}",
        },
    ]

    for round_index in range(MAX_MODEL_ROUNDS):
        content, tool_calls = stream_completion(messages)
        if not tool_calls:
            if not content.strip():
                raise YoError("llama-server returned neither content nor a tool call")
            if not content.endswith("\n"):
                print(file=sys.stderr)
            return None
        if content and not content.endswith("\n"):
            print(file=sys.stderr)
        if len(tool_calls) != 1:
            raise YoError("parallel tool calls are not supported")

        tool_call = tool_calls[0]
        if not tool_call.identifier or not tool_call.name:
            raise YoError("llama-server returned an incomplete tool call")
        arguments = parse_arguments(tool_call)

        match tool_call.name:
            case "command":
                command = arguments.get("command")
                explanation = arguments.get("explanation")
                if not isinstance(command, str) or not command.strip():
                    raise YoError("command returned an empty command")
                if "\n" in command or "\r" in command:
                    raise YoError("command returned a multiline command")
                if not isinstance(explanation, str) or not explanation.strip():
                    raise YoError("command returned an empty explanation")
                detail = "" if content.strip() else explanation.strip()
                print_tool("command", detail)
                return command.strip()

            case "scrollback":
                lines = arguments.get("lines")
                if type(lines) is not int or not 1 <= lines <= MAX_SCROLLBACK_LINES:
                    raise YoError(
                        f"scrollback lines must be between 1 and {MAX_SCROLLBACK_LINES}"
                    )
                if round_index + 1 == MAX_MODEL_ROUNDS:
                    raise YoError("model-round limit reached after scrollback request")

                print_tool("scrollback", f"{lines} lines")
                messages.append(
                    {
                        "role": "assistant",
                        "content": content or None,
                        "tool_calls": [tool_call.as_openai()],
                    }
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.identifier,
                        "content": read_scrollback(lines),
                    }
                )

            case _:
                raise YoError(f"unknown tool: {tool_call.name}")

    raise YoError("model-round limit reached")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: yo.py <request>", file=sys.stderr)
        return 2

    query = sys.argv[1].strip()
    if not query:
        print(f"{color('yo:', RED)} empty request", file=sys.stderr)
        return 2
    if len(query) > MAX_QUERY_CHARS:
        message = f"request exceeds {MAX_QUERY_CHARS} characters"
        print(f"{color('yo:', RED)} {message}", file=sys.stderr)
        return 2

    try:
        if command := run_agent(query):
            print(command)
    except KeyboardInterrupt:
        print(f"\n{color('Cancelled.', YELLOW)}", file=sys.stderr)
        return 130
    except (OSError, YoError) as error:
        print(f"{color('yo:', RED)} {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
