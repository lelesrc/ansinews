#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const https = require('https');

const { createApp, VERSION, setDefaultFeeds, moveCursor, trimText, makeSlug, cloneFeed, cloneFeeds, sameFeed, normalizeCatalogFeed, normalizeCatalog, getCatalogMap, exportOPML, parseOPML, normalizeConfig, normalizeFeeds } = require('./ansinews-core.js');

const DEFAULT_FEEDS_PATH = path.join(__dirname, 'default_feeds.json');

// Control sequences (constant, not theme-dependent)
var ctrl = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  clear: '\x1b[2J\x1b[H',
  home: '\x1b[H',
  clearLine: '\x1b[K',
  clearDown: '\x1b[J',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  altScreenEnter: '\x1b[?1049h',
  altScreenExit: '\x1b[?1049l'
};

var darkPalette = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightWhite: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgYellow: '\x1b[43m',
  bgBar: '\x1b[100m',      // status/tab bar background
  rBg: '\x1b[0m\x1b[100m', // reset then bar bg
  text: '\x1b[37m',        // primary text
  barFg: '\x1b[2m',        // dim text on bar
  tabActiveFg: '\x1b[30m'  // black text on active tab
};

var lightPalette = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[30m',          // black fg for "normal text" in light mode
  brightWhite: '\x1b[30m',    // black fg for "bright text" in light mode
  bgBlue: '\x1b[44m',
  bgYellow: '\x1b[43m',
  bgBar: '\x1b[47m',          // white bg for bar
  rBg: '\x1b[0m\x1b[47m',    // reset then white bg
  text: '\x1b[30m',           // black text
  barFg: '\x1b[2m',           // dim
  tabActiveFg: '\x1b[30m'     // black on active tab
};

// A is the active theme - merge ctrl + palette
var A = Object.assign({}, ctrl, darkPalette);
var currentTheme = 'dark';

function setTheme(theme) {
  currentTheme = theme;
  var palette = theme === 'light' ? lightPalette : darkPalette;
  Object.keys(palette).forEach(function(key) {
    A[key] = palette[key];
  });
}

function parseOSC11(raw) {
  var m = raw.match(/\x1b\]11;rgb:([0-9a-fA-F]{2}(?:[0-9a-fA-F]{2})?)\/([0-9a-fA-F]{2}(?:[0-9a-fA-F]{2})?)\/([0-9a-fA-F]{2}(?:[0-9a-fA-F]{2})?)/);
  if (!m) return null;
  // Normalize to 0-1 regardless of 2 or 4 hex digit channel width
  var r = parseInt(m[1], 16) / (m[1].length <= 2 ? 0xFF : 0xFFFF);
  var g = parseInt(m[2], 16) / (m[2].length <= 2 ? 0xFF : 0xFFFF);
  var b = parseInt(m[3], 16) / (m[3].length <= 2 ? 0xFF : 0xFFFF);
  // sRGB linearization
  function lin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  var luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance >= 0.5 ? 'light' : 'dark';
}

function detectFromColorFgBg() {
  var v = process.env.COLORFGBG || '';
  var parts = v.split(';');
  var bg = parseInt(parts[parts.length - 1], 10);
  if (bg === 7 || bg === 15) return 'light';
  if (!isNaN(bg)) return 'dark';
  return null;
}

function detectTheme() {
  return new Promise(function(resolve) {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return resolve(detectFromColorFgBg() || 'dark');
    }

    var settled = false;
    var buf = '';

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      try { process.stdin.setRawMode(false); } catch (e) {}
      process.stdin.pause();

      var detected = parseOSC11(buf);
      resolve(detected !== null ? detected : (detectFromColorFgBg() || 'dark'));
    }

    function onData(chunk) {
      buf += chunk;
      if (buf.indexOf('\x07') !== -1 || buf.indexOf('\x1b\\') !== -1) {
        finish();
      }
    }

    var timer = setTimeout(finish, 150);

    try { process.stdin.setRawMode(true); } catch (e) { return resolve(detectFromColorFgBg() || 'dark'); }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdout.write('\x1b]11;?\x07');
  });
}

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
  addingUrl: false,
  urlInput: '',
  urlInputStep: 'url',
  tagInput: '',
  catInput: '',
  status: '',
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
  var s = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  var len = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    // ⏎ (U+23CE) renders as 2 columns in most terminals
    len += (c === 0x23CE) ? 2 : 1;
  }
  return len;
}

function bgPad(s, width) {
  return A.bgBar + s + ' '.repeat(Math.max(0, width - visibleLength(s))) + A.reset;
}

function renderUrlField(label, value, placeholder, isActive) {
  if (isActive) {
    return ' ' + A.yellow + label + A.reset + value + A.yellow + '_' + A.reset;
  }
  return ' ' + A.dim + label + A.reset + A.dim + (value || placeholder) + A.reset;
}

function tabSegment(label, tab, activeId) {
  if (activeId === tab.id) {
    return A.bgYellow + A.tabActiveFg + A.bold + label + A.rBg + A.dim + '|' + A.rBg;
  }
  if (tab.error) {
    return A.bold + A.red + label + '|' + A.rBg;
  }
  return A.dim + label + '|' + A.rBg;
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

function resetUrlInputState() {
  pickerState.addingUrl = false;
  pickerState.urlInput = '';
  pickerState.urlInputStep = 'url';
  pickerState.tagInput = '';
  pickerState.catInput = '';
  pickerState.status = '';
  pickerState.error = '';
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
  resetUrlInputState();
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
  resetUrlInputState();
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
  const addingUrlHeight = pickerState.addingUrl ? 4 : 0;
  return Math.max(1, rows - (6 + filterHeight + addingUrlHeight));
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

function flushLines(lines) {
  return A.home + lines.map(function(l) { return l + A.clearLine; }).join('\n') + A.clearDown;
}

function getStatusBarLines(state) {
  if (cols <= 1) return 1;
  var hints = state.detail
    ? '[↑↓ jk] nav  [⏎/o] open  [esc/q] back'
    : '[↑↓ jk] nav  [←→ hl] feed  [/] filter  [⏎] detail  [o] open  [r] refresh  [q] quit  [f] feeds  [t] theme';
  var len = visibleLength(hints) + 1;
  return Math.max(1, Math.ceil(len / cols));
}

function getListHeight(state) {
  const filterHeight = state.filtering ? 2 : 0;
  const detailHeight = state.detail ? 7 : 0;
  const statusLines = getStatusBarLines(state);
  const fixedHeight = 2 + filterHeight + 1 + 1 + detailHeight + 1 + statusLines;
  return Math.max(1, rows - fixedHeight);
}

function renderPicker(view, lines) {
  const meta = view.meta;
  const pickerRows = buildPickerRows();
  const listHeight = getPickerListHeight();
  const selectedCount = getSelectedCount();
  const errorIds = Object.create(null);
  view.tabs.forEach(function(tab) { if (tab.error) errorIds[tab.id] = true; });

  syncPickerScroll(pickerRows.length, listHeight);

  lines.push(' ' + A.yellow + 'FEEDS' + A.reset + '  '
    + A.dim + selectedCount + '/' + (pickerRows.length || pickerState.feeds.length + pickerState.customFeeds.length) + ' visible' + A.reset
    + (pickerState.status ? '  ' + A.cyan + pickerState.status + A.reset : pickerState.error ? '  ' + A.red + pickerState.error + A.reset : ''));

  if (pickerState.filtering) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    lines.push(' ' + A.yellow + 'FILTER: ' + A.reset + pickerState.filter + A.yellow + '_' + A.reset);
  }

  if (pickerState.addingUrl) {
    var step = pickerState.urlInputStep;
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    lines.push(renderUrlField('URL: ', pickerState.urlInput, '', step === 'url'));
    lines.push(renderUrlField('TAG: ', pickerState.tagInput, '(auto)', step === 'tag'));
    lines.push(renderUrlField('CAT: ', pickerState.catInput, '(optional)', step === 'cat'));
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
      const tagColor = errorIds[feed.id] ? A.red : A.cyan;
      lines.push(' ' + A.yellow + mark + A.reset + ' ' + tagColor + tag + A.reset + ' ' + A.dim + category + A.reset + ' ' + A.white + title + A.reset);
    }
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);

  if (pickerState.saving) {
    lines.push(bgPad(' ' + A.yellow + 'Saving feed selection...' + A.rBg, cols));
  } else if (pickerState.addingUrl) {
    var stepHint = pickerState.urlInputStep === 'url' ? '[url]  [⏎] next step  [esc] cancel'
      : pickerState.urlInputStep === 'tag' ? '[tag, optional]  [⏎] next step  [esc] cancel'
      : '[category, optional]  [⏎] add feed  [esc] cancel';
    lines.push(bgPad(' ' + A.dim + stepHint + A.reset + A.dim + '  [backspace] delete' + A.rBg, cols));
  } else {
    lines.push(bgPad(' ' + A.dim + '[↑↓ jk] nav  [space] toggle  [/] filter  [a] add url  [⏎] save  [esc/q] cancel' + A.rBg, cols));
  }
}

function buildTabsLine(tabs, activeId, width) {
  var labels = [];
  var widths = [];

  tabs.forEach(function(tab, index) {
    var label = ' ' + index + ':' + tab.tag + ' ';
    labels.push(label);
    widths.push(label.length + 1);
  });

  var totalWidth = 1;
  for (var i = 0; i < widths.length; i++) {
    totalWidth += widths[i];
  }

  if (totalWidth <= width) {
    var line = A.bgBar + ' ';
    tabs.forEach(function(tab, index) {
      line += tabSegment(labels[index], tab, activeId);
    });
    return line + ' '.repeat(Math.max(0, width - visibleLength(line))) + A.reset;
  }

  var activeIndex = 0;
  for (var a = 0; a < tabs.length; a++) {
    if (tabs[a].id === activeId) {
      activeIndex = a;
      break;
    }
  }

  // Conservatively reserve space for both indicators.
  // If one isn't needed, padding fills the slack.
  var available = width - 1 - 2 - 2;

  var startIndex = 0;
  var endIndex = 0;
  var usedWidth = 0;

  for (var p = 0; p < tabs.length; p++) {
    if (usedWidth + widths[p] <= available) {
      usedWidth += widths[p];
      endIndex = p + 1;
    } else {
      break;
    }
  }

  if (activeIndex >= endIndex) {
    startIndex = activeIndex;
    endIndex = activeIndex + 1;
    usedWidth = widths[activeIndex];

    for (var b = activeIndex - 1; b >= 0; b--) {
      if (usedWidth + widths[b] <= available) {
        usedWidth += widths[b];
        startIndex = b;
      } else {
        break;
      }
    }

    for (var f = endIndex; f < tabs.length; f++) {
      if (usedWidth + widths[f] <= available) {
        usedWidth += widths[f];
        endIndex = f + 1;
      } else {
        break;
      }
    }
  }

  var hiddenLeft = startIndex > 0;
  var hiddenRight = endIndex < tabs.length;

  var result = A.bgBar + ' ';
  if (hiddenLeft) {
    result += A.dim + '< ' + A.rBg;
  }

  for (var v = startIndex; v < endIndex; v++) {
    result += tabSegment(labels[v], tabs[v], activeId);
  }

  if (hiddenRight) {
    result += A.dim + ' >' + A.rBg;
  }

  return result + ' '.repeat(Math.max(0, width - visibleLength(result))) + A.reset;
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
    process.stdout.write(flushLines(lines));
    return;
  }

  lines.push(buildTabsLine(view.tabs, view.state.active, cols));

  if (view.state.filtering) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    const filterBar = ' ' + A.yellow + 'FILTER: ' + A.reset + view.state.filter + A.yellow + '_' + A.reset;
    lines.push(filterBar + ' '.repeat(Math.max(0, cols - visibleLength(filterBar))));
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);

  if (view.activeError) {
    lines.push('');
    lines.push('  ' + A.red + 'Failed to load feed: ' + meta.trunc(view.activeError, cols - 24) + A.reset);
    lines.push('  ' + A.dim + 'Press [r] to refresh' + A.reset);
    for (let i = 0; i < view.listHeight - 2; i += 1) {
      lines.push('');
    }
  } else {
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
  }

  if (view.state.detail) {
    lines.push(A.dim + '-'.repeat(cols) + A.reset);
    if (view.selectedItem) {
      const detailLines = meta.wrap(view.selectedItem.desc || '(no description)', cols - 2, 2);
      const bp = function(s) { return bgPad(s, cols); };
      lines.push(bp(' ' + A.brightWhite + A.bold + meta.trunc(view.selectedItem.title, cols - 2) + A.rBg));
      lines.push(bp(' ' + (detailLines[0] || '')));
      lines.push(bp(' ' + (detailLines[1] || '')));
      lines.push(bp(' ' + A.cyan + meta.trunc(view.selectedItem.link, cols - 2) + A.rBg));
      lines.push(bp(' ' + meta.trunc(meta.fmtMeta(view.selectedItem), cols - 2)));
      lines.push(bp(' [enter/o] open in browser   [esc/q] back'));
    } else {
      for (let i = 0; i < 6; i += 1) {
        lines.push('');
      }
    }
  }

  lines.push(A.dim + '-'.repeat(cols) + A.reset);

  let statusParts = [];
  if (view.loading) {
    statusParts.push(A.yellow + 'LOAD' + A.rBg);
  }
  if (view.errs > 0) {
    statusParts.push(A.red + 'ERR\u00a0' + view.errs + A.rBg);
  }
  if (view.state.filter) {
    statusParts.push(A.yellow + '/' + view.state.filter + '/' + A.rBg);
  }
  if (view.statusMsg) {
    statusParts.push(A.yellow + view.statusMsg + A.rBg);
  } else {
    var allHints = view.hintKeys + '  [f] feeds  [t] theme';
    allHints.split(/  /).forEach(function(h) {
      if (h) statusParts.push(A.dim + h.replace(/ /g, '\u00a0') + A.rBg);
    });
  }

  // Wrap hint tokens into lines, keeping each [key] label pair atomic
  var barLines = [];
  var curLine = ' ';
  var curLen = 1;
  for (var si = 0; si < statusParts.length; si++) {
    var partLen = visibleLength(statusParts[si]);
    var sepLen = curLen > 1 ? 2 : 0;
    if (curLen > 1 && curLen + sepLen + partLen > cols) {
      barLines.push(bgPad(curLine, cols));
      curLine = ' ' + statusParts[si];
      curLen = 1 + partLen;
    } else {
      curLine += (curLen > 1 ? '  ' : '') + statusParts[si];
      curLen += sepLen + partLen;
    }
  }
  barLines.push(bgPad(curLine, cols));
  barLines.forEach(function(bl) { lines.push(bl); });

  process.stdout.write(flushLines(lines));
}

function handlePickerKey(key) {
  const pickerRows = buildPickerRows();
  const itemCount = pickerRows.length;
  const maxIndex = Math.max(0, itemCount - 1);

  if (pickerState.saving) {
    return;
  }

  if (pickerState.addingUrl) {
    if (key === 'Escape') {
      resetUrlInputState();
    } else if (key === 'Backspace') {
      if (pickerState.urlInputStep === 'url') {
        pickerState.urlInput = pickerState.urlInput.slice(0, -1);
      } else if (pickerState.urlInputStep === 'tag') {
        pickerState.tagInput = pickerState.tagInput.slice(0, -1);
      } else {
        pickerState.catInput = pickerState.catInput.slice(0, -1);
      }
    } else if (key === 'Enter') {
      if (pickerState.urlInputStep === 'url') {
        var url = trimText(pickerState.urlInput);
        if (!/^https?:\/\//i.test(url)) {
          pickerState.error = 'Invalid URL';
        } else {
          pickerState.urlInputStep = 'tag';
          pickerState.error = '';
        }
      } else if (pickerState.urlInputStep === 'tag') {
        pickerState.urlInputStep = 'cat';
        pickerState.error = '';
      } else {
        var feedUrl = trimText(pickerState.urlInput);
        var feedTag = trimText(pickerState.tagInput);
        var feedCat = trimText(pickerState.catInput) || 'CUSTOM';
        var feedObj = { url: feedUrl, name: feedUrl };
        if (feedTag) { feedObj.tag = feedTag; }
        var result = normalizeFeeds([feedObj]);
        if (!result.feeds.length) {
          pickerState.urlInputStep = 'url';
          pickerState.error = 'Invalid URL';
        } else {
          var newFeed = result.feeds[0];
          var isDuplicate = pickerState.customFeeds.some(function(f) { return f.url === newFeed.url; })
            || Object.keys(pickerState.selectedIds).some(function(id) {
                 var row = pickerRows.find(function(r) { return r.id === id; });
                 return row && row.url === newFeed.url;
               });
          if (isDuplicate) {
            pickerState.error = 'Already in list';
          } else {
            newFeed.category = feedCat;
            pickerState.customFeeds.push(newFeed);
            pickerState.selectedIds[newFeed.id] = true;
            resetUrlInputState();
            pickerState.status = 'Feed added — press Enter to save';
          }
        }
      }
    } else if (key && key.length === 1) {
      if (pickerState.urlInputStep === 'url') {
        pickerState.urlInput += key;
      } else if (pickerState.urlInputStep === 'tag') {
        pickerState.tagInput += key;
      } else {
        pickerState.catInput += key;
      }
      pickerState.error = '';
      pickerState.status = '';
    }

    app.render();
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

  var moved = moveCursor(pickerState.cursor, key, maxIndex);
  if (moved !== null) {
    pickerState.cursor = moved;
    app.render();
    return;
  }

  switch (key) {
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
    case 'a':
      resetUrlInputState();
      pickerState.addingUrl = true;
      pickerState.filtering = false;
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
  process.stdout.write(ctrl.altScreenExit + ctrl.showCursor + ctrl.reset);
  try {
    process.stdin.setRawMode(false);
  } catch (error) {
    return process.stdin.pause();
  }
  process.stdin.pause();
}

function startBrowserServer(args) {
  var portIndex = args.indexOf('--port');
  var port = 9001;
  if (portIndex !== -1 && args[portIndex + 1]) {
    var parsed = parseInt(args[portIndex + 1], 10);
    if (parsed > 0 && parsed < 65536) port = parsed;
  }

  var mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };

  var server = http.createServer(function(req, res) {
    var parsed = new URL(req.url, 'http://localhost');

    // CORS proxy endpoint
    if (parsed.pathname === '/proxy') {
      var feedUrl = parsed.searchParams.get('url');
      if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Missing or invalid url parameter');
        return;
      }
      var client = feedUrl.startsWith('https') ? https : http;
      var proxyReq = client.get(feedUrl, { headers: { 'User-Agent': 'AnsiNews/' + VERSION } }, function(proxyRes) {
        if ([301, 302, 303, 307, 308].indexOf(proxyRes.statusCode) !== -1 && proxyRes.headers.location) {
          // Follow one redirect
          var loc = proxyRes.headers.location;
          var client2 = loc.startsWith('https') ? https : http;
          client2.get(loc, { headers: { 'User-Agent': 'AnsiNews/' + VERSION } }, function(proxyRes2) {
            res.writeHead(proxyRes2.statusCode, {
              'Content-Type': proxyRes2.headers['content-type'] || 'text/xml',
              'Access-Control-Allow-Origin': '*'
            });
            proxyRes2.pipe(res);
          }).on('error', function(err) {
            res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('Proxy error: ' + err.message);
          });
          return;
        }
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'text/xml',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', function(err) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('Proxy error: ' + err.message);
        }
      });
      proxyReq.setTimeout(12000, function() {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('Proxy timeout');
        }
      });
      return;
    }

    // Static file serving
    var filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    var fullPath = path.join(__dirname, filePath);
    // Prevent path traversal
    if (fullPath.indexOf(__dirname) !== 0) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    var ext = path.extname(fullPath);
    var contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(fullPath, function(err, data) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  server.listen(port, function() {
    var url = 'http://localhost:' + port;
    console.log('');
    console.log('  ansinews browser UI running at:');
    console.log('');
    console.log('    ' + url);
    console.log('');
    console.log('  Press Ctrl+C to stop the server.');
    console.log('');
    openURL(url);
  });

  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use. Try --port <number>.');
    } else {
      console.error('Server error: ' + err.message);
    }
    process.exit(1);
  });
}

function handleCLI() {
  var args = process.argv.slice(2);
  var exportIndex = args.indexOf('--export');
  var importIndex = args.indexOf('--import');
  var addFeedIndex = args.indexOf('--add-feed');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ansinews [options]');
    console.log('');
    console.log('Options:');
    console.log('  --browser                Start a local server and open the browser UI');
    console.log('  --port <number>          Port for --browser (default: 9001)');
    console.log('  --add-feed <url>         Append a feed by RSS/Atom URL');
    console.log('  --name <label>           Label for --add-feed (optional)');
    console.log('  --import <path>          Replace feed list from an OPML or JSON file');
    console.log('  --export <path>          Export feed list (.opml or .json)');
    console.log('  --help, -h               Show this help');
    console.log('');
    console.log('Without options, starts the interactive terminal reader.');
    process.exit(0);
  }

  if (args.includes('--browser')) {
    startBrowserServer(args);
    return true;
  }

  if (exportIndex !== -1) {
    var exportPath = args[exportIndex + 1];
    if (!exportPath || exportPath.startsWith('--')) {
      console.error('Error: --export requires a file path.');
      process.exit(1);
    }
    var config = normalizeConfig(loadPrefs());
    var isJSON = /\.json$/i.test(exportPath);
    var content = isJSON
      ? JSON.stringify({ active: config.active, feeds: config.feeds }, null, 2)
      : exportOPML(config.feeds);
    try {
      fs.writeFileSync(exportPath, content, 'utf8');
    } catch (err) {
      console.error('Error writing file: ' + (err.message || err));
      process.exit(1);
    }
    console.log('Exported ' + config.feeds.length + ' feeds to ' + exportPath);
    process.exit(0);
  }

  if (addFeedIndex !== -1) {
    var feedUrl = args[addFeedIndex + 1];
    if (!feedUrl || feedUrl.startsWith('--')) {
      console.error('Error: --add-feed requires a URL.');
      process.exit(1);
    }
    var nameIndex = args.indexOf('--name');
    var feedName = nameIndex !== -1 && args[nameIndex + 1] && !args[nameIndex + 1].startsWith('--')
      ? args[nameIndex + 1]
      : '';
    var currentConfig = normalizeConfig(loadPrefs());
    var duplicate = currentConfig.feeds.some(function(f) { return f.url === feedUrl; });
    if (duplicate) {
      console.log('Feed already in list: ' + feedUrl);
      process.exit(0);
    }
    var result = normalizeFeeds([{ url: feedUrl, name: feedName }]);
    if (!result.feeds.length) {
      console.error('Invalid feed URL: ' + feedUrl);
      process.exit(1);
    }
    var newFeeds = currentConfig.feeds.concat(result.feeds);
    savePrefs({ active: currentConfig.active, feeds: newFeeds });
    console.log('Added: ' + feedUrl + ' (' + newFeeds.length + ' feeds total)');
    process.exit(0);
  }

  if (importIndex !== -1) {
    var importPath = args[importIndex + 1];
    if (!importPath || importPath.startsWith('--')) {
      console.error('Error: --import requires a file path.');
      process.exit(1);
    }
    var raw;
    try {
      raw = fs.readFileSync(importPath, 'utf8');
    } catch (err) {
      console.error('Error reading file: ' + (err.message || err));
      process.exit(1);
    }
    var feeds;
    var formatName;
    try {
      var parsed = JSON.parse(raw);
      feeds = Array.isArray(parsed.feeds) ? parsed.feeds : Array.isArray(parsed) ? parsed : [];
      formatName = 'JSON';
    } catch (e) {
      feeds = parseOPML(raw);
      formatName = 'OPML';
    }
    if (!feeds.length) {
      console.error('No valid feeds found in ' + importPath);
      process.exit(1);
    }
    var result = normalizeFeeds(feeds);
    if (!result.feeds.length) {
      console.error('All feeds in ' + importPath + ' were invalid.');
      process.exit(1);
    }
    var currentConfig = normalizeConfig(loadPrefs());
    var newConfig = { active: currentConfig.active, feeds: result.feeds };
    savePrefs(newConfig);
    var msg = 'Imported ' + result.feeds.length + ' feeds from ' + importPath + ' (' + formatName + ')';
    if (result.invalidCount) {
      msg += ', ' + result.invalidCount + ' skipped';
    }
    console.log(msg);
    process.exit(0);
  }
}

if (handleCLI()) {
  // CLI command handled, don't start the interactive terminal
} else {

detectTheme().then(function(theme) {
  setTheme(theme);

  setDefaultFeeds(loadCatalog().feeds);

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

  process.stdout.write(ctrl.altScreenEnter + ctrl.hideCursor + ctrl.clear);

  process.stdout.on('resize', function() {
    cols = process.stdout.columns || cols;
    rows = process.stdout.rows || rows;
    app.render();
  });

  // Discard any stale bytes (e.g. late OSC 11 response) before
  // registering the real input handler.
  var draining = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function(raw) {
    if (draining) return;

    const key = parseNodeKey(raw);

    if (pickerState.open && pickerState.addingUrl && !key && raw.length > 1 && !raw.startsWith('\x1b')) {
      var pasted = raw.replace(/[\r\n\x00-\x1f\x7f]/g, '');
      if (pickerState.urlInputStep === 'url') { pickerState.urlInput += pasted; }
      else if (pickerState.urlInputStep === 'tag') { pickerState.tagInput += pasted; }
      else { pickerState.catInput += pasted; }
      pickerState.error = '';
      app.render();
      return;
    }

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

    if (key === 't') {
      setTheme(currentTheme === 'dark' ? 'light' : 'dark');
      app.setStatus('Theme: ' + currentTheme);
      return;
    }

    app.handleKey(key);
  });
  setImmediate(function() { draining = false; });

  process.on('SIGINT', function() {
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', function() {
    cleanup();
    process.exit(0);
  });

  app.start();
});

} // end if (!handleCLI())
