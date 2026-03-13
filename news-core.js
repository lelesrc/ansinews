(function(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.AnsiNewsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = '0.2.0';
  const REFRESH_MS = 5 * 60 * 1000;
  const MAX_ITEMS = 50;
  const PREF_KEY = 'ansinews';
  const CORS_PROXY = 'https://corsproxy.io/?';

  const ALL_TAB = { id: 'all', tag: 'ALL' };
  const FEED_STYLES = [
    { ansi: '\x1b[35m', css: '#c084fc' },
    { ansi: '\x1b[36m', css: '#22d3ee' },
    { ansi: '\x1b[34m', css: '#60a5fa' },
    { ansi: '\x1b[33m', css: '#fb923c' },
    { ansi: '\x1b[32m', css: '#4ade80' },
    { ansi: '\x1b[31m', css: '#f87171' }
  ];
  const DEFAULT_FEEDS = [
    { id: 'bbc', tag: 'BBC', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { id: 'grd', tag: 'GUARD', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
    { id: 'nyt', tag: 'NYT', name: 'NY Times', url: 'https://rss.nytimes.com/services/xml/rss/nit/HomePage.xml' },
    { id: 'hn', tag: 'HN', name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { id: 'npr', tag: 'NPR', name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { id: 'rtr', tag: 'RTR', name: 'Reuters', url: 'https://feeds.reuters.com/reuters/topNews' }
  ];

  const tagPatternCache = new Map();

  /**
   * Parse an RSS/Atom XML string into a flat array of feed items.
   * @param {string} xml - Raw XML response body
   * @returns {Array<{title: string, link: string, desc: string, date: Date, author: string}>}
   */
  function parseRSS(xml) {
    function readTag(source, tagName) {
      let pattern = tagPatternCache.get(tagName);

      if (!pattern) {
        pattern = new RegExp('<' + tagName + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tagName + '>', 'i');
        tagPatternCache.set(tagName, pattern);
      }

      const match = source.match(pattern);
      if (!match) {
        return '';
      }

      return match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&#039;/g, '\'')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const items = [];
    const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;

    while ((match = itemPattern.exec(xml)) !== null && items.length < MAX_ITEMS) {
      const block = match[1];
      const title = readTag(block, 'title');

      if (!title) {
        continue;
      }

      const link = readTag(block, 'link') || (block.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || '';
      const desc = (readTag(block, 'description') || readTag(block, 'summary')).substring(0, 500);
      const rawDate = readTag(block, 'pubDate') || readTag(block, 'published') || readTag(block, 'dc:date') || '';
      const date = rawDate ? new Date(rawDate) : new Date();
      const author = readTag(block, 'dc:creator') || readTag(block, 'author') || '';

      items.push({
        title: title.substring(0, 200),
        link: link,
        desc: desc,
        date: date,
        author: author
      });
    }

    return items;
  }

  function stripAnsi(text) {
    return String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  }

  function trunc(text, width) {
    const value = String(text || '');
    if (value.length <= width) {
      return value;
    }
    return value.slice(0, Math.max(0, width - 3)) + '...';
  }

  function pad(text, width) {
    const value = String(text || '');
    return value + ' '.repeat(Math.max(0, width - stripAnsi(value).length));
  }

  function esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function wrap(text, width, maxLines) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let line = '';

    for (const word of words) {
      if (!word) {
        continue;
      }

      if (line && line.length + word.length + 1 > width) {
        lines.push(line);
        line = word;
      } else if (!line && word.length > width) {
        lines.push(word.slice(0, width));
        line = word.slice(width);
      } else {
        line += (line ? ' ' : '') + word;
      }

      if (lines.length >= maxLines) {
        return lines;
      }
    }

    if (line && lines.length < maxLines) {
      lines.push(line);
    }

    return lines;
  }

  function fmtAge(date) {
    const seconds = (Date.now() - (date && typeof date.getTime === 'function' ? date.getTime() : 0)) / 1000;

    if (seconds < 60) {
      return 'now';
    }
    if (seconds < 3600) {
      return Math.floor(seconds / 60) + 'm';
    }
    if (seconds < 86400) {
      return Math.floor(seconds / 3600) + 'h';
    }
    return Math.floor(seconds / 86400) + 'd';
  }

  function fmtClock(date) {
    return date.toTimeString().slice(0, 8);
  }

  function fmtFull(date) {
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
  }

  function trimText(value, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return maxLength ? text.substring(0, maxLength) : text;
  }

  function makeSlug(value) {
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

  function sameFeed(left, right) {
    return !!left && !!right
      && left.id === right.id
      && left.tag === right.tag
      && left.name === right.name
      && left.url === right.url;
  }

  function normalizeCatalogFeed(feed, usedIds) {
    if (!feed || typeof feed !== 'object') {
      return null;
    }

    var name = trimText(feed.name, 80);
    var url = trimText(feed.url, 500);
    var category = trimText(feed.category, 40) || 'Other';
    var tag = trimText(feed.tag, 12).toUpperCase();
    var id = trimText(feed.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');

    if (!name || !url || !/^https?:\/\//i.test(url)) {
      return null;
    }

    if (!tag) {
      tag = trimText(name, 5).toUpperCase();
    }

    tag = tag.replace(/[^A-Z0-9]/g, '').substring(0, 5) || 'FEED';
    id = id.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

    if (!id) {
      id = makeSlug(tag || name);
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
    var list = Array.isArray(feeds) ? feeds : [];
    var usedIds = Object.create(null);
    var normalized = [];

    list.forEach(function(feed) {
      var normalizedFeed = normalizeCatalogFeed(feed, usedIds);
      if (normalizedFeed) {
        normalized.push(normalizedFeed);
      }
    });

    return normalized;
  }

  function getCatalogMap(feeds) {
    var map = Object.create(null);

    (feeds || []).forEach(function(feed) {
      map[feed.id] = feed;
    });

    return map;
  }

  function getDefaultStyle(feedId, index) {
    const matchedIndex = DEFAULT_FEEDS.findIndex(function(feed) {
      return feed.id === feedId;
    });
    const styleIndex = matchedIndex >= 0 ? matchedIndex : index % FEED_STYLES.length;
    return FEED_STYLES[styleIndex];
  }

  function normalizeFeedEntry(feed, index, usedIds) {
    if (!feed || typeof feed !== 'object') {
      return null;
    }

    const name = trimText(feed.name, 80);
    const url = trimText(feed.url, 500);
    let tag = trimText(feed.tag, 12).toUpperCase();
    let id = trimText(feed.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');

    if (!name || !url) {
      return null;
    }

    if (!/^https?:\/\//i.test(url)) {
      return null;
    }

    if (!tag) {
      tag = trimText(name, 5).toUpperCase();
    }

    tag = tag.replace(/[^A-Z0-9]/g, '').substring(0, 5) || 'FEED';
    id = id.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

    if (!id) {
      id = makeSlug(tag || name);
    }

    const baseId = id;
    let suffix = 2;
    while (usedIds[id]) {
      id = baseId + '-' + suffix;
      suffix += 1;
    }
    usedIds[id] = true;

    return {
      id: id,
      tag: tag,
      name: name,
      url: url
    };
  }

  function normalizeFeeds(feeds) {
    const list = Array.isArray(feeds) ? feeds : [];
    const usedIds = Object.create(null);
    const normalized = [];
    let invalidCount = 0;

    for (let index = 0; index < list.length; index += 1) {
      const feed = normalizeFeedEntry(list[index], index, usedIds);
      if (feed) {
        normalized.push(feed);
      } else {
        invalidCount += 1;
      }
    }

    return {
      feeds: normalized,
      invalidCount: invalidCount
    };
  }

  function escXmlAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function exportOPML(feeds) {
    var lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      '<head><title>AnsiNews feeds</title></head>',
      '<body>'
    ];

    (feeds || []).forEach(function(feed) {
      if (!feed || !feed.url) return;
      lines.push('<outline type="rss" text="' + escXmlAttr(feed.name || feed.tag || '')
        + '" title="' + escXmlAttr(feed.name || feed.tag || '')
        + '" xmlUrl="' + escXmlAttr(feed.url) + '" />');
    });

    lines.push('</body>');
    lines.push('</opml>');
    return lines.join('\n');
  }

  function parseOPML(xml) {
    var feeds = [];
    var outlinePattern = /<outline[^>]*xmlUrl\s*=\s*["']([^"']*)["'][^>]*>/gi;
    var match;

    function decodeXmlAttr(value) {
      return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, '\'')
        .replace(/&quot;/g, '"');
    }

    while ((match = outlinePattern.exec(xml)) !== null) {
      var block = match[0];
      var url = decodeXmlAttr(match[1]);

      var textMatch = block.match(/\btitle\s*=\s*["']([^"']*)["']/i) || block.match(/\btext\s*=\s*["']([^"']*)["']/i);
      var name = textMatch ? decodeXmlAttr(textMatch[1]) : '';

      if (url) {
        feeds.push({ name: name, url: url });
      }
    }

    return feeds;
  }

  function getDefaultConfig() {
    return {
      active: 'all',
      feeds: DEFAULT_FEEDS.map(function(feed) {
        return {
          id: feed.id,
          tag: feed.tag,
          name: feed.name,
          url: feed.url
        };
      })
    };
  }

  /**
   * Validate and normalize a raw config object into a safe, usable form.
   * @param {Object} rawConfig - Raw config (may be malformed or missing fields)
   * @returns {{active: string, feeds: Array, notice: string}}
   */
  function normalizeConfig(rawConfig) {
    const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const result = normalizeFeeds(config.feeds);
    const normalizedFeeds = result.feeds.length ? result.feeds : getDefaultConfig().feeds;
    let notice = '';

    if (Array.isArray(config.feeds)) {
      if (!result.feeds.length && config.feeds.length) {
        notice = 'Invalid feeds config. Using defaults.';
      } else if (result.invalidCount) {
        notice = 'Some feeds were ignored.';
      }
    }

    const active = typeof config.active === 'string' ? config.active : 'all';
    const hasActive = active === 'all' || normalizedFeeds.some(function(feed) {
      return feed.id === active;
    });

    return {
      active: hasActive ? active : 'all',
      feeds: normalizedFeeds,
      notice: notice
    };
  }

  function createFeedState(feed, index) {
    const style = getDefaultStyle(feed.id, index);

    return {
      id: feed.id,
      tag: feed.tag,
      name: feed.name,
      url: feed.url,
      ansi: style.ansi,
      css: style.css,
      items: [],
      loading: false,
      error: null
    };
  }

  function buildTabs(feeds) {
    return [ALL_TAB].concat(feeds.map(function(feed) {
      return { id: feed.id, tag: feed.tag, error: !!feed.error };
    }));
  }

  function toPersistedConfig(state) {
    return {
      active: state.active,
      feeds: state.feeds.map(function(feed) {
        return {
          id: feed.id,
          tag: feed.tag,
          name: feed.name,
          url: feed.url
        };
      })
    };
  }

  /**
   * Compute the next cursor position for a navigation key press.
   * @param {number} cursor - Current cursor index
   * @param {string} key - Keyboard event key name (e.g. 'ArrowUp', 'j', 'PageDown')
   * @param {number} maxIdx - Maximum valid cursor index
   * @returns {number|null} New cursor index, or null if the key is not a navigation key
   */
  function moveCursor(cursor, key, maxIdx) {
    switch (key) {
      case 'ArrowUp': case 'k':   return Math.max(0, cursor - 1);
      case 'ArrowDown': case 'j': return Math.min(maxIdx, cursor + 1);
      case 'PageUp':              return Math.max(0, cursor - 15);
      case 'PageDown':            return Math.min(maxIdx, cursor + 15);
      case 'Home': case 'g':      return 0;
      case 'End': case 'G':       return maxIdx;
      default:                    return null;
    }
  }

  /**
   * Create an application instance bound to a platform adapter.
   * @param {Object} platform - Platform adapter with fetchXML(), render(), and optional loadPrefs/savePrefs/openURL/quit
   * @returns {Object} App API with state, getView, handleKey, start, refreshAll, and other control methods
   * @throws {Error} If platform is missing required fetchXML or render methods
   */
  function createApp(platform) {
    if (!platform || typeof platform.fetchXML !== 'function' || typeof platform.render !== 'function') {
      throw new Error('createApp requires a platform with fetchXML() and render()');
    }

    const prefs = readPrefs(platform.loadPrefs);
    const initialConfig = normalizeConfig(prefs);
    const state = {
      feeds: initialConfig.feeds.map(createFeedState),
      active: initialConfig.active,
      cursor: 0,
      scroll: 0,
      filter: '',
      filtering: false,
      detail: false,
      statusMsg: '',
      statusTimer: null,
      nextRefresh: Date.now() + REFRESH_MS
    };
    let pendingNotice = initialConfig.notice;

    function readPrefs(loadPrefs) {
      if (typeof loadPrefs !== 'function') {
        return {};
      }

      try {
        return loadPrefs() || {};
      } catch (error) {
        return {};
      }
    }

    function savePrefs() {
      if (typeof platform.savePrefs !== 'function') {
        return;
      }

      try {
        platform.savePrefs(toPersistedConfig(state));
      } catch (error) {
        return;
      }
    }

    function fmtTimer() {
      const seconds = Math.max(0, Math.round((state.nextRefresh - Date.now()) / 1000));
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
      const rest = String(seconds % 60).padStart(2, '0');
      return minutes + ':' + rest;
    }

    function fmtMeta(item) {
      return (item.author ? 'by ' + item.author + '  ' : '') + fmtFull(item.date);
    }

    function feedStatus() {
      let loading = false;
      let errs = 0;

      for (const feed of state.feeds) {
        if (feed.loading) {
          loading = true;
        }
        if (feed.error) {
          errs += 1;
        }
      }

      return { loading: loading, errs: errs };
    }

    function getHintKeys(includeQuit) {
      if (state.detail) {
        return '[↑↓ jk] nav  [enter/o] open  [esc/q] back';
      }

      return '[↑↓ jk] nav  [←→ hl 0-9] feed  [/] filter  [enter] detail  [o] open  [r] refresh'
        + (includeQuit ? '  [q] quit' : '');
    }

    function getItems() {
      let items;

      if (state.active === 'all') {
        items = state.feeds.flatMap(function(feed) {
          return feed.items.map(function(item) {
            return Object.assign({}, item, {
              feedId: feed.id,
              feedTag: feed.tag,
              ansi: feed.ansi,
              css: feed.css
            });
          });
        });
      } else {
        const feed = state.feeds.find(function(candidate) {
          return candidate.id === state.active;
        });

        items = (feed ? feed.items : []).map(function(item) {
          return Object.assign({}, item, {
            feedId: feed.id,
            feedTag: feed.tag,
            ansi: feed.ansi,
            css: feed.css
          });
        });
      }

      if (state.filter) {
        const query = state.filter.toLowerCase();
        items = items.filter(function(item) {
          return item.title.toLowerCase().includes(query) || item.desc.toLowerCase().includes(query);
        });
      }

      return items.sort(function(left, right) {
        return right.date - left.date;
      });
    }

    function getListHeight() {
      const value = typeof platform.getListHeight === 'function' ? Number(platform.getListHeight(state)) : 35;

      if (!Number.isFinite(value)) {
        return 35;
      }

      return Math.max(1, Math.floor(value));
    }

    function syncScroll(itemCount, listHeight) {
      const maxCursor = Math.max(0, itemCount - 1);
      const maxScroll = Math.max(0, itemCount - listHeight);

      if (state.cursor > maxCursor) {
        state.cursor = maxCursor;
      }

      if (state.cursor < state.scroll) {
        state.scroll = state.cursor;
      }

      if (state.cursor >= state.scroll + listHeight) {
        state.scroll = state.cursor - listHeight + 1;
      }

      if (state.scroll < 0) {
        state.scroll = 0;
      }

      if (state.scroll > maxScroll) {
        state.scroll = maxScroll;
      }
    }

    function getView() {
      const items = getItems();
      const listHeight = getListHeight();
      const includeQuit = platform.mode === 'node';

      syncScroll(items.length, listHeight);

      return {
        version: VERSION,
        listHeight: listHeight,
        tabs: buildTabs(state.feeds),
        loading: feedStatus().loading,
        errs: feedStatus().errs,
        activeError: (function() {
          if (state.active === 'all') return null;
          var f = state.feeds.find(function(c) { return c.id === state.active; });
          return f && f.error ? f.error : null;
        })(),
        timer: fmtTimer(),
        clock: fmtClock(new Date()),
        statusMsg: state.statusMsg,
        hintKeys: getHintKeys(includeQuit),
        items: items,
        visibleItems: items.slice(state.scroll, state.scroll + listHeight),
        selectedItem: items[state.cursor] || null,
        state: {
          active: state.active,
          cursor: state.cursor,
          scroll: state.scroll,
          filter: state.filter,
          filtering: state.filtering,
          detail: state.detail
        },
        meta: {
          esc: esc,
          trunc: trunc,
          pad: pad,
          wrap: wrap,
          fmtAge: fmtAge,
          fmtFull: fmtFull,
          fmtMeta: fmtMeta
        }
      };
    }

    function render() {
      platform.render(getView());
    }

    function setStatus(message, timeoutMs) {
      state.statusMsg = message;
      clearTimeout(state.statusTimer);
      render();

      state.statusTimer = setTimeout(function() {
        state.statusMsg = '';
        render();
      }, typeof timeoutMs === 'number' ? timeoutMs : 3000);
    }

    async function loadFeed(feed) {
      feed.loading = true;
      feed.error = null;
      render();

      try {
        feed.items = parseRSS(await platform.fetchXML(feed.url));
      } catch (error) {
        feed.error = error && error.message ? error.message : String(error);
      }

      feed.loading = false;
      render();
    }

    async function refreshAll() {
      state.nextRefresh = Date.now() + REFRESH_MS;
      render();
      await Promise.all(state.feeds.map(loadFeed));
    }

    function activateFeed(feedId) {
      const tab = buildTabs(state.feeds).find(function(candidate) {
        return candidate.id === feedId;
      });

      if (!tab) {
        return;
      }

      state.active = feedId;
      state.cursor = 0;
      state.scroll = 0;
      state.detail = false;
      savePrefs();
      render();
    }

    function selectIndex(index, options) {
      const items = getItems();

      if (!items.length) {
        state.cursor = 0;
        state.scroll = 0;
        state.detail = false;
        render();
        return;
      }

      const nextIndex = Math.max(0, Math.min(items.length - 1, index));
      const sameIndex = nextIndex === state.cursor;

      state.cursor = nextIndex;

      if (options && options.openDetail && items[nextIndex]) {
        state.detail = true;
      } else if (options && options.toggleDetailOnSame && sameIndex && items[nextIndex]) {
        state.detail = true;
      }

      render();
    }

    function openCurrentItem() {
      const item = getItems()[state.cursor];

      if (!item || !item.link || typeof platform.openURL !== 'function') {
        return;
      }

      platform.openURL(item.link);
      setStatus(platform.mode === 'browser' ? 'Opening link...' : 'Opening in browser...');
    }

    function applyConfig(rawConfig) {
      const nextConfig = normalizeConfig(rawConfig);

      state.feeds = nextConfig.feeds.map(createFeedState);
      state.active = nextConfig.active === 'all' || state.feeds.some(function(feed) {
        return feed.id === nextConfig.active;
      }) ? nextConfig.active : 'all';
      state.cursor = 0;
      state.scroll = 0;
      state.detail = false;
      savePrefs();
      render();

      if (nextConfig.notice) {
        setStatus(nextConfig.notice, 4000);
      }

      return nextConfig;
    }

    function replaceConfig(rawConfig, options) {
      applyConfig(rawConfig);

      if (options && options.refresh) {
        return refreshAll();
      }

      return Promise.resolve();
    }

    function handleKey(key) {
      const items = getItems();
      const itemCount = items.length;
      const maxIndex = Math.max(0, itemCount - 1);

      if (state.filtering) {
        if (key === 'Enter' || key === 'Escape') {
          state.filtering = false;
        } else if (key === 'Backspace') {
          state.filter = state.filter.slice(0, -1);
          state.cursor = 0;
          state.scroll = 0;
        } else if (key && key.length === 1) {
          state.filter += key;
          state.cursor = 0;
          state.scroll = 0;
        }

        render();
        return;
      }

      if (state.detail) {
        if (key === 'Escape' || key === 'q') {
          state.detail = false;
        } else if (key === 'o' || key === 'Enter') {
          openCurrentItem();
        } else if (key === 'ArrowUp' || key === 'k') {
          state.cursor = Math.max(0, state.cursor - 1);
        } else if (key === 'ArrowDown' || key === 'j') {
          state.cursor = Math.min(maxIndex, state.cursor + 1);
        }

        render();
        return;
      }

      switch (key) {
        case 'ArrowUp':
        case 'k':
          state.cursor = Math.max(0, state.cursor - 1);
          break;
        case 'ArrowDown':
        case 'j':
          state.cursor = Math.min(maxIndex, state.cursor + 1);
          break;
        case 'PageUp':
          state.cursor = Math.max(0, state.cursor - 15);
          break;
        case 'PageDown':
          state.cursor = Math.min(maxIndex, state.cursor + 15);
          break;
        case 'Home':
        case 'g':
          state.cursor = 0;
          break;
        case 'End':
        case 'G':
          state.cursor = Math.max(0, itemCount - 1);
          break;
        case 'Enter':
        case ' ':
          if (items[state.cursor]) {
            state.detail = true;
          }
          break;
        case 'o':
          openCurrentItem();
          return;
        case '/':
          state.filtering = true;
          state.filter = '';
          state.cursor = 0;
          state.scroll = 0;
          break;
        case 'Escape':
          state.filter = '';
          state.cursor = 0;
          state.scroll = 0;
          break;
        case 'r':
          setStatus('Refreshing all feeds...');
          refreshAll();
          return;
        case 'q':
          if (platform.mode === 'node' && typeof platform.quit === 'function') {
            platform.quit();
            return;
          }
          break;
        case 'ArrowLeft':
        case 'h':
        case 'ArrowRight':
        case 'l':
        default: {
          const tabs = buildTabs(state.feeds);
          const cur = tabs.findIndex(function(t) { return t.id === state.active; });
          if ((key === 'ArrowLeft' || key === 'h') && cur > 0) {
            activateFeed(tabs[cur - 1].id);
            return;
          }
          if ((key === 'ArrowRight' || key === 'l') && cur < tabs.length - 1) {
            activateFeed(tabs[cur + 1].id);
            return;
          }
          if (key >= '0' && key <= '9') {
            const tab = tabs[parseInt(key, 10)];
            if (tab) {
              activateFeed(tab.id);
              return;
            }
          }
        }
      }

      render();
    }

    function start() {
      render();
      setStatus('Fetching feeds...');
      setInterval(render, 1000);
      refreshAll().then(function() {
        if (pendingNotice) {
          setStatus(pendingNotice, 4000);
          pendingNotice = '';
        }

        setInterval(refreshAll, REFRESH_MS);
      });
    }

    return {
      VERSION: VERSION,
      state: state,
      getConfig: function() {
        return toPersistedConfig(state);
      },
      getView: getView,
      render: render,
      start: start,
      refreshAll: refreshAll,
      replaceConfig: replaceConfig,
      handleKey: handleKey,
      activateFeed: activateFeed,
      selectIndex: selectIndex,
      openCurrentItem: openCurrentItem,
      setStatus: setStatus
    };
  }

  return {
    VERSION: VERSION,
    REFRESH_MS: REFRESH_MS,
    MAX_ITEMS: MAX_ITEMS,
    PREF_KEY: PREF_KEY,
    CORS_PROXY: CORS_PROXY,
    FEEDS: DEFAULT_FEEDS,
    DEFAULT_FEEDS: DEFAULT_FEEDS,
    parseRSS: parseRSS,
    createApp: createApp,
    normalizeConfig: normalizeConfig,
    moveCursor: moveCursor,
    trimText: trimText,
    makeSlug: makeSlug,
    cloneFeed: cloneFeed,
    cloneFeeds: cloneFeeds,
    sameFeed: sameFeed,
    normalizeCatalogFeed: normalizeCatalogFeed,
    normalizeCatalog: normalizeCatalog,
    getCatalogMap: getCatalogMap,
    exportOPML: exportOPML,
    parseOPML: parseOPML,
    normalizeFeeds: normalizeFeeds
  };
});
