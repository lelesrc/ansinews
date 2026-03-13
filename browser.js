(function() {
  'use strict';

  const core = globalThis.AnsiNewsCore;
  const CATALOG_PATH = 'default_feeds.json';

  if (!core) {
    throw new Error('news-core.js must be loaded before browser.js');
  }

  const memoryStore = {};
  const hasLocalStorage = storageAvailable('localStorage');
  const editorState = {
    open: false,
    saving: false,
    search: '',
    selectedIds: Object.create(null),
    removedIds: Object.create(null),
    customFeeds: [],
    catalog: [],
    catalogStatus: 'idle',
    catalogError: '',
    dirty: false,
    cursorMoved: false,
    cursor: 0,
    addUrl: '',
    addName: ''
  };
  let catalogRequest = null;

  const rootEl = function() {
    return document.getElementById('terminal');
  };

  const platform = {
    mode: 'browser',
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    fetchXML: fetchXML,
    openURL: openURL,
    getListHeight: function() {
      return 35;
    },
    render: render
  };

  const app = core.createApp(platform);

  function storageAvailable(type) {
    try {
      const storage = window[type];
      const key = '__ansinews_test__';
      storage.setItem(key, key);
      storage.removeItem(key);
      return true;
    } catch (error) {
      return false;
    }
  }

  const trimText = core.trimText;
  const makeSlug = core.makeSlug;

  const cloneFeed = core.cloneFeed;
  const cloneFeeds = core.cloneFeeds;
  const sameFeed = core.sameFeed;
  const normalizeCatalog = core.normalizeCatalog;
  const getCatalogMap = core.getCatalogMap;

  function readStoredValue() {
    if (hasLocalStorage) {
      return localStorage.getItem(core.PREF_KEY);
    }

    return memoryStore[core.PREF_KEY] || null;
  }

  function writeStoredValue(value) {
    if (hasLocalStorage) {
      localStorage.setItem(core.PREF_KEY, value);
      return;
    }

    memoryStore[core.PREF_KEY] = value;
  }

  function loadPrefs() {
    try {
      return JSON.parse(readStoredValue() || '{}');
    } catch (error) {
      return {};
    }
  }

  function savePrefs(data) {
    try {
      writeStoredValue(JSON.stringify(data));
    } catch (error) {
      return;
    }
  }

  function fetchXML(url) {
    return fetch(core.CORS_PROXY + encodeURIComponent(url)).then(function(response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.text();
    });
  }

  function openURL(url) {
    if (!url) {
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function reconcileCustomFeeds() {
    const catalogMap = getCatalogMap(editorState.catalog);

    editorState.customFeeds = editorState.customFeeds.filter(function(feed) {
      return !sameFeed(feed, catalogMap[feed.id]);
    });
  }

  function seedDraftSelection(feeds) {
    const catalogMap = getCatalogMap(editorState.catalog);
    const selectedIds = Object.create(null);
    const customFeeds = [];

    cloneFeeds(feeds).forEach(function(feed) {
      selectedIds[feed.id] = true;

      if (!sameFeed(feed, catalogMap[feed.id])) {
        customFeeds.push(feed);
      }
    });

    editorState.selectedIds = selectedIds;
    editorState.customFeeds = customFeeds;
  }

  function ensureCatalogLoaded() {
    if (editorState.catalogStatus === 'loaded') {
      return Promise.resolve(editorState.catalog);
    }

    if (editorState.catalogStatus === 'pending' && catalogRequest) {
      return catalogRequest;
    }

    editorState.catalogStatus = 'pending';
    editorState.catalogError = '';
    editorState.dirty = true;
    app.render();

    catalogRequest = fetch(CATALOG_PATH, { cache: 'no-store' }).then(function(response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.json();
    }).then(function(data) {
      core.setDefaultFeeds(data);
      editorState.catalog = normalizeCatalog(data);

      if (!editorState.catalog.length) {
        throw new Error('No valid feeds in default_feeds.json.');
      }

      if (!app.getConfig().feeds.length) {
        app.replaceConfig({ active: 'all', feeds: core.getDefaultConfig().feeds }, { refresh: true });
      }

      editorState.catalogStatus = 'loaded';
      editorState.catalogError = '';
      reconcileCustomFeeds();
      editorState.dirty = true;
      app.render();
      return editorState.catalog;
    }).catch(function(error) {
      editorState.catalog = [];
      editorState.catalogStatus = 'error';
      editorState.catalogError = error && error.message ? error.message : 'Could not load feed catalog.';
      reconcileCustomFeeds();
      editorState.dirty = true;
      app.render();
      return [];
    });

    return catalogRequest;
  }

  function openEditor() {
    editorState.open = true;
    editorState.saving = false;
    editorState.search = '';
    editorState.cursor = 0;
    editorState.addUrl = '';
    editorState.addName = '';
    editorState.removedIds = Object.create(null);
    seedDraftSelection(app.getConfig().feeds);
    if (editorState.catalogStatus === 'error') {
      editorState.catalogStatus = 'idle';
      catalogRequest = null;
    }
    ensureCatalogLoaded();
    editorState.dirty = true;
    app.render();
  }

  function closeEditor() {
    editorState.open = false;
    editorState.saving = false;
    editorState.search = '';
    editorState.addUrl = '';
    editorState.addName = '';
    editorState.selectedIds = Object.create(null);
    editorState.removedIds = Object.create(null);
    editorState.customFeeds = [];
    editorState.cursor = 0;
    editorState.dirty = true;
    app.render();
  }

  function getSelectedCount() {
    return Object.keys(editorState.selectedIds).filter(function(feedId) {
      return editorState.selectedIds[feedId];
    }).length;
  }

  function feedMatchesQuery(feed, query) {
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

  function buildVisibleGroups() {
    const groups = [];
    const query = trimText(editorState.search).toLowerCase();
    const categoryMap = Object.create(null);

    const visibleCustomFeeds = editorState.customFeeds.filter(function(feed) {
      return editorState.selectedIds[feed.id] && feedMatchesQuery({
        tag: feed.tag,
        name: feed.name,
        category: 'Custom',
        url: feed.url
      }, query);
    });

    if (visibleCustomFeeds.length) {
      groups.push({
        name: 'Current',
        feeds: visibleCustomFeeds.map(function(feed) {
          return {
            id: feed.id,
            tag: feed.tag,
            name: feed.name,
            url: feed.url,
            category: 'Custom'
          };
        })
      });
    }

    editorState.catalog.forEach(function(feed) {
      if (editorState.removedIds[feed.id] || !feedMatchesQuery(feed, query)) {
        return;
      }

      if (!categoryMap[feed.category]) {
        categoryMap[feed.category] = {
          name: feed.category,
          feeds: []
        };
        groups.push(categoryMap[feed.category]);
      }

      categoryMap[feed.category].feeds.push(feed);
    });

    return groups;
  }

  function buildFlatFeeds() {
    var flat = [];
    buildVisibleGroups().forEach(function(group) {
      group.feeds.forEach(function(feed) { flat.push(feed); });
    });
    return flat;
  }

  function handleEditorKey(key, searchFocused, searchInput) {
    if (editorState.saving) return;

    if (searchFocused) {
      if (key === 'Escape') {
        searchInput.blur();
        editorState.cursor = 0;
        editorState.dirty = true;
        app.render();
      }
      return;
    }

    var maxIdx = Math.max(0, buildFlatFeeds().length - 1);
    var moved = core.moveCursor(editorState.cursor, key, maxIdx);

    if (moved !== null) {
      editorState.cursor = moved;
      editorState.dirty = true;
      editorState.cursorMoved = true;
      app.render();
      return;
    }

    switch (key) {
      case ' ':
        var feeds = buildFlatFeeds();
        if (feeds[editorState.cursor]) {
          var feedId = feeds[editorState.cursor].id;
          setFeedSelection(feedId, !editorState.selectedIds[feedId]);
        }
        return;
      case 'Delete':
        var delFeeds = buildFlatFeeds();
        if (delFeeds[editorState.cursor]) {
          removeFeed(delFeeds[editorState.cursor].id);
        }
        return;
      case '/':
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
        return;
      case 'Enter':
        saveDraft();
        return;
      case 'Escape': case 'q':
        closeEditor();
        return;
    }
  }

  function setFeedSelection(feedId, selected) {
    if (selected) {
      editorState.selectedIds[feedId] = true;
    } else {
      delete editorState.selectedIds[feedId];
    }

    editorState.dirty = true;
    app.render();
  }

  function removeFeed(feedId) {
    delete editorState.selectedIds[feedId];
    editorState.removedIds[feedId] = true;
    editorState.customFeeds = editorState.customFeeds.filter(function(f) {
      return f.id !== feedId;
    });
    var flat = buildFlatFeeds();
    if (flat.length === 0) {
      editorState.cursor = 0;
    } else if (editorState.cursor >= flat.length) {
      editorState.cursor = flat.length - 1;
    }
    editorState.dirty = true;
    app.render();
  }

  function setVisibleSelection(selected) {
    buildVisibleGroups().forEach(function(group) {
      group.feeds.forEach(function(feed) {
        if (selected) {
          editorState.selectedIds[feed.id] = true;
        } else {
          delete editorState.selectedIds[feed.id];
        }
      });
    });

    editorState.dirty = true;
    app.render();
  }

  function addCustomFeed() {
    var url = trimText(editorState.addUrl);
    var name = trimText(editorState.addName);

    if (!url) {
      app.setStatus('Enter a feed URL.');
      return;
    }

    var allFeeds = editorState.catalog.concat(editorState.customFeeds);
    var urlLower = url.toLowerCase();
    var duplicate = allFeeds.some(function(f) {
      return f.url.toLowerCase() === urlLower;
    });
    if (duplicate) {
      app.setStatus('Feed already exists.');
      return;
    }

    if (!name) {
      var match = url.match(/^https?:\/\/([^\/]+)/);
      name = match ? match[1] : url;
    }

    var usedIds = Object.create(null);
    editorState.catalog.forEach(function(f) { usedIds[f.id] = true; });
    editorState.customFeeds.forEach(function(f) { usedIds[f.id] = true; });

    var feed = core.normalizeFeedEntry({ name: name, url: url }, 0, usedIds);

    if (!feed) {
      app.setStatus('Invalid feed URL.');
      return;
    }

    editorState.customFeeds.push(feed);
    editorState.selectedIds[feed.id] = true;
    editorState.addUrl = '';
    editorState.addName = '';
    editorState.dirty = true;
    app.render();
  }

  function buildSelectedFeeds() {
    const selected = [];
    const seenIds = Object.create(null);

    editorState.catalog.forEach(function(feed) {
      if (!editorState.selectedIds[feed.id]) {
        return;
      }

      selected.push(cloneFeed(feed));
      seenIds[feed.id] = true;
    });

    editorState.customFeeds.forEach(function(feed) {
      if (!editorState.selectedIds[feed.id] || seenIds[feed.id]) {
        return;
      }

      selected.push(cloneFeed(feed));
      seenIds[feed.id] = true;
    });

    return selected;
  }

  async function saveDraft() {
    const currentConfig = app.getConfig();
    const selectedFeeds = buildSelectedFeeds();

    if (!selectedFeeds.length) {
      app.setStatus('Select at least one feed.');
      return;
    }

    editorState.saving = true;
    editorState.dirty = true;
    app.render();

    try {
      await app.replaceConfig({
        active: currentConfig.active,
        feeds: selectedFeeds
      }, { refresh: true });

      editorState.open = false;
      editorState.saving = false;
      editorState.search = '';
      editorState.selectedIds = Object.create(null);
      editorState.customFeeds = [];
      editorState.dirty = true;
      app.setStatus(hasLocalStorage ? 'Saved feed selection.' : 'Saved for this session.');
    } catch (error) {
      editorState.saving = false;
      editorState.dirty = true;
      app.setStatus('Could not save feed selection.');
      app.render();
    }
  }

  function exportFeeds() {
    var feeds = app.getConfig().feeds;
    var opml = core.exportOPML(feeds);
    var blob = new Blob([opml], { type: 'text/xml' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ansinews-feeds.opml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    app.setStatus('Exported ' + feeds.length + ' feeds.');
  }

  function importFeeds(file) {
    var reader = new FileReader();
    reader.onload = function() {
      var raw = reader.result;
      var feeds;
      try {
        var parsed = JSON.parse(raw);
        feeds = Array.isArray(parsed.feeds) ? parsed.feeds : Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        feeds = core.parseOPML(raw);
      }
      if (!feeds.length) {
        app.setStatus('No valid feeds found in file.');
        return;
      }
      var result = core.normalizeFeeds(feeds);
      if (!result.feeds.length) {
        app.setStatus('All feeds in file were invalid.');
        return;
      }
      var config = core.normalizeConfig({ active: 'all', feeds: result.feeds });
      var msg = 'Imported ' + config.feeds.length + ' feeds.';
      if (result.invalidCount) { msg += ' ' + result.invalidCount + ' skipped.'; }
      app.replaceConfig({ active: config.active, feeds: config.feeds }, { refresh: true }).then(function() {
        closeEditor();
        app.setStatus(msg);
      });
    };
    reader.readAsText(file);
  }

  function captureFocus() {
    const active = document.activeElement;

    if (!editorState.open || !active || !active.matches('.cfg-focus[data-focus-key]')) {
      return null;
    }

    return {
      key: active.getAttribute('data-focus-key'),
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  function escAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function restoreFocus(snapshot) {
    let input;

    if (!snapshot) {
      return;
    }

    input = document.querySelector('.cfg-focus[data-focus-key="' + snapshot.key + '"]');

    if (!input) {
      return;
    }

    input.focus();

    if (snapshot.start != null && snapshot.end != null && typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(snapshot.start, snapshot.end);
    }
  }

  function renderConfigPanel(tabs) {
    let infoHTML;
    let groupsHTML;
    let emptyHTML;
    let toolbarLabel;

    if (!editorState.open) {
      return '';
    }

    var errorIds = Object.create(null);
    (tabs || []).forEach(function(tab) { if (tab.error) errorIds[tab.id] = true; });

    if (editorState.catalogStatus === 'pending') {
      infoHTML = '<div class="cfg-note">Loading feed catalog...</div>';
    } else if (editorState.catalogStatus === 'error') {
      infoHTML = '<div class="cfg-note cfg-note-warn">Catalog unavailable. Showing current selection only. '
        + escAttr(editorState.catalogError) + '</div>';
    } else {
      infoHTML = '<div class="cfg-note">Browse the bundled feed list, filter it, then save your selection.</div>';
    }

    var cursorIdx = 0;
    groupsHTML = buildVisibleGroups().map(function(group) {
      const rowsHTML = group.feeds.map(function(feed) {
        const checked = editorState.selectedIds[feed.id] ? ' checked' : '';
        const focusClass = cursorIdx === editorState.cursor ? ' cfg-row-focus' : '';
        const idx = cursorIdx;
        cursorIdx++;

        return '<label class="cfg-feed-row' + focusClass + '" data-cursor-idx="' + idx + '">'
          + '<input class="cfg-check" type="checkbox" data-feed-id="' + escAttr(feed.id) + '"' + checked
          + (editorState.saving ? ' disabled' : '') + '>'
          + '<span class="cfg-feed-tag' + (errorIds[feed.id] ? ' cfg-feed-err' : '') + '">' + escAttr(feed.tag) + '</span>'
          + '<span class="cfg-feed-copy">'
            + '<span class="cfg-feed-name">' + escAttr(feed.name) + '</span>'
            + '<span class="cfg-feed-url">' + escAttr(feed.url) + '</span>'
          + '</span>'
          + '<button class="cfg-feed-rm" type="button" data-rm-id="' + escAttr(feed.id) + '"'
            + (editorState.saving ? ' disabled' : '') + ' title="Remove feed">\u00d7</button>'
        + '</label>';
      }).join('');

      return '<section class="cfg-group">'
        + '<div class="cfg-group-title">' + escAttr(group.name) + '</div>'
        + '<div class="cfg-group-rows">' + rowsHTML + '</div>'
      + '</section>';
    }).join('');

    emptyHTML = groupsHTML
      ? ''
      : '<div class="cfg-empty">' + (trimText(editorState.search)
        ? 'No feeds match this filter.'
        : 'No feeds available right now.') + '</div>';

    toolbarLabel = getSelectedCount() + ' selected';

    return '<div class="cfg-overlay">'
      + '<div class="cfg-panel">'
        + '<div class="cfg-header">'
          + '<div class="cfg-title">FEEDS</div>'
          + '<div class="cfg-subtitle">[&#x2191;&#x2193; jk] nav  [space] toggle  [del] remove  [/] filter  [enter] save  [esc] close</div>'
        + '</div>'
        + '<div class="cfg-toolbar">'
          + '<input class="cfg-search cfg-focus" data-focus-key="search" type="text" value="' + escAttr(editorState.search)
            + '" placeholder="search feeds, categories, or tags"' + (editorState.saving ? ' disabled' : '') + '>'
          + '<div class="cfg-summary">' + toolbarLabel + '</div>'
          + '<button class="cfg-bulk" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-bulk="select">select visible</button>'
          + '<button class="cfg-bulk" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-bulk="clear">clear visible</button>'
        + '</div>'
        + '<div class="cfg-add-row">'
          + '<input class="cfg-add-url cfg-focus" data-focus-key="add-url" type="text" placeholder="https://..." value="' + escAttr(editorState.addUrl) + '"' + (editorState.saving ? ' disabled' : '') + '>'
          + '<input class="cfg-add-name cfg-focus" data-focus-key="add-name" type="text" placeholder="name (optional)" value="' + escAttr(editorState.addName) + '"' + (editorState.saving ? ' disabled' : '') + '>'
          + '<button class="cfg-add-btn" type="button"' + (editorState.saving ? ' disabled' : '') + '>add</button>'
        + '</div>'
        + '<div class="cfg-body">'
          + infoHTML
          + groupsHTML
          + emptyHTML
        + '</div>'
        + '<div class="cfg-actions">'
          + '<div class="cfg-actions-note">' + (hasLocalStorage ? 'Saved in browser storage.' : 'Saved for this session only.') + '</div>'
          + '<button class="cfg-io" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-io="export">export</button>'
          + '<button class="cfg-io" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-io="import">import</button>'
          + '<input class="cfg-import-file" type="file" accept=".opml,.xml,.json" style="display:none">'
          + '<div class="cfg-spacer"></div>'
          + '<button class="cfg-cancel" type="button"' + (editorState.saving ? ' disabled' : '') + '>cancel</button>'
          + '<button class="cfg-save" type="button"' + (editorState.saving ? ' disabled' : '') + '>' + (editorState.saving ? 'saving...' : 'save') + '</button>'
        + '</div>'
      + '</div>'
    + '</div>';
  }

  function render(view) {
    const terminal = rootEl();

    if (!terminal) {
      return;
    }

    const focusSnapshot = captureFocus();
    const dirty = editorState.dirty;
    const cursorMoved = editorState.cursorMoved;
    editorState.dirty = false;
    editorState.cursorMoved = false;

    const esc = view.meta.esc;
    const tabsHTML = view.tabs.map(function(tab, index) {
      const active = view.state.active === tab.id ? ' tab-on' : '';
      const err = !active && tab.error ? ' tab-err' : '';
      return '<span class="tab' + active + err + '" data-feed="' + tab.id + '">'
        + '<span class="tab-num">' + index + '</span>:' + tab.tag
        + '</span><span class="tab-sep">|</span>';
    }).join('');

    const filterHTML = view.state.filtering
      ? '<div class="row filter-row"><span class="filter-label">FILTER: </span>'
        + esc(view.state.filter) + '<span class="blink">_</span></div>'
      : '';

    const rowsHTML = view.visibleItems.map(function(item, visibleIndex) {
      const absoluteIndex = view.state.scroll + visibleIndex;
      const selected = absoluteIndex === view.state.cursor ? ' sel' : '';
      const src = (item.feedTag || '?????').padEnd(5).slice(0, 5);
      const age = view.meta.fmtAge(item.date).padEnd(4).slice(0, 4);
      const color = item.css || '#22d3ee';

      return '<div class="row item-row' + selected + '" data-idx="' + absoluteIndex + '">'
        + '<span class="src" style="color:' + color + '">' + src + '</span>'
        + '<span class="age">' + age + '</span>'
        + '<span class="headline">' + esc(item.title) + '</span>'
        + '</div>';
    }).join('');

    let detailHTML = '';
    if (view.state.detail && view.selectedItem) {
      const detailLines = view.meta.wrap(view.selectedItem.desc || '(no description)', 120, 2);
      detailHTML = '<div class="sep"></div><div class="detail">'
        + '<div class="d-title">' + esc(view.selectedItem.title) + '</div>'
        + '<div class="d-desc">' + esc(detailLines[0] || '') + '</div>'
        + '<div class="d-desc">' + esc(detailLines[1] || '') + '</div>'
        + '<div class="d-link">' + esc(view.selectedItem.link) + '</div>'
        + '<div class="d-meta">' + esc(view.meta.fmtMeta(view.selectedItem)) + '</div>'
        + '<div class="d-hint">[enter/o] open in browser   [esc/q] back</div>'
        + '</div>';
    }

    let statusHTML = '';
    if (view.loading) {
      statusHTML += '<span class="s-load">LOADING</span> &nbsp;';
    }
    if (view.errs > 0) {
      statusHTML += '<span class="s-err">ERR ' + view.errs + '</span> &nbsp;';
    }
    if (view.state.filter) {
      statusHTML += '<span class="s-filter">/' + esc(view.state.filter) + '/</span> &nbsp;';
    }
    if (view.statusMsg) {
      statusHTML += '<span class="s-msg">' + esc(view.statusMsg) + '</span>';
    } else {
      statusHTML += '<span class="s-hints">' + esc(view.hintKeys) + '</span>';
    }

    const appInner =
        '<div class="hdr">'
          + '<span class="hdr-l">&gt; ANSINEWS v' + view.version + '</span>'
          + '<div class="hdr-r">'
            + '<button class="cfg-btn" type="button">feeds</button>'
            + '<span>' + (view.loading ? 'LOAD ' : '') + view.timer + ' &nbsp; ' + view.clock + '</span>'
          + '</div>'
        + '</div>'
        + '<div class="tabs">' + tabsHTML + '</div>'
        + filterHTML
        + '<div class="sep"></div>'
        + (view.activeError
          ? '<div class="feed-error">Failed to load feed: ' + esc(view.activeError) + '<br>Press [r] to refresh</div>'
          : '<div class="row col-hdr"><span>SRC&nbsp;&nbsp;</span><span>AGE&nbsp;</span><span>HEADLINE</span></div>'
            + '<div class="list">' + rowsHTML + '</div>')
        + detailHTML
        + '<div class="sep"></div>'
        + '<div class="row statusbar">' + statusHTML + '</div>';

    const existingOverlay = terminal.querySelector('.cfg-overlay');

    if (editorState.open && existingOverlay && !dirty) {
      var shell = terminal.querySelector('.app-shell');
      if (shell) {
        shell.innerHTML = appInner;
      }
    } else {
      var cfgBody = existingOverlay && existingOverlay.querySelector('.cfg-body');
      var scrollSnapshot = cfgBody ? cfgBody.scrollTop : 0;

      terminal.innerHTML = '<div class="app-shell">' + appInner + '</div>'
        + renderConfigPanel(view.tabs);

      var restoredBody = terminal.querySelector('.cfg-body');
      if (restoredBody && scrollSnapshot) {
        restoredBody.scrollTop = scrollSnapshot;
      }

      var focusedRow = terminal.querySelector('.cfg-row-focus');
      if (focusedRow && cursorMoved) {
        focusedRow.scrollIntoView({ block: 'nearest' });
      }
    }

    restoreFocus(focusSnapshot);
  }

  document.addEventListener('DOMContentLoaded', function() {
    app.start();
    ensureCatalogLoaded();

    document.addEventListener('keydown', function(event) {
      const noModifiers = !event.ctrlKey && !event.metaKey && !event.altKey;

      if (!noModifiers) {
        return;
      }

      if (!editorState.open && event.key === 'f') {
        event.preventDefault();
        openEditor();
        return;
      }

      if (editorState.open) {
        var terminal = rootEl();
        var searchInput = terminal && terminal.querySelector('.cfg-search');
        var searchFocused = searchInput && document.activeElement === searchInput;
        var addInputFocused = document.activeElement &&
          (document.activeElement.matches('.cfg-add-url') || document.activeElement.matches('.cfg-add-name'));

        if (addInputFocused) {
          if (event.key === 'Enter') {
            event.preventDefault();
            addCustomFeed();
          } else if (event.key === 'Escape') {
            document.activeElement.blur();
          }
          return;
        }

        if (!searchFocused && [' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', '/', 'Delete'].includes(event.key)) {
          event.preventDefault();
        }

        handleEditorKey(event.key, searchFocused, searchInput);
        return;
      }

      if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
      }

      app.handleKey(event.key);
    });

    document.addEventListener('click', function(event) {
      const configButton = event.target.closest('.cfg-btn');
      const bulkButton = event.target.closest('.cfg-bulk[data-bulk]');
      const cancelButton = event.target.closest('.cfg-cancel');
      const saveButton = event.target.closest('.cfg-save');

      if (configButton) {
        openEditor();
        return;
      }

      if (bulkButton && !editorState.saving) {
        setVisibleSelection(bulkButton.getAttribute('data-bulk') === 'select');
        return;
      }

      if (cancelButton) {
        closeEditor();
        return;
      }

      if (saveButton && !editorState.saving) {
        saveDraft();
        return;
      }

      var rmBtn = event.target.closest('.cfg-feed-rm[data-rm-id]');
      if (rmBtn && !editorState.saving) {
        event.preventDefault();
        removeFeed(rmBtn.getAttribute('data-rm-id'));
        return;
      }

      var addBtn = event.target.closest('.cfg-add-btn');
      if (addBtn && !editorState.saving) {
        addCustomFeed();
        return;
      }

      var ioButton = event.target.closest('.cfg-io[data-io]');
      if (ioButton && !editorState.saving) {
        var action = ioButton.getAttribute('data-io');
        if (action === 'export') {
          exportFeeds();
        } else if (action === 'import') {
          var fileInput = document.querySelector('.cfg-import-file');
          if (fileInput) {
            fileInput.value = '';
            fileInput.click();
          }
        }
        return;
      }

      if (editorState.open && event.target.closest('.cfg-panel')) {
        return;
      }

      if (editorState.open) {
        return;
      }

      const tab = event.target.closest('.tab[data-feed]');
      if (tab) {
        app.activateFeed(tab.dataset.feed);
        return;
      }

      const row = event.target.closest('.item-row[data-idx]');
      if (row) {
        app.selectIndex(parseInt(row.dataset.idx, 10), { toggleDetailOnSame: true });
      }
    });

    document.addEventListener('input', function(event) {
      const searchInput = event.target.closest('.cfg-search');

      if (searchInput) {
        editorState.search = searchInput.value;
        editorState.cursor = 0;
        editorState.dirty = true;
        app.render();
        return;
      }

      var addUrlInput = event.target.closest('.cfg-add-url');
      if (addUrlInput) {
        editorState.addUrl = addUrlInput.value;
        return;
      }

      var addNameInput = event.target.closest('.cfg-add-name');
      if (addNameInput) {
        editorState.addName = addNameInput.value;
        return;
      }
    });

    document.addEventListener('change', function(event) {
      const checkbox = event.target.closest('.cfg-check[data-feed-id]');

      if (checkbox) {
        setFeedSelection(checkbox.getAttribute('data-feed-id'), checkbox.checked);
        return;
      }

      var fileInput = event.target.closest('.cfg-import-file');
      if (fileInput && fileInput.files && fileInput.files[0]) {
        importFeeds(fileInput.files[0]);
      }
    });

    window.addEventListener('resize', function() {
      app.render();
    });
  });
})();
