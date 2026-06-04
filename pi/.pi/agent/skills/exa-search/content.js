#!/usr/bin/env node

// Exa Content Extraction via public MCP endpoint (no API key required)
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

const args = process.argv.slice(2);

// Parse options
let useHighlights = false;
let highlightQuery = null;
let maxChars = 5000;

const options = [];
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--highlights") {
    useHighlights = true;
    if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      highlightQuery = args[i + 1];
      i++;
    }
  } else if (args[i] === "--max-chars") {
    i++;
    if (i < args.length) {
      maxChars = parseInt(args[i], 10);
    }
  } else if (args[i] === "--text") {
    // --text is default behavior, no-op
  } else {
    urls.push(args[i]);
  }
}

if (urls.length === 0) {
  console.log("Usage: content.js <url> [url2 ...] [options]");
  console.log("");
  console.log("Extracts readable content from webpages using Exa MCP endpoint.");
  console.log("");
  console.log("Options:");
  console.log("  --highlights [query]   Include relevant highlights (optionally guided by a query)");
  console.log("  --max-chars <n>        Max characters for text (default: 5000)");
  console.log("  --text                 Include full text content (default behavior)");
  console.log("");
  console.log("No API key required (uses Exa public MCP endpoint).");
  console.log("");
  console.log("Examples:");
  console.log("  content.js https://example.com/article");
  console.log("  content.js https://example.com/article --highlights");
  console.log("  content.js https://example.com/article --highlights 'machine learning'");
  console.log("  content.js url1 url2 url3");
  process.exit(1);
}

function parseSSEResponse(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      return line.substring(6);
    }
  }
  throw new Error("No data: field found in SSE response");
}

async function callExaMCP(method, params) {
  const requestId = Date.now();
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  };

  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const jsonData = parseSSEResponse(text);
  return JSON.parse(jsonData);
}

function extractText(response) {
  if (response.error) {
    throw new Error(`Exa API error: ${response.error.code} - ${response.error.message}`);
  }
  if (!response.result || !response.result.content) {
    throw new Error("No content in response");
  }
  return response.result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

async function fetchContent(url) {
  // Extract domain from URL
  let domain;
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = url;
  }

  const searchParams = {
    query: url,
    numResults: 1,
    includeDomains: [domain],
  };

  const response = await callExaMCP("tools/call", {
    name: "web_search_exa",
    arguments: searchParams,
  });

  return extractText(response);
}

async function main() {
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`--- Result ${i + 1} ---`);
      console.log(`URL: ${url}`);

      try {
        const content = await fetchContent(url);
        console.log(content);
      } catch (e) {
        console.log(`(Error fetching content: ${e.message})`);
      }
      console.log("");
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
