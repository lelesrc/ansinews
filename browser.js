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
    customFeeds: [],
    catalog: [],
    catalogStatus: 'idle',
    catalogError: ''
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
    const category = trimText(feed.category, 40) || 'Other';
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

  function getCatalogMap() {
    const map = Object.create(null);

    editorState.catalog.forEach(function(feed) {
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

  function reconcileCustomFeeds() {
    const catalogMap = getCatalogMap();

    editorState.customFeeds = editorState.customFeeds.filter(function(feed) {
      return !sameFeed(feed, catalogMap[feed.id]);
    });
  }

  function seedDraftSelection(feeds) {
    const catalogMap = getCatalogMap();
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
    app.render();

    catalogRequest = fetch(CATALOG_PATH, { cache: 'no-store' }).then(function(response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.json();
    }).then(function(data) {
      editorState.catalog = normalizeCatalog(data);

      if (!editorState.catalog.length) {
        throw new Error('No valid feeds in default_feeds.json.');
      }

      editorState.catalogStatus = 'loaded';
      editorState.catalogError = '';
      reconcileCustomFeeds();
      app.render();
      return editorState.catalog;
    }).catch(function(error) {
      editorState.catalog = [];
      editorState.catalogStatus = 'error';
      editorState.catalogError = error && error.message ? error.message : 'Could not load feed catalog.';
      reconcileCustomFeeds();
      app.render();
      return [];
    });

    return catalogRequest;
  }

  function openEditor() {
    editorState.open = true;
    editorState.saving = false;
    editorState.search = '';
    seedDraftSelection(app.getConfig().feeds);
    ensureCatalogLoaded();
    app.render();
  }

  function closeEditor() {
    editorState.open = false;
    editorState.saving = false;
    editorState.search = '';
    editorState.selectedIds = Object.create(null);
    editorState.customFeeds = [];
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
      if (!feedMatchesQuery(feed, query)) {
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

  function setFeedSelection(feedId, selected) {
    if (selected) {
      editorState.selectedIds[feedId] = true;
    } else {
      delete editorState.selectedIds[feedId];
    }

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
      app.setStatus(hasLocalStorage ? 'Saved feed selection.' : 'Saved for this session.');
    } catch (error) {
      editorState.saving = false;
      app.setStatus('Could not save feed selection.');
      app.render();
    }
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

  function renderConfigPanel() {
    let infoHTML;
    let groupsHTML;
    let emptyHTML;
    let toolbarLabel;

    if (!editorState.open) {
      return '';
    }

    if (editorState.catalogStatus === 'pending') {
      infoHTML = '<div class="cfg-note">Loading feed catalog...</div>';
    } else if (editorState.catalogStatus === 'error') {
      infoHTML = '<div class="cfg-note cfg-note-warn">Catalog unavailable. Showing current selection only. '
        + escAttr(editorState.catalogError) + '</div>';
    } else {
      infoHTML = '<div class="cfg-note">Browse the bundled feed list, filter it, then save your selection.</div>';
    }

    groupsHTML = buildVisibleGroups().map(function(group) {
      const rowsHTML = group.feeds.map(function(feed) {
        const checked = editorState.selectedIds[feed.id] ? ' checked' : '';

        return '<label class="cfg-feed-row">'
          + '<input class="cfg-check" type="checkbox" data-feed-id="' + escAttr(feed.id) + '"' + checked
          + (editorState.saving ? ' disabled' : '') + '>'
          + '<span class="cfg-feed-tag">' + escAttr(feed.tag) + '</span>'
          + '<span class="cfg-feed-copy">'
            + '<span class="cfg-feed-name">' + escAttr(feed.name) + '</span>'
            + '<span class="cfg-feed-url">' + escAttr(feed.url) + '</span>'
          + '</span>'
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
          + '<div class="cfg-subtitle">Locate, select, and deselect RSS feeds for this browser.</div>'
        + '</div>'
        + '<div class="cfg-toolbar">'
          + '<input class="cfg-search cfg-focus" data-focus-key="search" type="text" value="' + escAttr(editorState.search)
            + '" placeholder="search feeds, categories, or tags"' + (editorState.saving ? ' disabled' : '') + '>'
          + '<div class="cfg-summary">' + toolbarLabel + '</div>'
          + '<button class="cfg-bulk" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-bulk="select">select visible</button>'
          + '<button class="cfg-bulk" type="button"' + (editorState.saving ? ' disabled' : '') + ' data-bulk="clear">clear visible</button>'
        + '</div>'
        + '<div class="cfg-body">'
          + infoHTML
          + groupsHTML
          + emptyHTML
        + '</div>'
        + '<div class="cfg-actions">'
          + '<div class="cfg-actions-note">' + (hasLocalStorage ? 'Saved in browser storage.' : 'Saved for this session only.') + '</div>'
          + '<div class="cfg-spacer"></div>'
          + '<button class="cfg-cancel" type="button"' + (editorState.saving ? ' disabled' : '') + '>cancel</button>'
          + '<button class="cfg-save" type="button"' + (editorState.saving ? ' disabled' : '') + '>' + (editorState.saving ? 'saving...' : 'save') + '</button>'
        + '</div>'
      + '</div>'
    + '</div>';
  }

  function render(view) {
    const terminal = rootEl();
    const focusSnapshot = captureFocus();

    if (!terminal) {
      return;
    }

    const esc = view.meta.esc;
    const tabsHTML = view.tabs.map(function(tab, index) {
      const active = view.state.active === tab.id ? ' tab-on' : '';
      return '<span class="tab' + active + '" data-feed="' + tab.id + '">'
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

    terminal.innerHTML =
      '<div class="app-shell">'
        + '<div class="hdr">'
          + '<span class="hdr-l">&gt; ANSINEWS v' + view.version + '</span>'
          + '<div class="hdr-r">'
            + '<button class="cfg-btn" type="button">feeds</button>'
            + '<span>' + (view.loading ? 'LOAD ' : '') + view.timer + ' &nbsp; ' + view.clock + '</span>'
          + '</div>'
        + '</div>'
        + '<div class="tabs">' + tabsHTML + '</div>'
        + filterHTML
        + '<div class="sep"></div>'
        + '<div class="row col-hdr"><span>SRC&nbsp;&nbsp;</span><span>AGE&nbsp;</span><span>HEADLINE</span></div>'
        + '<div class="list">' + rowsHTML + '</div>'
        + detailHTML
        + '<div class="sep"></div>'
        + '<div class="row statusbar">' + statusHTML + '</div>'
      + '</div>'
      + renderConfigPanel();

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

      if (editorState.open) {
        if (event.key === 'Escape' && !editorState.saving) {
          event.preventDefault();
          closeEditor();
        }
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

      if (!searchInput) {
        return;
      }

      editorState.search = searchInput.value;
      app.render();
    });

    document.addEventListener('change', function(event) {
      const checkbox = event.target.closest('.cfg-check[data-feed-id]');

      if (!checkbox) {
        return;
      }

      setFeedSelection(checkbox.getAttribute('data-feed-id'), checkbox.checked);
    });

    window.addEventListener('resize', function() {
      app.render();
    });
  });
})();
