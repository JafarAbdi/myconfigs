---
name: exa-search
description: Web search and content extraction via Exa public MCP endpoint. Use for searching documentation, facts, or any web content. No API key required. Lightweight, no browser required.
---

# Exa Search

Web search and content extraction using Exa's public MCP endpoint. **No API key required.**

## Setup

No setup needed — no API key, no dependencies (pure `fetch`).

## Search

```bash
{baseDir}/search.js "query"                           # Basic search (5 results)
{baseDir}/search.js "query" -n 10                     # More results
{baseDir}/search.js "query" --highlights              # Include relevant highlights
{baseDir}/search.js "query" --text                    # Include full page text
{baseDir}/search.js "query" --highlights --text       # Both highlights and text
{baseDir}/search.js "query" --type fast               # Fast search for quick results
{baseDir}/search.js "query" --start-date 2024-01-01   # Filter by published date
{baseDir}/search.js "query" --domains "docs.rs,github.com"  # Limit to specific domains
{baseDir}/search.js "query" -n 3 --highlights         # Focused search with highlights
```

### Options

- `-n <num>` - Number of results (default: 5)
- `--highlights` - Include relevant highlights from each page
- `--text` - Include full text content from each page
- `--type <type>` - Search type: `auto` (default), `fast`
- `--start-date <date>` - Start published date (YYYY-MM-DD)
- `--end-date <date>` - End published date (YYYY-MM-DD)
- `--domains <list>` - Comma-separated domains to include
- `--exclude-domains <list>` - Comma-separated domains to exclude

## Extract Page Content

```bash
{baseDir}/content.js https://example.com/article                          # Extract text
{baseDir}/content.js https://example.com/article --highlights             # Auto highlights
{baseDir}/content.js https://example.com/article --highlights "AI"        # Query-guided highlights
{baseDir}/content.js url1 url2 url3                                       # Multiple URLs at once
```

### Options

- `--highlights [query]` - Include highlights, optionally guided by a search query
- `--max-chars <n>` - Max characters for text (default: 5000)
- `--text` - Full text (default behavior)

## Output Format

The MCP endpoint returns formatted text content directly, including titles, URLs, dates, and page content.

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching content from specific URLs
- Any task requiring web search without interactive browsing
- When you need highlights (more token-efficient than full text)
- When you need domain-filtered or date-filtered results
