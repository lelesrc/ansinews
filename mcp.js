#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const { normalizeConfig, parseRSS, VERSION, setDefaultFeeds, normalizeCatalog } = require('./news-core.js');

const DEFAULT_FEEDS_PATH = path.join(__dirname, 'default_feeds.json');
try {
  setDefaultFeeds(normalizeCatalog(JSON.parse(fs.readFileSync(DEFAULT_FEEDS_PATH, 'utf8'))));
} catch (e) { /* catalog unavailable */ }

// ---------------------------------------------------------------------------
// Config I/O (same paths and priority as news.js)
// ---------------------------------------------------------------------------

let configPath = null;

function getConfigPaths() {
  return {
    local: path.join(process.cwd(), '.ansinews', 'config.json'),
    home: path.join(os.homedir(), '.ansinews', 'config.json')
  };
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadPrefs() {
  const paths = getConfigPaths();

  try {
    if (fs.existsSync(paths.local)) {
      configPath = paths.local;
      return readJSON(paths.local);
    }
  } catch (error) {
    configPath = paths.local;
    return {};
  }

  try {
    if (fs.existsSync(paths.home)) {
      configPath = paths.home;
      return readJSON(paths.home);
    }
  } catch (error) {
    configPath = paths.home;
    return {};
  }

  configPath = null;
  return {};
}

function savePrefs(data) {
  const targetPath = configPath || getConfigPaths().local;

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
    configPath = targetPath;
  } catch (error) {
    return;
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch (same pattern as news.js)
// ---------------------------------------------------------------------------

function nodeFetch(url) {
  return new Promise(function(resolve, reject) {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'AnsiNews/' + VERSION } }, function(response) {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        nodeFetch(response.headers.location).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }

      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', function(chunk) {
        chunks.push(chunk);
      });
      response.on('end', function() {
        resolve(chunks.join(''));
      });
    });

    request.on('error', reject);
    request.setTimeout(12000, function() {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function fetchXML(url) {
  if (typeof fetch === 'function') {
    return fetch(url, { headers: { 'User-Agent': 'AnsiNews/' + VERSION } }).then(function(response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.text();
    });
  }

  return nodeFetch(url);
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleListFeeds() {
  const prefs = loadPrefs();
  const config = normalizeConfig(prefs);
  return Promise.resolve({
    content: [{ type: 'text', text: JSON.stringify(config.feeds, null, 2) }]
  });
}

function handleAddFeed(args) {
  const name = String(args.name || '').trim();
  const url = String(args.url || '').trim();

  if (!name || !url) {
    return Promise.resolve({
      content: [{ type: 'text', text: 'Error: name and url are required.' }],
      isError: true
    });
  }

  const prefs = loadPrefs();
  const config = normalizeConfig(prefs);
  const before = config.feeds.length;

  const candidate = { name: name, url: url };
  if (args.tag) { candidate.tag = args.tag; }
  if (args.id) { candidate.id = args.id; }

  const next = normalizeConfig({
    active: config.active,
    feeds: config.feeds.concat([candidate])
  });

  if (next.feeds.length <= before) {
    return Promise.resolve({
      content: [{ type: 'text', text: 'Error: feed rejected. Check that the URL starts with http:// or https:// and name is not empty.' }],
      isError: true
    });
  }

  const added = next.feeds[next.feeds.length - 1];
  savePrefs({ active: next.active, feeds: next.feeds });

  return Promise.resolve({
    content: [{ type: 'text', text: 'Added feed: ' + JSON.stringify(added, null, 2) }]
  });
}

function handleRemoveFeed(args) {
  const feedId = String(args.id || '').trim();

  if (!feedId) {
    return Promise.resolve({
      content: [{ type: 'text', text: 'Error: id is required.' }],
      isError: true
    });
  }

  const prefs = loadPrefs();
  const config = normalizeConfig(prefs);
  const found = config.feeds.some(function(f) { return f.id === feedId; });

  if (!found) {
    return Promise.resolve({
      content: [{ type: 'text', text: 'Error: no feed with id "' + feedId + '".' }],
      isError: true
    });
  }

  const remaining = config.feeds.filter(function(f) { return f.id !== feedId; });
  const active = config.active === feedId ? 'all' : config.active;
  savePrefs({ active: active, feeds: remaining });

  return Promise.resolve({
    content: [{ type: 'text', text: 'Removed feed "' + feedId + '". ' + remaining.length + ' feed(s) remaining.' }]
  });
}

function handleReadNews(args) {
  const prefs = loadPrefs();
  const config = normalizeConfig(prefs);
  let feeds = config.feeds;

  if (args.feed) {
    feeds = feeds.filter(function(f) { return f.id === args.feed; });
    if (!feeds.length) {
      return Promise.resolve({
        content: [{ type: 'text', text: 'Error: no feed with id "' + args.feed + '".' }],
        isError: true
      });
    }
  }

  const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));

  return Promise.allSettled(feeds.map(function(feed) {
    return fetchXML(feed.url).then(function(xml) {
      return { feed: feed, items: parseRSS(xml) };
    });
  })).then(function(results) {
    const items = [];
    const errors = [];

    results.forEach(function(result, index) {
      if (result.status === 'fulfilled') {
        result.value.items.forEach(function(item) {
          items.push({
            title: item.title,
            link: item.link,
            desc: item.desc,
            date: item.date,
            feedId: result.value.feed.id,
            feedTag: result.value.feed.tag
          });
        });
      } else {
        const feed = feeds[index];
        errors.push(feed.tag + ': ' + (result.reason && result.reason.message ? result.reason.message : String(result.reason)));
      }
    });

    items.sort(function(a, b) {
      return b.date - a.date;
    });

    let filtered = items;
    if (args.query) {
      const q = String(args.query).toLowerCase();
      filtered = items.filter(function(item) {
        return item.title.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q);
      });
    }

    const sliced = filtered.slice(0, limit).map(function(item) {
      return {
        title: item.title,
        link: item.link,
        desc: item.desc,
        date: item.date instanceof Date && !isNaN(item.date.getTime()) ? item.date.toISOString() : '',
        author: item.author || '',
        feedId: item.feedId,
        feedTag: item.feedTag
      };
    });

    const text = JSON.stringify({ items: sliced, errors: errors }, null, 2);
    return { content: [{ type: 'text', text: text }] };
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_feeds',
    description: 'List all configured RSS feeds.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'add_feed',
    description: 'Add a new RSS feed to the configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable feed name.' },
        url: { type: 'string', description: 'RSS feed URL (http:// or https://).' },
        tag: { type: 'string', description: 'Short label (up to 5 chars). Auto-derived if omitted.' },
        id: { type: 'string', description: 'Unique feed id (lowercase, hyphens). Auto-derived if omitted.' }
      },
      required: ['name', 'url']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'remove_feed',
    description: 'Remove a feed from the configuration by its id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Feed id to remove (use list_feeds to see ids).' }
      },
      required: ['id']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: 'read_news',
    description: 'Fetch and return current news articles from configured RSS feeds. Fetches live data on every call.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: { type: 'string', description: 'Restrict to one feed by its id. Omit for all feeds.' },
        query: { type: 'string', description: 'Case-insensitive search filter on title and description.' },
        limit: { type: 'integer', description: 'Max items to return (1-200, default 50).', minimum: 1, maximum: 200 }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }
];

// ---------------------------------------------------------------------------
// MCP protocol helpers
// ---------------------------------------------------------------------------

function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const byteLen = Buffer.byteLength(json, 'utf8');
  process.stdout.write('Content-Length: ' + byteLen + '\r\n\r\n' + json);
}

function rpcResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id: id, result: result });
}

function rpcError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

// ---------------------------------------------------------------------------
// MCP method dispatch
// ---------------------------------------------------------------------------

function dispatch(msg) {
  const id = msg.id !== undefined ? msg.id : null;
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ansinews', version: VERSION }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    rpcResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    const handlers = {
      list_feeds: handleListFeeds,
      add_feed: handleAddFeed,
      remove_feed: handleRemoveFeed,
      read_news: handleReadNews
    };
    const handler = handlers[toolName];

    if (!handler) {
      rpcError(id, -32601, 'Unknown tool: ' + toolName);
      return;
    }

    handler(toolArgs).then(function(result) {
      rpcResult(id, result);
    }).catch(function(err) {
      rpcResult(id, {
        content: [{ type: 'text', text: 'Internal error: ' + (err && err.message ? err.message : String(err)) }],
        isError: true
      });
    });
    return;
  }

  if (id !== null) {
    rpcError(id, -32601, 'Method not found: ' + method);
  }
}

// ---------------------------------------------------------------------------
// Stdio frame parser (Content-Length framing per MCP spec)
// ---------------------------------------------------------------------------

let inputBuffer = Buffer.alloc(0);

function processBuffer() {
  while (true) {
    const sep = inputBuffer.indexOf('\r\n\r\n');
    if (sep === -1) {
      return;
    }

    const headerText = inputBuffer.slice(0, sep).toString('ascii');
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      inputBuffer = inputBuffer.slice(sep + 4);
      continue;
    }

    const bodyLength = parseInt(lengthMatch[1], 10);
    const bodyStart = sep + 4;

    if (inputBuffer.length < bodyStart + bodyLength) {
      return;
    }

    const body = inputBuffer.slice(bodyStart, bodyStart + bodyLength);
    inputBuffer = inputBuffer.slice(bodyStart + bodyLength);

    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch (e) {
      rpcError(null, -32700, 'Parse error');
      continue;
    }

    dispatch(msg);
  }
}

process.stdin.on('data', function(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

process.stdin.resume();
