#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const https = require('https');

const { createApp, VERSION } = require('./news-core.js');

const DEFAULT_FEEDS_PATH = path.join(__dirname, 'default_feeds.json');

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightWhite: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgYellow: '\x1b[43m',
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
};

let cols = process.stdout.columns || 120;
let rows = process.stdout.rows || 30;
let app;
let configPath = null;

const pickerState = {
  open: false,
  saving: false,
  feeds: [],
  customFeeds: [],
  selectedIds: Object.create(null),
  cursor: 0,
  scroll: 0,
  filter: '',
  filtering: false,
  error: ''
};

function getConfigPaths() {
  return {
    local: path.join(process.cwd(), '.ansinews', 'config.json'),
    home: path.join(os.homedir(), '.ansinews', 'config.json')
  };
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function visibleLength(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

function trimText(value, maxLength) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return maxLength ? text.substring(0, maxLength) : text;
}

function slugify(value) {
  const slug = trimText(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'feed';
}

function cloneFeed(feed) {
  return {
    id: feed.id || '',
    tag: feed.tag || '',
    name: feed.name || '',
    url: feed.url || ''
  };
}

function cloneFeeds(feeds) {
  return (feeds || []).map(cloneFeed);
}

function normalizeCatalogFeed(feed, usedIds) {
  if (!feed || typeof feed !== 'object') {
    return null;
  }

  const name = trimText(feed.name, 80);
  const url = trimText(feed.url, 500);
  const category = trimText(feed.category, 16) || 'OTHER';
  let tag = trimText(feed.tag, 12).toUpperCase();
  let id = trimText(feed.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');

  if (!name || !url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  if (!tag) {
    tag = trimText(name, 5).toUpperCase();
  }

  tag = tag.replace(/[^A-Z0-9]/g, '').substring(0, 5) || 'FEED';
  id = id.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  if (!id) {
    id = slugify(tag || name);
  }

  if (usedIds[id]) {
    return null;
  }

  usedIds[id] = true;

  return {
    id: id,
    tag: tag,
    name: name,
    url: url,
    category: category
  };
}

function normalizeCatalog(feeds) {
  const list = Array.isArray(feeds) ? feeds : [];
  const usedIds = Object.create(null);
  const normalized = [];

  list.forEach(function(feed) {
    const normalizedFeed = normalizeCatalogFeed(feed, usedIds);
    if (normalizedFeed) {
      normalized.push(normalizedFeed);
    }
  });

  return normalized;
}

function getCatalogMap(feeds) {
  const map = Object.create(null);

  (feeds || []).forEach(function(feed) {
    map[feed.id] = feed;
  });

  return map;
}

function sameFeed(left, right) {
  return !!left && !!right
    && left.id === right.id
    && left.tag === right.tag
    && left.name === right.name
    && left.url === right.url;
}

function loadCatalog() {
  try {
    const feeds = normalizeCatalog(readJSON(DEFAULT_FEEDS_PATH));

    if (!feeds.length) {
      return {
        feeds: [],
        error: 'No valid feeds in default_feeds.json.'
      };
    }

    return {
      feeds: feeds,
      error: ''
    };
  } catch (error) {
    return {
      feeds: [],
      error: error && error.message ? error.message : 'Could not load feed catalog.'
    };
  }
}

function seedPickerSelection(selectedFeeds, catalogFeeds) {
  const catalogMap = getCatalogMap(catalogFeeds);
  const selectedIds = Object.create(null);
  const customFeeds = [];

  cloneFeeds(selectedFeeds).forEach(function(feed) {
    selectedIds[feed.id] = true;

    if (!sameFeed(feed, catalogMap[feed.id])) {
      customFeeds.push({
        id: feed.id,
        tag: feed.tag,
        name: feed.name,
        url: feed.url,
        category: 'CURRENT'
      });
    }
  });

  pickerState.selectedIds = selectedIds;
  pickerState.customFeeds = customFeeds;
}

function openPicker() {
  const result = loadCatalog();

  pickerState.open = true;
  pickerState.saving = false;
  pickerState.feeds = result.feeds;
  pickerState.cursor = 0;
  pickerState.scroll = 0;
  pickerState.filter = '';
  pickerState.filtering = false;
  pickerState.error = result.error;

  seedPickerSelection(app.getConfig().feeds, result.feeds);
  app.render();
}

function closePicker() {
  pickerState.open = false;
  pickerState.saving = false;
  pickerState.feeds = [];
  pickerState.customFeeds = [];
  pickerState.selectedIds = Object.create(null);
  pickerState.cursor = 0;
  pickerState.scroll = 0;
  pickerState.filter = '';
  pickerState.filtering = false;
  pickerState.error = '';
  app.render();
}

function buildPickerRows() {
  const rowsList = [];
  const query = trimText(pickerState.filter).toLowerCase();

  function matches(feed) {
    if (!query) {
      return true;
    }

    const haystack = [
      feed.tag,
      feed.name,
      feed.category || '',
      feed.url
    ].join(' ').toLowerCase();

    return haystack.indexOf(query) !== -1;
  }

  pickerState.customFeeds.forEach(function(feed) {
    if (matches(feed)) {
      rowsList.push(feed);
    }
  });

  pickerState.feeds.forEach(function(feed) {
    if (matches(feed)) {
      rowsList.push(feed);
    }
  });

  return rowsList;
}

function getPickerListHeight() {
  const filterHeight = pickerState.filtering ? 2 : 0;
  return Math.max(1, rows - (6 + filterHeight));
}

function syncPickerScroll(itemCount, listHeight) {
  const maxCursor = Math.max(0, itemCount - 1);
  const maxScroll = Math.max(0, itemCount - listHeight);

  if (pickerState.cursor > maxCursor) {
    pickerState.cursor = maxCursor;
  }

  if (pickerState.cursor < pickerState.scroll) {
    pickerState.scroll = pickerState.cursor;
  }

  if (pickerState.cursor >= pickerState.scroll + listHeight) {
    pickerState.scroll = pickerState.cursor - listHeight + 1;
  }

  if (pickerState.scroll < 0) {
    pickerState.scroll = 0;
  }

  if (pickerState.scroll > maxScroll) {
    pickerState.scroll = maxScroll;
  }
}

function getSelectedCount() {
  return Object.keys(pickerState.selectedIds).filter(function(feedId) {
    return pickerState.selectedIds[feedId];
  }).length;
}

function buildSelectedFeeds() {
  const selected = [];
  const seenIds = Object.create(null);

  pickerState.feeds.forEach(function(feed) {
    if (!pickerState.selectedIds[feed.id]) {
      return;
    }

    selected.push(cloneFeed(feed));
    seenIds[feed.id] = true;
  });

  pickerState.customFeeds.forEach(function(feed) {
    if (!pickerState.selectedIds[feed.id] || seenIds[feed.id]) {
      return;
    }

    selected.push(cloneFeed(feed));
    seenIds[feed.id] = true;
  });

  return selected;
}

async function savePickerSelection() {
  const currentConfig = app.getConfig();
  const selectedFeeds = buildSelectedFeeds();

  if (!selectedFeeds.length) {
    app.setStatus('Select at least one feed.');
    return;
  }

  pickerState.saving = true;
  app.render();

  try {
    await app.replaceConfig({
      active: currentConfig.active,
      feeds: selectedFeeds
    }, { refresh: true });

    pickerState.open = false;
    pickerState.saving = false;
    pickerState.feeds = [];
    pickerState.customFeeds = [];
    pickerState.selectedIds = Object.create(null);
    pickerState.cursor = 0;
    pickerState.scroll = 0;
    pickerState.filter = '';
    pickerState.filtering = false;
    pickerState.error = '';
    app.setStatus('Saved feed selection.');
  } catch (error) {
    pickerState.saving = false;
    app.setStatus('Could not save feed selection.');
    app.render();
  }
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

function openURL(url) {
  if (!url) {
    return;
  }

  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start ""'
      : 'xdg-open';

  cp.exec(cmd + ' "' + url.replace(/"/g, '\\"') + '"');
}

function getListHeight(state) {
  const filterHeight = state.filtering ? 2 : 0;
  const detailHeight = state.detail ? 7 : 0;
  const fixedHeight = 2 + filterHeight + 1 + 1 + detailHeight + 2;
  return Math.max(1, rows - fixedHeight);
}

function renderPicker(view, lines) {
  const meta = view.meta;
  const pickerRows = buildPickerRows();
  const listHeight = getPickerListHeight();
  const selectedCount = getSelectedCount();

  syncPickerScroll(pickerRows.length, listHeight);

  lines.push(' ' + A.yellow + 'FEEDS' + A.reset + '  '
    + A.dim + selectedCount + '/' + (pickerRows.length || pickerState.feeds.length + pickerState.customFeeds.length) + ' visible' + A.reset
    + (pickerState.error ? '  ' + A.red + pickerState.error + A.reset : ''));

  if (pickerState.filtering) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    lines.push(' ' + A.yellow + 'FILTER: ' + A.reset + pickerState.filter + A.yellow + '_' + A.reset);
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);
  lines.push(A.dim + ' ' + 'SEL'.padEnd(3) + ' ' + 'TAG'.padEnd(5) + ' ' + 'CAT'.padEnd(10) + ' FEED' + A.reset);

  for (let index = 0; index < listHeight; index += 1) {
    const rowIndex = pickerState.scroll + index;
    const feed = pickerRows[rowIndex];

    if (!feed) {
      lines.push('');
      continue;
    }

    const selected = rowIndex === pickerState.cursor;
    const mark = pickerState.selectedIds[feed.id] ? '[x]' : '[ ]';
    const tag = meta.pad(meta.trunc(feed.tag, 5), 5);
    const category = meta.pad(meta.trunc(feed.category || 'OTHER', 10), 10);
    const title = meta.trunc(feed.name, Math.max(1, cols - 24));
    const row = meta.pad(' ' + mark + ' ' + tag + ' ' + category + ' ' + title, cols);

    if (selected) {
      lines.push(A.bgBlue + A.brightWhite + A.bold + row + A.reset);
    } else {
      lines.push(' ' + A.yellow + mark + A.reset + ' ' + A.cyan + tag + A.reset + ' ' + A.dim + category + A.reset + ' ' + A.white + title + A.reset);
    }
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);

  if (pickerState.saving) {
    lines.push(' ' + A.yellow + 'Saving feed selection...' + A.reset);
  } else {
    lines.push(' ' + A.dim + '[up/down jk] nav  [space] toggle  [/] filter  [enter] save  [esc/q] cancel' + A.reset);
  }
}

function render(view) {
  const lines = [];
  const meta = view.meta;

  const headerLeft = '  > ANSINEWS v' + view.version;
  const headerRight = '  ' + (view.loading ? 'LOAD ' : '') + view.timer + '  ' + view.clock + '  ';
  const headerFill = ' '.repeat(Math.max(0, cols - headerLeft.length - headerRight.length));
  lines.push(A.bgBlue + A.brightWhite + A.bold + headerLeft + headerFill + A.green + headerRight + A.reset);

  if (pickerState.open) {
    renderPicker(view, lines);
    process.stdout.write(A.clear + lines.join('\n'));
    return;
  }

  let tabsLine = ' ';
  view.tabs.forEach(function(tab, index) {
    const label = ' ' + index + ':' + tab.tag + ' ';
    if (view.state.active === tab.id) {
      tabsLine += A.bgYellow + '\x1b[30m' + A.bold + label + A.reset + A.dim + '|' + A.reset;
    } else {
      tabsLine += A.dim + label + '|' + A.reset;
    }
  });
  lines.push(tabsLine + ' '.repeat(Math.max(0, cols - visibleLength(tabsLine))));

  if (view.state.filtering) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    const filterBar = ' ' + A.yellow + 'FILTER: ' + A.reset + view.state.filter + A.yellow + '_' + A.reset;
    lines.push(filterBar + ' '.repeat(Math.max(0, cols - visibleLength(filterBar))));
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);
  lines.push(A.dim + ' ' + 'SRC'.padEnd(5) + ' ' + 'AGE'.padEnd(4) + ' HEADLINE' + A.reset);

  for (let i = 0; i < view.listHeight; i += 1) {
    const item = view.visibleItems[i];

    if (!item) {
      lines.push('');
      continue;
    }

    const absoluteIndex = view.state.scroll + i;
    const selected = absoluteIndex === view.state.cursor;
    const src = meta.pad(meta.trunc(item.feedTag, 5), 5);
    const age = meta.pad(meta.fmtAge(item.date), 4);
    const title = meta.trunc(item.title, Math.max(1, cols - 13));

    if (selected) {
      const row = meta.pad(' ' + src + ' ' + age + ' ' + title, cols);
      lines.push(A.bgBlue + A.brightWhite + A.bold + row + A.reset);
    } else {
      lines.push(' ' + (item.ansi || A.cyan) + src + A.reset + ' ' + A.green + age + A.reset + ' ' + A.white + title + A.reset);
    }
  }

  if (view.state.detail) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    if (view.selectedItem) {
      const detailLines = meta.wrap(view.selectedItem.desc || '(no description)', cols - 2, 2);
      lines.push(' ' + A.brightWhite + A.bold + meta.trunc(view.selectedItem.title, cols - 2) + A.reset);
      lines.push(' ' + A.dim + (detailLines[0] || '') + A.reset);
      lines.push(' ' + A.dim + (detailLines[1] || '') + A.reset);
      lines.push(' ' + A.cyan + A.dim + meta.trunc(view.selectedItem.link, cols - 2) + A.reset);
      lines.push(' ' + A.dim + meta.trunc(meta.fmtMeta(view.selectedItem), cols - 2) + A.reset);
      lines.push(' ' + A.dim + '[enter/o] open in browser   [esc/q] back' + A.reset);
    } else {
      for (let i = 0; i < 6; i += 1) {
        lines.push('');
      }
    }
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);

  let status = '';
  if (view.loading) {
    status += A.yellow + 'LOAD' + A.reset + '  ';
  }
  if (view.errs > 0) {
    status += A.red + 'ERR ' + view.errs + A.reset + '  ';
  }
  if (view.state.filter) {
    status += A.yellow + '/' + view.state.filter + '/' + A.reset + '  ';
  }
  if (view.statusMsg) {
    status += A.yellow + view.statusMsg + A.reset;
  } else {
    status += A.dim + view.hintKeys + '  [f] feeds' + A.reset;
  }

  lines.push(' ' + status);

  process.stdout.write(A.clear + lines.join('\n'));
}

function handlePickerKey(key) {
  const pickerRows = buildPickerRows();
  const itemCount = pickerRows.length;
  const maxIndex = Math.max(0, itemCount - 1);

  if (pickerState.saving) {
    return;
  }

  if (pickerState.filtering) {
    if (key === 'Enter' || key === 'Escape') {
      pickerState.filtering = false;
    } else if (key === 'Backspace') {
      pickerState.filter = pickerState.filter.slice(0, -1);
      pickerState.cursor = 0;
      pickerState.scroll = 0;
    } else if (key && key.length === 1) {
      pickerState.filter += key;
      pickerState.cursor = 0;
      pickerState.scroll = 0;
    }

    app.render();
    return;
  }

  switch (key) {
    case 'ArrowUp':
    case 'k':
      pickerState.cursor = Math.max(0, pickerState.cursor - 1);
      break;
    case 'ArrowDown':
    case 'j':
      pickerState.cursor = Math.min(maxIndex, pickerState.cursor + 1);
      break;
    case 'PageUp':
      pickerState.cursor = Math.max(0, pickerState.cursor - 15);
      break;
    case 'PageDown':
      pickerState.cursor = Math.min(maxIndex, pickerState.cursor + 15);
      break;
    case 'Home':
    case 'g':
      pickerState.cursor = 0;
      break;
    case 'End':
    case 'G':
      pickerState.cursor = maxIndex;
      break;
    case ' ':
      if (pickerRows[pickerState.cursor]) {
        if (pickerState.selectedIds[pickerRows[pickerState.cursor].id]) {
          delete pickerState.selectedIds[pickerRows[pickerState.cursor].id];
        } else {
          pickerState.selectedIds[pickerRows[pickerState.cursor].id] = true;
        }
      }
      break;
    case '/':
      pickerState.filtering = true;
      pickerState.filter = '';
      pickerState.cursor = 0;
      pickerState.scroll = 0;
      break;
    case 'Enter':
      savePickerSelection();
      return;
    case 'Escape':
    case 'q':
      closePicker();
      return;
    default:
      break;
  }

  app.render();
}

function parseNodeKey(raw) {
  const map = {
    '\r': 'Enter',
    '\n': 'Enter',
    '\x7f': 'Backspace',
    '\b': 'Backspace',
    '\x1b': 'Escape',
    '\x03': 'q',
    '\x1b[A': 'ArrowUp',
    '\x1b[B': 'ArrowDown',
    '\x1b[C': 'ArrowRight',
    '\x1b[D': 'ArrowLeft',
    '\x1b[5~': 'PageUp',
    '\x1b[6~': 'PageDown',
    '\x1b[H': 'Home',
    '\x1b[F': 'End',
    '\x1bOH': 'Home',
    '\x1bOF': 'End'
  };

  return map[raw] || (raw.length === 1 ? raw : null);
}

function cleanup() {
  process.stdout.write(A.showCursor + A.reset + '\x1b[2J\x1b[H');
  try {
    process.stdin.setRawMode(false);
  } catch (error) {
    return process.stdin.pause();
  }
  process.stdin.pause();
}

app = createApp({
  mode: 'node',
  loadPrefs: loadPrefs,
  savePrefs: savePrefs,
  fetchXML: fetchXML,
  openURL: openURL,
  getListHeight: getListHeight,
  render: render,
  quit: function() {
    cleanup();
    process.exit(0);
  }
});

process.stdout.write(A.hideCursor + A.clear);

process.stdout.on('resize', function() {
  cols = process.stdout.columns || cols;
  rows = process.stdout.rows || rows;
  app.render();
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', function(raw) {
  const key = parseNodeKey(raw);

  if (!key) {
    return;
  }

  if (pickerState.open) {
    handlePickerKey(key);
    return;
  }

  if (key === 'f') {
    openPicker();
    return;
  }

  app.handleKey(key);
});

process.on('SIGINT', function() {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', function() {
  cleanup();
  process.exit(0);
});

app.start();
