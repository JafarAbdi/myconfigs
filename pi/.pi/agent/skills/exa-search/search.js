#!/usr/bin/env node

// Exa Search via public MCP endpoint (no API key required)
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

const args = process.argv.slice(2);

// Parse options
let numResults = 5;
let useHighlights = false;
let useText = false;
let searchType = "auto";
let startDate = null;
let endDate = null;
let includeDomains = null;
let excludeDomains = null;

const nIndex = args.indexOf("-n");
if (nIndex !== -1 && args[nIndex + 1]) {
  numResults = parseInt(args[nIndex + 1], 10);
  args.splice(nIndex, 2);
}

const highlightsIndex = args.indexOf("--highlights");
if (highlightsIndex !== -1) {
  useHighlights = true;
  args.splice(highlightsIndex, 1);
}

const textIndex = args.indexOf("--text");
if (textIndex !== -1) {
  useText = true;
  args.splice(textIndex, 1);
}

const typeIndex = args.indexOf("--type");
if (typeIndex !== -1 && args[typeIndex + 1]) {
  searchType = args[typeIndex + 1];
  args.splice(typeIndex, 2);
}

const startDateIndex = args.indexOf("--start-date");
if (startDateIndex !== -1 && args[startDateIndex + 1]) {
  startDate = args[startDateIndex + 1];
  args.splice(startDateIndex, 2);
}

const endDateIndex = args.indexOf("--end-date");
if (endDateIndex !== -1 && args[endDateIndex + 1]) {
  endDate = args[endDateIndex + 1];
  args.splice(endDateIndex, 2);
}

const domainsIndex = args.indexOf("--domains");
if (domainsIndex !== -1 && args[domainsIndex + 1]) {
  includeDomains = args[domainsIndex + 1].split(",").map(d => d.trim());
  args.splice(domainsIndex, 2);
}

const excludeDomainsIndex = args.indexOf("--exclude-domains");
if (excludeDomainsIndex !== -1 && args[excludeDomainsIndex + 1]) {
  excludeDomains = args[excludeDomainsIndex + 1].split(",").map(d => d.trim());
  args.splice(excludeDomainsIndex, 2);
}

const query = args.join(" ");

if (!query) {
  console.log("Usage: search.js <query> [options]");
  console.log("");
  console.log("Options:");
  console.log("  -n <num>               Number of results (default: 5)");
  console.log("  --highlights            Include relevant highlights from each page");
  console.log("  --text                  Include full text content from each page");
  console.log("  --type <type>           Search type: auto (default), fast");
  console.log("  --start-date <date>     Start published date (YYYY-MM-DD)");
  console.log("  --end-date <date>       End published date (YYYY-MM-DD)");
  console.log("  --domains <list>        Comma-separated domains to include");
  console.log("  --exclude-domains <list> Comma-separated domains to exclude");
  console.log("");
  console.log("No API key required (uses Exa public MCP endpoint).");
  console.log("");
  console.log("Examples:");
  console.log('  search.js "hottest AI startups"');
  console.log('  search.js "climate change research" -n 10 --highlights');
  console.log('  search.js "openai announcements" --type fast --start-date 2024-01-01');
  console.log('  search.js "rust programming" --domains "docs.rs,rust-lang.org" --text');
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

async function main() {
  try {
    // Build search params
    const searchParams = {
      query,
      numResults,
    };

    if (searchType !== "auto") searchParams.type = searchType;
    if (startDate) searchParams.startPublishedDate = startDate;
    if (endDate) searchParams.endPublishedDate = endDate;
    if (includeDomains) searchParams.includeDomains = includeDomains;
    if (excludeDomains) searchParams.excludeDomains = excludeDomains;

    const response = await callExaMCP("tools/call", {
      name: "web_search_exa",
      arguments: searchParams,
    });

    const content = extractText(response);
    console.log(content);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
