# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "trafilatura==2.0.0",
# ]
# ///
"""Search through 4get and extract readable Markdown from public web pages."""

import argparse
import concurrent.futures
import dataclasses
import datetime
import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

import trafilatura

DNS_ADDRESS_COUNT_MAX = 32
FETCH_BODY_BYTE_COUNT_MAX = 4 * 1024 * 1024
FETCH_REDIRECT_COUNT_MAX = 5
FETCH_URL_COUNT_MAX = 5
HTTP_TIMEOUT = 20
PAGE_CHARACTER_COUNT_DEFAULT = 3_000
PAGE_CHARACTER_COUNT_MAX = 20_000
SEARCH_RESPONSE_BYTE_COUNT_MAX = 4 * 1024 * 1024
SEARCH_RESULT_COUNT_DEFAULT = 10
SEARCH_RESULT_COUNT_MAX = 10
# Default mix: one Google index (google_cse), one independent index (brave), one Bing index (ddg).
FOURGET_SCRAPERS_DEFAULT = ("google_cse", "brave", "ddg")
USER_AGENT = "pi-web-extension/1.0"
TLS_CONTEXT = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))
HTML_MEDIA_TYPES = frozenset(("text/html", "application/xhtml+xml"))


@dataclasses.dataclass(frozen=True)
class PublicResponse:
    status: int
    location: str | None
    body: bytes
    content_type: str | None


@dataclasses.dataclass(frozen=True)
class ReadOutput:
    content: str
    errors: tuple[str, ...]


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a validated address while preserving TLS hostname verification."""

    def __init__(self, hostname: str, address: str, port: int) -> None:
        super().__init__(
            hostname,
            port=port,
            timeout=HTTP_TIMEOUT,
            context=TLS_CONTEXT,
        )
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._address, self.port),
            timeout=self.timeout,
        )
        self.sock = TLS_CONTEXT.wrap_socket(self.sock, server_hostname=self.host)


def _http_url(value: str, label: str) -> str:
    url = value.strip()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"{label} must use http:// or https://: {url}")
    if parsed.hostname is None:
        raise ValueError(f"{label} has no host: {url}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{label} must not contain credentials: {url}")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"{label} has an invalid port: {url}") from error
    return url


def _ascii_hostname(parsed: urllib.parse.SplitResult) -> str:
    assert parsed.hostname is not None
    try:
        return parsed.hostname.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ValueError(f"URL has an invalid hostname: {parsed.hostname}") from error


def _public_addresses(hostname: str, port: int, label: str) -> tuple[str, ...]:
    try:
        resolved = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ValueError(f"{label} host does not resolve: {hostname}") from error
    if not resolved:
        raise ValueError(f"{label} host has no addresses: {hostname}")
    if len(resolved) > DNS_ADDRESS_COUNT_MAX:
        raise ValueError(f"{label} host returned too many addresses: {hostname}")

    addresses: list[str] = []
    for entry in resolved:
        address = ipaddress.ip_address(entry[4][0])
        if not address.is_global:
            raise ValueError(f"{label} resolves outside the public internet: {hostname}")
        normalized = str(address)
        if normalized not in addresses:
            addresses.append(normalized)
    assert addresses
    return tuple(addresses)


def _public_target(url: str, label: str) -> tuple[urllib.parse.SplitResult, tuple[str, ...]]:
    parsed = urllib.parse.urlsplit(_http_url(url, label))
    hostname = _ascii_hostname(parsed)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed, _public_addresses(hostname, port, label)


def _host_header(parsed: urllib.parse.SplitResult) -> str:
    hostname = _ascii_hostname(parsed)
    if ":" in hostname:
        hostname = f"[{hostname}]"
    port = parsed.port
    if port is None:
        return hostname
    if parsed.scheme == "http" and port == 80:
        return hostname
    if parsed.scheme == "https" and port == 443:
        return hostname
    return f"{hostname}:{port}"


def _request_target(parsed: urllib.parse.SplitResult) -> str:
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    return target


def _connection(
    parsed: urllib.parse.SplitResult,
    address: str,
) -> http.client.HTTPConnection:
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "https":
        return PinnedHTTPSConnection(_ascii_hostname(parsed), address, port)
    return http.client.HTTPConnection(address, port=port, timeout=HTTP_TIMEOUT)


def _request_address(
    parsed: urllib.parse.SplitResult,
    address: str,
) -> PublicResponse:
    connection = _connection(parsed, address)
    try:
        connection.request(
            "GET",
            _request_target(parsed),
            headers={
                "Accept": "text/html,application/xhtml+xml,text/plain",
                "Accept-Encoding": "identity",
                "Host": _host_header(parsed),
                "User-Agent": USER_AGENT,
            },
        )
        response = connection.getresponse()
        if response.status in REDIRECT_STATUSES:
            return PublicResponse(response.status, response.getheader("Location"), b"", None)
        body = response.read(FETCH_BODY_BYTE_COUNT_MAX + 1)
        if len(body) > FETCH_BODY_BYTE_COUNT_MAX:
            raise RuntimeError("response exceeded 4 MiB")
        return PublicResponse(response.status, None, body, response.getheader("Content-Type"))
    finally:
        connection.close()


def _request_public(url: str) -> PublicResponse:
    parsed, addresses = _public_target(url, "URL")
    last_error: OSError | http.client.HTTPException | None = None
    for address in addresses:
        try:
            return _request_address(parsed, address)
        except (OSError, http.client.HTTPException) as error:
            last_error = error
    assert last_error is not None
    raise RuntimeError(f"failed to reach {url}: {last_error}") from last_error


def _download_public(url: str) -> tuple[bytes, str | None]:
    current = url
    for redirect_count in range(FETCH_REDIRECT_COUNT_MAX + 1):
        response = _request_public(current)
        if response.status in REDIRECT_STATUSES:
            if redirect_count == FETCH_REDIRECT_COUNT_MAX:
                raise RuntimeError(f"{url} exceeded {FETCH_REDIRECT_COUNT_MAX} redirects")
            if response.location is None:
                raise RuntimeError(f"{current} returned a redirect without Location")
            current = urllib.parse.urljoin(current, response.location)
            continue
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"{current} returned HTTP {response.status}")
        return response.body, response.content_type
    raise AssertionError("redirect loop exceeded its fixed bound")


@dataclasses.dataclass(frozen=True)
class Result:
    title: str
    url: str
    description: str
    date: str | None
    engines: tuple[str, ...]


@dataclasses.dataclass(frozen=True)
class ScraperOutput:
    scraper: str
    results: tuple[Result, ...]
    error: str | None


def _fourget_url() -> str:
    value = os.environ.get("FOURGET_URL", "").strip()
    if not value:
        raise ValueError("FOURGET_URL environment variable is not set")
    return _http_url(value, "FOURGET_URL")


def _search_url(query: str, scraper: str) -> str:
    normalized = query.strip()
    if not normalized:
        raise ValueError("search query is empty")
    parameters = urllib.parse.urlencode({"s": normalized, "scraper": scraper})
    return f"{_fourget_url().rstrip('/')}/api/v1/web?{parameters}"


def _download_search(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            body = response.read(SEARCH_RESPONSE_BYTE_COUNT_MAX + 1)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"4get returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"failed to reach 4get: {error.reason}") from error
    except OSError as error:
        raise RuntimeError(f"failed to reach 4get: {error}") from error
    if len(body) > SEARCH_RESPONSE_BYTE_COUNT_MAX:
        raise RuntimeError("4get response exceeded 4 MiB")
    return body


def _clean(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _date(value: object) -> str | None:
    """4get dates are unix seconds or null; render as an ISO date when present."""
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    try:
        return datetime.datetime.fromtimestamp(value, tz=datetime.UTC).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _web_item(item: dict[str, object], scraper: str) -> Result | None:
    url = _clean(item.get("url"))
    if not url:
        return None
    return Result(
        title=_clean(item.get("title")),
        url=url,
        description=_clean(item.get("description")),
        date=_date(item.get("date")),
        engines=(scraper,),
    )


def _scrape(query: str, scraper: str) -> ScraperOutput:
    """Query one scraper. Network and per-engine failures become a non-fatal `error`."""
    try:
        payload = json.loads(_download_search(_search_url(query, scraper)))
    except (RuntimeError, ValueError) as error:
        return ScraperOutput(scraper, (), str(error))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return ScraperOutput(scraper, (), "4get returned invalid JSON")
    if not isinstance(payload, dict):
        return ScraperOutput(scraper, (), "response is not an object")
    status = payload.get("status")
    web = payload.get("web")
    if status != "ok" or not isinstance(web, list):
        reason = status if isinstance(status, str) else "no web results"
        return ScraperOutput(scraper, (), reason)
    results = tuple(
        result
        for item in web
        if isinstance(item, dict) and (result := _web_item(item, scraper)) is not None
    )
    return ScraperOutput(scraper, results, None)


def _dedupe_key(url: str) -> str:
    return url.rstrip("/").lower()


def _merge(outputs: list[ScraperOutput], result_count: int) -> list[Result]:
    """Round-robin interleave engines by rank, dedupe by URL, union engine tags."""
    merged: dict[str, Result] = {}
    order: list[str] = []
    columns = [output.results for output in outputs]
    depth = max((len(column) for column in columns), default=0)
    for rank in range(depth):
        for column in columns:
            if rank >= len(column):
                continue
            hit = column[rank]
            key = _dedupe_key(hit.url)
            if existing := merged.get(key):
                extra = tuple(engine for engine in hit.engines if engine not in existing.engines)
                merged[key] = dataclasses.replace(existing, engines=existing.engines + extra)
            else:
                merged[key] = hit
                order.append(key)
    return [merged[key] for key in order[:result_count]]


def _format_result(index: int, result: Result) -> str:
    title = result.title or "(untitled)"
    lines = [f"{index}. {title}  [{', '.join(result.engines)}]", f"   URL: {result.url}"]
    if result.date:
        lines.append(f"   Date: {result.date}")
    if result.description:
        lines.append(f"   {result.description}")
    return "\n".join(lines)


def search(query: str, result_count: int) -> str:
    if not 1 <= result_count <= SEARCH_RESULT_COUNT_MAX:
        raise ValueError(f"results must be between 1 and {SEARCH_RESULT_COUNT_MAX}")
    scrapers = FOURGET_SCRAPERS_DEFAULT
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(scrapers)) as pool:
        outputs = list(pool.map(lambda scraper: _scrape(query, scraper), scrapers))

    failures = [output for output in outputs if output.error is not None]
    if len(failures) == len(scrapers):
        detail = "; ".join(f"{output.scraper}: {output.error}" for output in failures)
        raise RuntimeError(f"all scrapers failed — {detail}")

    results = _merge(outputs, result_count)
    body = (
        "\n\n".join(_format_result(index, result) for index, result in enumerate(results, start=1))
        if results
        else "No results found."
    )
    if failures:
        note = "; ".join(f"{output.scraper}: {output.error}" for output in failures)
        body += f"\n\n(unavailable — {note})"
    return body


def _media_type(content_type: str | None) -> str:
    """Return the lowercased media type from a Content-Type header, dropping any parameters."""
    return (content_type or "").split(";", 1)[0].strip().lower()


def _bounded(text: str, character_count_max: int) -> str:
    """Strip `text` and clip it to `character_count_max`, marking any truncation."""
    normalized = text.strip()
    if len(normalized) > character_count_max:
        return f"{normalized[:character_count_max].rstrip()}\n\n[truncated]"
    return normalized


def _read_url(url: str, *, include_links: bool, character_count_max: int) -> str:
    body, content_type = _download_public(url)
    media_type = _media_type(content_type)
    if media_type and media_type not in HTML_MEDIA_TYPES:
        try:
            text = body.decode()
        except UnicodeDecodeError as error:
            raise RuntimeError(f"{url} is not decodable text ({content_type})") from error
        return _bounded(text, character_count_max)
    try:
        content = trafilatura.extract(
            body,
            output_format="markdown",
            include_links=include_links,
        )
    except Exception as error:
        raise RuntimeError(f"failed to extract content from {url}: {error}") from error
    if not content:
        raise RuntimeError(f"failed to extract readable content from {url}")
    return _bounded(content, character_count_max)


def read_urls(urls: list[str], *, include_links: bool, character_count_max: int) -> ReadOutput:
    if len(urls) > FETCH_URL_COUNT_MAX:
        raise ValueError(f"read accepts at most {FETCH_URL_COUNT_MAX} URLs")
    if not 1 <= character_count_max <= PAGE_CHARACTER_COUNT_MAX:
        raise ValueError(f"max-chars must be between 1 and {PAGE_CHARACTER_COUNT_MAX}")
    pages: list[str] = []
    errors: list[str] = []
    for url in urls:
        try:
            content = _read_url(
                url,
                include_links=include_links,
                character_count_max=character_count_max,
            )
        except (RuntimeError, ValueError) as error:
            errors.append(str(error))
        else:
            pages.append(f"URL: {url}\n\n{content}")
    return ReadOutput(content="\n\n".join(pages), errors=tuple(errors))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search and read the public web")
    commands = parser.add_subparsers(dest="command", required=True)
    search_parser = commands.add_parser("search", help="Search through 4get")
    search_parser.add_argument("query", help="search query")
    search_parser.add_argument(
        "--results",
        dest="result_count",
        type=int,
        default=SEARCH_RESULT_COUNT_DEFAULT,
    )
    read_parser = commands.add_parser("read", help="Extract readable Markdown")
    read_parser.add_argument("urls", nargs="+", help="public HTTP(S) URLs")
    read_parser.add_argument(
        "--max-chars",
        dest="character_count_max",
        type=int,
        default=PAGE_CHARACTER_COUNT_DEFAULT,
    )
    read_parser.add_argument("--links", action="store_true", help="preserve hyperlinks")
    return parser


def main() -> None:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "search":
            print(search(arguments.query, arguments.result_count))
            return
        if arguments.command == "read":
            output = read_urls(
                arguments.urls,
                include_links=arguments.links,
                character_count_max=arguments.character_count_max,
            )
            if output.content:
                print(output.content)
            for error in output.errors:
                print(error, file=sys.stderr)
            if output.errors:
                raise SystemExit(1)
            return
        raise AssertionError(f"unknown command: {arguments.command}")
    except (RuntimeError, ValueError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
