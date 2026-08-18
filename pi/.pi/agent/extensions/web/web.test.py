# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "trafilatura==2.0.0",
# ]
# ///
"""Unit tests for web.py Content-Type routing, stubbing the network at _download_public."""

import unittest
from collections.abc import Iterator
from contextlib import contextmanager

import web

HTML_ARTICLE = (
    b"<!DOCTYPE html><html><head><title>T</title></head><body><article>"
    b"<h1>Sample Heading</h1>"
    b"<p>This is the first paragraph of a sample article with enough readable prose "
    b"for trafilatura to treat it as the main content and extract it as markdown.</p>"
    b"<p>A second paragraph adds more sentences so the extractor has the text density "
    b"it needs to confidently identify the article body and return non-empty output.</p>"
    b"</article></body></html>"
)


@contextmanager
def stub_download(body: bytes, content_type: str | None) -> Iterator[None]:
    """Replace the network fetch so _read_url routes on a crafted body and Content-Type."""
    original = web._download_public
    web._download_public = lambda url: (body, content_type)
    try:
        yield
    finally:
        web._download_public = original


def read(
    body: bytes, content_type: str | None, *, character_count_max: int = 3_000
) -> str:
    with stub_download(body, content_type):
        return web._read_url(
            "https://example.test/x",
            include_links=True,
            character_count_max=character_count_max,
        )


class MediaType(unittest.TestCase):
    def test_strips_parameters_and_lowercases(self) -> None:
        self.assertEqual(web._media_type("text/plain; charset=utf-8"), "text/plain")
        self.assertEqual(web._media_type("TEXT/HTML"), "text/html")

    def test_missing_header_is_empty(self) -> None:
        self.assertEqual(web._media_type(None), "")
        self.assertEqual(web._media_type(""), "")


class Bounded(unittest.TestCase):
    def test_short_text_passes_through_stripped(self) -> None:
        self.assertEqual(web._bounded("  hello  ", 100), "hello")

    def test_long_text_is_marked_truncated(self) -> None:
        result = web._bounded("x" * 50, 10)
        self.assertTrue(result.endswith("[truncated]"))
        self.assertIn("x" * 10, result)


class ReadRouting(unittest.TestCase):
    def test_plain_text_returns_verbatim_without_markup_loss(self) -> None:
        # The bug this fixes: a raw source file with <meta>/<?php in it must not go through
        # trafilatura or a browser, both of which eat the angle-bracket text.
        source = (
            b"<?php\n// Will be shown in <meta> tag on home page\nconst VERSION = 8;\n"
        )
        result = read(source, "text/plain; charset=utf-8")
        self.assertIn("<meta> tag on home page", result)
        self.assertIn("const VERSION = 8;", result)

    def test_html_is_extracted_as_markdown(self) -> None:
        result = read(HTML_ARTICLE, "text/html; charset=utf-8")
        self.assertIn("Sample Heading", result)
        self.assertIn("first paragraph", result)

    def test_missing_content_type_falls_through_to_extraction(self) -> None:
        # No Content-Type must not dump raw tag soup as a success; it takes the HTML path.
        result = read(HTML_ARTICLE, None)
        self.assertIn("Sample Heading", result)

    def test_html_without_article_fails_loud(self) -> None:
        with self.assertRaises(RuntimeError):
            read(b"<html><body></body></html>", "text/html")

    def test_undecodable_non_html_fails_loud(self) -> None:
        with self.assertRaises(RuntimeError):
            read(b"\xff\xfe\x00\x01", "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
