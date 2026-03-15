'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fs = require('node:fs');
const path = require('node:path');
const core = require('../ansinews-core.js');

const catalogPath = path.join(__dirname, '..', 'default_feeds.json');
core.setDefaultFeeds(core.normalizeCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))));

function makeRSS(items) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<rss version="2.0"><channel>'
    + items.map(function(item) {
      return '<item>'
        + '<title>' + item.title + '</title>'
        + '<link>' + item.link + '</link>'
        + '<description><![CDATA[' + item.desc + ']]></description>'
        + '<pubDate>' + item.pubDate + '</pubDate>'
        + (item.author ? '<author>' + item.author + '</author>' : '')
        + '</item>';
    }).join('')
    + '</channel></rss>';
}

function createPlatform(options) {
  const settings = options || {};
  const saves = [];
  const opens = [];
  const fetches = [];
  const renders = [];
  const feedMap = settings.feedMap || {};

  function fetchXML(url) {
    fetches.push(url);

    if (settings.fetchXML) {
      return Promise.resolve(settings.fetchXML(url));
    }

    if (Object.prototype.hasOwnProperty.call(feedMap, url)) {
      const result = feedMap[url];

      if (result instanceof Error) {
        return Promise.reject(result);
      }

      return Promise.resolve(result);
    }

    return Promise.reject(new Error('Unexpected URL: ' + url));
  }

  return {
    platform: {
      mode: settings.mode || 'node',
      loadPrefs: function() {
        return settings.prefs || {};
      },
      savePrefs: function(data) {
        saves.push(data);
      },
      fetchXML: fetchXML,
      openURL: function(url) {
        opens.push(url);
      },
      getListHeight: function() {
        return settings.listHeight || 5;
      },
      render: function(view) {
        renders.push(view);
      }
    },
    saves: saves,
    opens: opens,
    fetches: fetches,
    renders: renders
  };
}

describe('normalizeConfig', function() {
  it('falls back to defaults when config is missing', function() {
    const config = core.normalizeConfig();

    assert.equal(config.active, 'all');
    assert.equal(config.notice, '');
    assert.deepEqual(config.feeds, core.getDefaultConfig().feeds);
  });

  it('keeps valid feeds, drops invalid feeds, and normalizes ids and tags', function() {
    const config = core.normalizeConfig({
      active: 'custom',
      feeds: [
        { id: 'Custom Feed', tag: 'one!', name: 'Custom Feed', url: 'https://example.com/one.xml' },
        { name: 'Broken Feed' },
        { tag: 'one', name: 'Second Feed', url: 'https://example.com/two.xml' }
      ]
    });

    assert.equal(config.notice, 'Some feeds were ignored.');
    assert.equal(config.active, 'all');
    assert.equal(config.feeds.length, 2);
    assert.equal(config.feeds[0].id, 'custom-feed');
    assert.equal(config.feeds[0].tag, 'ONE');
    assert.equal(config.feeds[1].id, 'one');
    assert.equal(config.feeds[1].tag, 'ONE');
  });

  it('falls back to defaults when every configured feed is invalid', function() {
    const config = core.normalizeConfig({
      active: 'missing',
      feeds: [
        { name: 'No URL' },
        { url: 'notaurl' }
      ]
    });

    assert.equal(config.active, 'all');
    assert.equal(config.notice, 'Invalid feeds config. Using defaults.');
    assert.deepEqual(config.feeds, core.getDefaultConfig().feeds);
  });
});

describe('createApp', function() {
  it('refreshes feeds, parses RSS, and sorts items by date across feeds', async function() {
    const firstUrl = 'https://example.com/first.xml';
    const secondUrl = 'https://example.com/second.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'first', tag: 'ONE', name: 'First', url: firstUrl },
          { id: 'second', tag: 'TWO', name: 'Second', url: secondUrl }
        ]
      },
      feedMap: {
        [firstUrl]: makeRSS([
          {
            title: 'Older Story',
            link: 'https://example.com/older',
            desc: 'First description',
            pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT'
          }
        ]),
        [secondUrl]: makeRSS([
          {
            title: 'Newer &amp; Better',
            link: 'https://example.com/newer',
            desc: 'Second <b>description</b>',
            pubDate: 'Tue, 05 Mar 2024 12:00:00 GMT',
            author: 'Reporter'
          }
        ])
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();

    const view = app.getView();

    assert.deepEqual(harness.fetches, [firstUrl, secondUrl]);
    assert.equal(view.errs, 0);
    assert.equal(view.tabs.length, 3);
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Newer & Better', 'Older Story']);
    assert.equal(view.items[0].feedId, 'second');
    assert.equal(view.items[0].feedTag, 'TWO');
    assert.equal(view.items[0].author, 'Reporter');
    assert.ok(harness.renders.length >= 4);
  });

  it('tracks refresh failures without dropping successful items', async function() {
    const okUrl = 'https://example.com/ok.xml';
    const badUrl = 'https://example.com/bad.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'ok', tag: 'OK', name: 'Okay Feed', url: okUrl },
          { id: 'bad', tag: 'BAD', name: 'Bad Feed', url: badUrl }
        ]
      },
      feedMap: {
        [okUrl]: makeRSS([
          {
            title: 'Working Story',
            link: 'https://example.com/working',
            desc: 'Still available',
            pubDate: 'Tue, 05 Mar 2024 12:00:00 GMT'
          }
        ]),
        [badUrl]: new Error('HTTP 503')
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();

    const view = app.getView();

    assert.equal(view.errs, 1);
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Working Story']);
    assert.equal(app.state.feeds[1].error, 'HTTP 503');
  });

  it('filters items through handleKey and clears the filter on escape', async function() {
    const url = 'https://example.com/feed.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'solo', tag: 'SOLO', name: 'Solo Feed', url: url }
        ]
      },
      feedMap: {
        [url]: makeRSS([
          {
            title: 'Alpha Story',
            link: 'https://example.com/alpha',
            desc: 'First item',
            pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT'
          },
          {
            title: 'Beta Story',
            link: 'https://example.com/beta',
            desc: 'Second item',
            pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT'
          }
        ])
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();
    app.handleKey('/');
    app.handleKey('A');
    app.handleKey('l');
    app.handleKey('p');
    app.handleKey('h');
    app.handleKey('a');
    app.handleKey('Enter');

    let view = app.getView();
    assert.equal(view.state.filtering, false);
    assert.equal(view.state.filter, 'Alpha');
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Alpha Story']);

    app.handleKey('Escape');
    view = app.getView();
    assert.equal(view.state.filter, '');
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Beta Story', 'Alpha Story']);
  });

  it('filters items by description text when title does not match', async function() {
    const url = 'https://example.com/feed.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'solo', tag: 'SOLO', name: 'Solo Feed', url: url }
        ]
      },
      feedMap: {
        [url]: makeRSS([
          {
            title: 'Weather Report',
            link: 'https://example.com/weather',
            desc: 'Tornado warning issued for the region',
            pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT'
          },
          {
            title: 'Sports Recap',
            link: 'https://example.com/sports',
            desc: 'Final scores from last night',
            pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT'
          }
        ])
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();
    app.handleKey('/');
    'tornado'.split('').forEach(function(ch) { app.handleKey(ch); });
    app.handleKey('Enter');

    const view = app.getView();
    assert.equal(view.state.filter, 'tornado');
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Weather Report']);
  });

  it('switches tabs with numeric shortcuts and manages detail state transitions', async function() {
    const oneUrl = 'https://example.com/one.xml';
    const twoUrl = 'https://example.com/two.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'one', tag: 'ONE', name: 'One', url: oneUrl },
          { id: 'two', tag: 'TWO', name: 'Two', url: twoUrl }
        ]
      },
      feedMap: {
        [oneUrl]: makeRSS([
          {
            title: 'One Story',
            link: 'https://example.com/one-story',
            desc: 'One item',
            pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT'
          }
        ]),
        [twoUrl]: makeRSS([
          {
            title: 'Two Story',
            link: 'https://example.com/two-story',
            desc: 'Two item',
            pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT'
          }
        ])
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();

    app.handleKey('2');
    let view = app.getView();
    assert.equal(view.state.active, 'two');
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Two Story']);
    assert.equal(harness.saves.length, 1);
    assert.equal(harness.saves[0].active, 'two');

    app.handleKey('0');
    app.selectIndex(1, { openDetail: true });
    view = app.getView();
    assert.equal(view.state.active, 'all');
    assert.equal(view.state.cursor, 1);
    assert.equal(view.state.detail, true);
    assert.equal(view.selectedItem.title, 'One Story');

    app.handleKey('Escape');
    view = app.getView();
    assert.equal(view.state.detail, false);
  });

  it('replaces config, persists normalized feeds, and refreshes new feed data', async function() {
    const oldUrl = 'https://example.com/old.xml';
    const newUrl = 'https://example.com/new.xml';
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'old', tag: 'OLD', name: 'Old Feed', url: oldUrl }
        ]
      },
      feedMap: {
        [oldUrl]: makeRSS([
          {
            title: 'Old Story',
            link: 'https://example.com/old-story',
            desc: 'Old item',
            pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT'
          }
        ]),
        [newUrl]: makeRSS([
          {
            title: 'Fresh Story',
            link: 'https://example.com/fresh-story',
            desc: 'Fresh item',
            pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT'
          }
        ])
      }
    });
    const app = core.createApp(harness.platform);

    await app.refreshAll();
    await app.replaceConfig({
      active: 'fresh',
      feeds: [
        { tag: 'fresh', name: 'Fresh Feed', url: newUrl }
      ]
    }, { refresh: true });

    const view = app.getView();
    const saved = harness.saves[harness.saves.length - 1];

    assert.equal(view.state.active, 'fresh');
    assert.deepEqual(view.tabs.map(function(tab) {
      return tab.id;
    }), ['all', 'fresh']);
    assert.deepEqual(view.items.map(function(item) {
      return item.title;
    }), ['Fresh Story']);
    assert.equal(saved.active, 'fresh');
    assert.deepEqual(saved.feeds, [
      {
        id: 'fresh',
        tag: 'FRESH',
        name: 'Fresh Feed',
        url: newUrl
      }
    ]);
  });
});

describe('cloneFeed', function() {
  it('returns a shallow copy with default empty strings for missing fields', function() {
    const original = { id: 'test', tag: 'TST', name: 'Test', url: 'http://example.com' };
    const clone = core.cloneFeed(original);
    assert.deepEqual(clone, original);
    assert.notEqual(clone, original);

    const partial = { id: 'x' };
    const result = core.cloneFeed(partial);
    assert.equal(result.tag, '');
    assert.equal(result.name, '');
    assert.equal(result.url, '');
  });
});

describe('sameFeed', function() {
  it('returns true for identical feeds and false for mismatches or nulls', function() {
    const a = { id: 'f', tag: 'F', name: 'Feed', url: 'http://a.com' };
    const b = { id: 'f', tag: 'F', name: 'Feed', url: 'http://a.com' };
    assert.equal(core.sameFeed(a, b), true);

    assert.equal(core.sameFeed(a, { id: 'f', tag: 'F', name: 'Feed', url: 'http://b.com' }), false);
    assert.equal(core.sameFeed(null, a), false);
    assert.equal(core.sameFeed(a, null), false);
    assert.equal(core.sameFeed(null, null), false);
  });
});

describe('normalizeCatalogFeed', function() {
  it('normalizes a valid feed with all fields', function() {
    const usedIds = Object.create(null);
    const result = core.normalizeCatalogFeed({
      id: 'my-feed',
      tag: 'MF',
      name: 'My Feed',
      url: 'https://example.com/rss',
      category: 'Tech'
    }, usedIds);

    assert.deepEqual(result, {
      id: 'my-feed',
      tag: 'MF',
      name: 'My Feed',
      url: 'https://example.com/rss',
      category: 'Tech'
    });
    assert.equal(usedIds['my-feed'], true);
  });

  it('returns null for invalid input', function() {
    const usedIds = Object.create(null);
    assert.equal(core.normalizeCatalogFeed(null, usedIds), null);
    assert.equal(core.normalizeCatalogFeed({ name: 'No URL' }, usedIds), null);
    assert.equal(core.normalizeCatalogFeed({ name: 'Bad', url: 'not-a-url' }, usedIds), null);
  });

  it('rejects duplicate ids', function() {
    const usedIds = Object.create(null);
    const feed = { id: 'dup', name: 'Feed', url: 'https://a.com/rss' };
    assert.ok(core.normalizeCatalogFeed(feed, usedIds));
    assert.equal(core.normalizeCatalogFeed(feed, usedIds), null);
  });

  it('defaults category to Other', function() {
    const usedIds = Object.create(null);
    const result = core.normalizeCatalogFeed({
      id: 'cat-test', name: 'Test', url: 'https://x.com/rss'
    }, usedIds);
    assert.equal(result.category, 'Other');
  });
});

describe('normalizeCatalog', function() {
  it('normalizes an array of feeds and skips invalid entries', function() {
    const feeds = [
      { id: 'a', name: 'A', url: 'https://a.com/rss' },
      null,
      { id: 'b', name: 'B', url: 'invalid' },
      { id: 'c', name: 'C', url: 'https://c.com/rss' }
    ];
    const result = core.normalizeCatalog(feeds);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a');
    assert.equal(result[1].id, 'c');
  });

  it('returns empty array for non-array input', function() {
    assert.deepEqual(core.normalizeCatalog(null), []);
    assert.deepEqual(core.normalizeCatalog('hello'), []);
  });
});

describe('exportOPML', function() {
  it('generates valid OPML from a feed array', function() {
    const feeds = [
      { id: 'a', tag: 'A', name: 'Alpha Feed', url: 'https://alpha.com/rss' },
      { id: 'b', tag: 'B', name: 'Beta Feed', url: 'https://beta.com/rss' }
    ];
    const opml = core.exportOPML(feeds);

    assert.ok(opml.includes('<opml version="2.0">'));
    assert.ok(opml.includes('xmlUrl="https://alpha.com/rss"'));
    assert.ok(opml.includes('xmlUrl="https://beta.com/rss"'));
    assert.ok(opml.includes('text="Alpha Feed"'));
    assert.ok(opml.includes('text="Beta Feed"'));
  });

  it('escapes XML special characters in attributes', function() {
    const feeds = [
      { id: 'x', tag: 'X', name: 'News & "Stuff"', url: 'https://example.com/rss?a=1&b=2' }
    ];
    const opml = core.exportOPML(feeds);

    assert.ok(opml.includes('text="News &amp; &quot;Stuff&quot;"'));
    assert.ok(opml.includes('xmlUrl="https://example.com/rss?a=1&amp;b=2"'));
  });

  it('returns valid OPML for empty feed array', function() {
    const opml = core.exportOPML([]);
    assert.ok(opml.includes('<body>'));
    assert.ok(opml.includes('</body>'));
    assert.ok(!opml.includes('<outline'));
  });
});

describe('parseOPML', function() {
  it('extracts feeds from OPML with xmlUrl attributes', function() {
    const opml = [
      '<?xml version="1.0"?>',
      '<opml version="2.0"><head><title>Test</title></head><body>',
      '<outline type="rss" text="Feed One" title="Feed One" xmlUrl="https://one.com/rss" />',
      '<outline type="rss" text="Feed Two" xmlUrl="https://two.com/rss" />',
      '</body></opml>'
    ].join('\n');

    const feeds = core.parseOPML(opml);
    assert.equal(feeds.length, 2);
    assert.equal(feeds[0].name, 'Feed One');
    assert.equal(feeds[0].url, 'https://one.com/rss');
    assert.equal(feeds[1].name, 'Feed Two');
    assert.equal(feeds[1].url, 'https://two.com/rss');
  });

  it('prefers title over text attribute for feed name', function() {
    const opml = '<opml><body><outline text="Short" title="Full Name" xmlUrl="https://x.com/rss" /></body></opml>';
    const feeds = core.parseOPML(opml);
    assert.equal(feeds[0].name, 'Full Name');
  });

  it('handles escaped XML entities in attributes', function() {
    const opml = '<opml><body><outline text="A &amp; B" xmlUrl="https://x.com/rss?a=1&amp;b=2" /></body></opml>';
    const feeds = core.parseOPML(opml);
    assert.equal(feeds[0].name, 'A & B');
    assert.equal(feeds[0].url, 'https://x.com/rss?a=1&b=2');
  });

  it('returns empty array for empty or malformed input', function() {
    assert.deepEqual(core.parseOPML(''), []);
    assert.deepEqual(core.parseOPML('<opml><body></body></opml>'), []);
    assert.deepEqual(core.parseOPML('not xml at all'), []);
  });

  it('round-trips through exportOPML and parseOPML', function() {
    const original = [
      { id: 'a', tag: 'A', name: 'Alpha', url: 'https://alpha.com/rss' },
      { id: 'b', tag: 'B', name: 'Beta & Co', url: 'https://beta.com/feed?x=1&y=2' }
    ];
    const parsed = core.parseOPML(core.exportOPML(original));

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].name, 'Alpha');
    assert.equal(parsed[0].url, 'https://alpha.com/rss');
    assert.equal(parsed[1].name, 'Beta & Co');
    assert.equal(parsed[1].url, 'https://beta.com/feed?x=1&y=2');
  });
});

describe('getCatalogMap', function() {
  it('creates an id-to-feed lookup map', function() {
    const feeds = [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' }
    ];
    const map = core.getCatalogMap(feeds);
    assert.equal(map.x.name, 'X');
    assert.equal(map.y.name, 'Y');
    assert.equal(map.z, undefined);
  });
});

// ---- New coverage tests below ----

function makeFeedUrl(id) {
  return 'https://example.com/' + id + '.xml';
}

function makeThreeItemPlatform() {
  const url = makeFeedUrl('nav');
  return createPlatform({
    prefs: {
      feeds: [
        { id: 'nav', tag: 'NAV', name: 'Nav Feed', url: url }
      ]
    },
    listHeight: 2,
    feedMap: {
      [url]: makeRSS([
        { title: 'Item A', link: 'https://a.com', desc: 'A desc', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' },
        { title: 'Item B', link: 'https://b.com', desc: 'B desc', pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT' },
        { title: 'Item C', link: 'https://c.com', desc: 'C desc', pubDate: 'Tue, 05 Mar 2024 12:00:00 GMT' }
      ])
    }
  });
}

describe('moveCursor', function() {
  it('moves up and clamps at zero', function() {
    assert.equal(core.moveCursor(2, 'ArrowUp', 5), 1);
    assert.equal(core.moveCursor(0, 'k', 5), 0);
  });

  it('moves down and clamps at max', function() {
    assert.equal(core.moveCursor(2, 'ArrowDown', 5), 3);
    assert.equal(core.moveCursor(5, 'j', 5), 5);
  });

  it('handles page up and page down', function() {
    assert.equal(core.moveCursor(20, 'PageUp', 30), 5);
    assert.equal(core.moveCursor(0, 'PageUp', 30), 0);
    assert.equal(core.moveCursor(10, 'PageDown', 30), 25);
    assert.equal(core.moveCursor(25, 'PageDown', 30), 30);
  });

  it('handles home and end', function() {
    assert.equal(core.moveCursor(5, 'Home', 10), 0);
    assert.equal(core.moveCursor(5, 'g', 10), 0);
    assert.equal(core.moveCursor(5, 'End', 10), 10);
    assert.equal(core.moveCursor(5, 'G', 10), 10);
  });

  it('returns null for unrecognized keys', function() {
    assert.equal(core.moveCursor(0, 'x', 5), null);
    assert.equal(core.moveCursor(0, 'Enter', 5), null);
  });
});

describe('cloneFeeds', function() {
  it('clones an array of feeds', function() {
    const feeds = [
      { id: 'a', tag: 'A', name: 'A', url: 'http://a.com' },
      { id: 'b', tag: 'B', name: 'B', url: 'http://b.com' }
    ];
    const result = core.cloneFeeds(feeds);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], feeds[0]);
    assert.notEqual(result[0], feeds[0]);
  });

  it('returns empty array for null or undefined', function() {
    assert.deepEqual(core.cloneFeeds(null), []);
    assert.deepEqual(core.cloneFeeds(undefined), []);
  });
});

describe('trimText', function() {
  it('collapses whitespace and trims', function() {
    assert.equal(core.trimText('  hello   world  '), 'hello world');
  });

  it('truncates to maxLength', function() {
    assert.equal(core.trimText('abcdefgh', 5), 'abcde');
  });

  it('handles null and undefined', function() {
    assert.equal(core.trimText(null), '');
    assert.equal(core.trimText(undefined), '');
  });
});

describe('makeSlug', function() {
  it('converts text to a slug', function() {
    assert.equal(core.makeSlug('Hello World'), 'hello-world');
  });

  it('strips special characters', function() {
    assert.equal(core.makeSlug('News & Updates!'), 'news-updates');
  });

  it('returns feed for empty input', function() {
    assert.equal(core.makeSlug(''), 'feed');
    assert.equal(core.makeSlug('!!!'), 'feed');
  });
});

describe('normalizeFeeds', function() {
  it('normalizes valid feeds and counts invalid ones', function() {
    const result = core.normalizeFeeds([
      { name: 'Good', url: 'https://example.com/rss' },
      { name: 'Bad' },
      { name: 'Also Good', url: 'https://example.com/other' }
    ]);
    assert.equal(result.feeds.length, 2);
    assert.equal(result.invalidCount, 1);
    assert.ok(result.feeds[0].id);
    assert.ok(result.feeds[0].tag);
  });

  it('returns empty for non-array', function() {
    const result = core.normalizeFeeds(null);
    assert.equal(result.feeds.length, 0);
    assert.equal(result.invalidCount, 0);
  });
});

describe('normalizeFeedEntry', function() {
  it('generates suffixed ids for duplicates', function() {
    const usedIds = Object.create(null);
    const a = core.normalizeFeedEntry({ name: 'Feed', url: 'https://a.com/rss' }, 0, usedIds);
    const b = core.normalizeFeedEntry({ name: 'Feed', url: 'https://b.com/rss' }, 1, usedIds);
    assert.ok(a.id);
    assert.ok(b.id);
    assert.notEqual(a.id, b.id);
    assert.ok(b.id.match(/-2$/));
  });

  it('returns null for invalid entries', function() {
    const usedIds = Object.create(null);
    assert.equal(core.normalizeFeedEntry(null, 0, usedIds), null);
    assert.equal(core.normalizeFeedEntry({ name: 'No URL' }, 0, usedIds), null);
    assert.equal(core.normalizeFeedEntry({ name: 'Bad URL', url: 'ftp://x.com' }, 0, usedIds), null);
  });
});

describe('parseRSS', function() {
  it('skips items with no title', function() {
    const xml = '<?xml version="1.0"?><rss><channel>'
      + '<item><link>http://a.com</link><description>No title here</description></item>'
      + '<item><title>Has Title</title><link>http://b.com</link></item>'
      + '</channel></rss>';
    const items = core.parseRSS(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Has Title');
  });

  it('returns empty array for empty or non-RSS input', function() {
    assert.deepEqual(core.parseRSS(''), []);
    assert.deepEqual(core.parseRSS('not xml'), []);
  });

  it('parses Atom-style link href', function() {
    const xml = '<rss><channel><item><title>Atom Link</title>'
      + '<link href="http://atom.example.com/post" />'
      + '</item></channel></rss>';
    const items = core.parseRSS(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].link, 'http://atom.example.com/post');
  });

  it('reads dc:creator and dc:date fields', function() {
    const xml = '<rss><channel><item>'
      + '<title>DC Test</title><link>http://x.com</link>'
      + '<dc:creator>Jane</dc:creator>'
      + '<dc:date>2024-03-05T10:00:00Z</dc:date>'
      + '</item></channel></rss>';
    const items = core.parseRSS(xml);
    assert.equal(items[0].author, 'Jane');
    assert.equal(items[0].date.toISOString(), '2024-03-05T10:00:00.000Z');
  });

  it('caps items at MAX_ITEMS', function() {
    let itemsXml = '';
    for (let i = 0; i < 60; i++) {
      itemsXml += '<item><title>Item ' + i + '</title><link>http://x.com/' + i + '</link></item>';
    }
    const xml = '<rss><channel>' + itemsXml + '</channel></rss>';
    const items = core.parseRSS(xml);
    assert.equal(items.length, core.MAX_ITEMS);
  });
});

describe('handleKey navigation', function() {
  it('moves cursor down with ArrowDown and j', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('ArrowDown');
    assert.equal(app.getView().state.cursor, 1);

    app.handleKey('j');
    assert.equal(app.getView().state.cursor, 2);

    // clamp at max
    app.handleKey('j');
    assert.equal(app.getView().state.cursor, 2);
  });

  it('moves cursor with PageUp and PageDown', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('End');
    assert.equal(app.getView().state.cursor, 2);

    app.handleKey('PageUp');
    assert.equal(app.getView().state.cursor, 0);

    app.handleKey('PageDown');
    assert.equal(app.getView().state.cursor, 2);
  });

  it('moves cursor to start with Home/g and end with End/G', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('G');
    assert.equal(app.getView().state.cursor, 2);

    app.handleKey('g');
    assert.equal(app.getView().state.cursor, 0);

    app.handleKey('End');
    assert.equal(app.getView().state.cursor, 2);

    app.handleKey('Home');
    assert.equal(app.getView().state.cursor, 0);
  });

  it('opens detail with Enter and Space', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('Enter');
    assert.equal(app.getView().state.detail, true);

    app.handleKey('Escape');
    assert.equal(app.getView().state.detail, false);

    app.handleKey(' ');
    assert.equal(app.getView().state.detail, true);
  });

  it('opens link with o key', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('o');
    assert.equal(harness.opens.length, 1);
    assert.equal(harness.opens[0], 'https://c.com');
  });

  it('navigates tabs with ArrowLeft/h and ArrowRight/l', async function() {
    const oneUrl = makeFeedUrl('one');
    const twoUrl = makeFeedUrl('two');
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'one', tag: 'ONE', name: 'One', url: oneUrl },
          { id: 'two', tag: 'TWO', name: 'Two', url: twoUrl }
        ]
      },
      feedMap: {
        [oneUrl]: makeRSS([{ title: 'S1', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]),
        [twoUrl]: makeRSS([{ title: 'S2', link: 'http://b.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT' }])
      }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // starts on 'all', go right to 'one'
    app.handleKey('ArrowRight');
    assert.equal(app.getView().state.active, 'one');

    app.handleKey('l');
    assert.equal(app.getView().state.active, 'two');

    // can't go further right
    app.handleKey('ArrowRight');
    assert.equal(app.getView().state.active, 'two');

    app.handleKey('ArrowLeft');
    assert.equal(app.getView().state.active, 'one');

    app.handleKey('h');
    assert.equal(app.getView().state.active, 'all');

    // can't go further left
    app.handleKey('h');
    assert.equal(app.getView().state.active, 'all');
  });

  it('refreshes feeds with r key', async function() {
    const url = makeFeedUrl('rf');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'rf', tag: 'RF', name: 'RF', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();
    const fetchesBefore = harness.fetches.length;

    app.handleKey('r');
    // r triggers async refreshAll; just check that a fetch was initiated
    assert.equal(harness.fetches.length, fetchesBefore + 1);
  });
});

describe('handleKey detail mode', function() {
  it('opens link with o and Enter in detail mode', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('Enter');
    assert.equal(app.getView().state.detail, true);

    app.handleKey('o');
    assert.equal(harness.opens.length, 1);

    app.handleKey('Enter');
    assert.equal(harness.opens.length, 2);
  });

  it('navigates items with ArrowUp/k and ArrowDown/j in detail mode', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('Enter');
    assert.equal(app.getView().state.detail, true);
    assert.equal(app.getView().state.cursor, 0);

    app.handleKey('ArrowDown');
    assert.equal(app.getView().state.cursor, 1);

    app.handleKey('j');
    assert.equal(app.getView().state.cursor, 2);

    app.handleKey('ArrowUp');
    assert.equal(app.getView().state.cursor, 1);

    app.handleKey('k');
    assert.equal(app.getView().state.cursor, 0);
  });

  it('closes detail with q key', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('Enter');
    assert.equal(app.getView().state.detail, true);

    app.handleKey('q');
    assert.equal(app.getView().state.detail, false);
  });
});

describe('handleKey filter mode', function() {
  it('removes characters with Backspace', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('/');
    app.handleKey('A');
    app.handleKey('B');
    assert.equal(app.state.filter, 'AB');

    app.handleKey('Backspace');
    assert.equal(app.state.filter, 'A');

    app.handleKey('Backspace');
    assert.equal(app.state.filter, '');
  });
});

describe('getView meta helpers', function() {
  it('exposes trunc, pad, esc, wrap, fmtAge, fmtFull via meta', async function() {
    const url = makeFeedUrl('meta');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'meta', tag: 'M', name: 'Meta', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();
    const meta = app.getView().meta;

    // trunc
    assert.equal(meta.trunc('abcdefgh', 6), 'abc...');
    assert.equal(meta.trunc('abc', 6), 'abc');
    assert.equal(meta.trunc(null, 5), '');

    // pad
    assert.equal(meta.pad('hi', 5), 'hi   ');
    assert.equal(meta.pad('hello', 3), 'hello');
    assert.equal(meta.pad(null, 3), '   ');

    // esc
    assert.equal(meta.esc('<b>A & B</b>'), '&lt;b&gt;A &amp; B&lt;/b&gt;');
    assert.equal(meta.esc(null), '');

    // wrap
    assert.deepEqual(meta.wrap('hello world foo', 8, 5), ['hello', 'world', 'foo']);
    assert.deepEqual(meta.wrap('', 10, 5), []);

    // wrap with maxLines limit
    assert.deepEqual(meta.wrap('a b c d e f', 3, 2), ['a b', 'c d']);

    // wrap with oversized word
    assert.deepEqual(meta.wrap('abcdefghij', 5, 3), ['abcde', 'fghij']);

    // fmtAge - distant date returns 'd' suffix
    var old = new Date(Date.now() - 3 * 86400 * 1000);
    assert.ok(meta.fmtAge(old).endsWith('d'));

    // fmtAge - recent date returns 'now'
    assert.equal(meta.fmtAge(new Date()), 'now');

    // fmtAge - hours
    var hoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    assert.ok(meta.fmtAge(hoursAgo).endsWith('h'));

    // fmtAge - minutes
    var minutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    assert.ok(meta.fmtAge(minutesAgo).endsWith('m'));

    // fmtFull
    assert.ok(meta.fmtFull(new Date('2024-03-05T10:00:00Z')).length > 0);
    assert.equal(meta.fmtFull('not a date'), '');
    assert.equal(meta.fmtFull(new Date('invalid')), '');
  });
});

describe('syncScroll and visibleItems', function() {
  it('adjusts scroll when cursor moves beyond visible area', async function() {
    const harness = makeThreeItemPlatform(); // listHeight=2, 3 items
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // cursor at 0, scroll at 0, listHeight 2 -> visible [0,1]
    let view = app.getView();
    assert.equal(view.visibleItems.length, 2);
    assert.equal(view.state.scroll, 0);

    // move cursor to item 2 (beyond visible area)
    app.handleKey('G');
    view = app.getView();
    assert.equal(view.state.cursor, 2);
    assert.equal(view.state.scroll, 1); // scroll adjusts to show cursor

    // move cursor back to 0
    app.handleKey('g');
    view = app.getView();
    assert.equal(view.state.cursor, 0);
    assert.equal(view.state.scroll, 0);
  });
});

describe('createApp edge cases', function() {
  it('handles loadPrefs that throws', function() {
    const harness = createPlatform({});
    harness.platform.loadPrefs = function() { throw new Error('corrupt'); };
    const app = core.createApp(harness.platform);
    // should fall back to defaults
    assert.ok(app.state.feeds.length > 0);
  });

  it('works when savePrefs is not a function', async function() {
    const url = makeFeedUrl('nosave');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'nosave', tag: 'NS', name: 'NoSave', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    harness.platform.savePrefs = undefined;
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // should not throw when activating a feed (which calls savePrefs internally)
    app.handleKey('1');
    assert.equal(app.getView().state.active, 'nosave');
  });

  it('handles savePrefs that throws', async function() {
    const url = makeFeedUrl('saveerr');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'saveerr', tag: 'SE', name: 'SaveErr', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    harness.platform.savePrefs = function() { throw new Error('disk full'); };
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // should not throw
    app.handleKey('1');
    assert.equal(app.getView().state.active, 'saveerr');
  });

  it('returns default listHeight when getListHeight returns non-finite', async function() {
    const url = makeFeedUrl('lh');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'lh', tag: 'LH', name: 'LH', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    harness.platform.getListHeight = function() { return NaN; };
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    assert.equal(app.getView().listHeight, 35);
  });

  it('openCurrentItem does nothing when there is no item', async function() {
    const url = makeFeedUrl('empty');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'empty', tag: 'E', name: 'Empty', url: url }] },
      feedMap: { [url]: makeRSS([]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.openCurrentItem();
    assert.equal(harness.opens.length, 0);
  });

  it('openCurrentItem does nothing when openURL is not a function', async function() {
    const url = makeFeedUrl('noopen');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'noopen', tag: 'NO', name: 'NoOpen', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    harness.platform.openURL = undefined;
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.openCurrentItem();
    // no crash, no opens
    assert.equal(harness.opens.length, 0);
  });

  it('openCurrentItem uses browser status message in browser mode', async function() {
    const url = makeFeedUrl('browser');
    const harness = createPlatform({
      mode: 'browser',
      prefs: { feeds: [{ id: 'browser', tag: 'BR', name: 'Browser', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.openCurrentItem();
    assert.equal(harness.opens.length, 1);
    // verify a render happened with the browser status message
    const lastRender = harness.renders[harness.renders.length - 1];
    assert.equal(lastRender.statusMsg, 'Opening link...');
  });

  it('replaceConfig without refresh returns a resolved promise', async function() {
    const url = makeFeedUrl('norf');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'norf', tag: 'NR', name: 'NoRefresh', url: url }] },
      feedMap: { [url]: makeRSS([]) }
    });
    const app = core.createApp(harness.platform);
    const fetchesBefore = harness.fetches.length;

    await app.replaceConfig({
      feeds: [{ name: 'New', url: 'https://new.example.com/rss' }]
    });

    // no new fetches happened
    assert.equal(harness.fetches.length, fetchesBefore);
  });

  it('getView returns activeError when switched to a failed feed', async function() {
    const okUrl = makeFeedUrl('ok');
    const badUrl = makeFeedUrl('bad');
    const harness = createPlatform({
      prefs: {
        feeds: [
          { id: 'ok', tag: 'OK', name: 'OK', url: okUrl },
          { id: 'bad', tag: 'BAD', name: 'Bad', url: badUrl }
        ]
      },
      feedMap: {
        [okUrl]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]),
        [badUrl]: new Error('HTTP 503')
      }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // switch to the bad feed
    app.handleKey('2');
    const view = app.getView();
    assert.equal(view.state.active, 'bad');
    assert.equal(view.activeError, 'HTTP 503');
  });

  it('selectIndex handles empty items list', async function() {
    const url = makeFeedUrl('emptysi');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'emptysi', tag: 'E', name: 'Empty', url: url }] },
      feedMap: { [url]: makeRSS([]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.selectIndex(5, { openDetail: true });
    const view = app.getView();
    assert.equal(view.state.cursor, 0);
    assert.equal(view.state.detail, false);
  });

  it('handles quit key with quit function', async function() {
    const url = makeFeedUrl('quit');
    let quitCalled = false;
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'quit', tag: 'Q', name: 'Quit', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    harness.platform.quit = function() { quitCalled = true; };
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('q');
    assert.equal(quitCalled, true);
  });

  it('createApp throws when platform is missing required methods', function() {
    assert.throws(function() { core.createApp(null); }, /requires a platform/);
    assert.throws(function() { core.createApp({}); }, /requires a platform/);
    assert.throws(function() { core.createApp({ fetchXML: function() {} }); }, /requires a platform/);
  });

  it('getView hintKeys differ between list and detail mode', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    const listHints = app.getView().hintKeys;
    assert.ok(listHints.includes('[q] quit'));
    assert.ok(listHints.includes('[/] filter'));

    app.handleKey('Enter');
    const detailHints = app.getView().hintKeys;
    assert.ok(detailHints.includes('[esc/q] back'));
  });

  it('activateFeed ignores unknown feed id', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.activateFeed('nonexistent');
    assert.equal(app.getView().state.active, 'all');
  });

  it('works when loadPrefs is not provided', function() {
    const harness = createPlatform({});
    harness.platform.loadPrefs = 'not a function';
    const app = core.createApp(harness.platform);
    assert.ok(app.state.feeds.length > 0);
  });

  it('selectIndex with toggleDetailOnSame opens detail on same index', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // cursor is already at 0, select same index with toggleDetailOnSame
    app.selectIndex(0, { toggleDetailOnSame: true });
    assert.equal(app.getView().state.detail, true);
  });

  it('replaceConfig with invalid feeds shows notice via applyConfig', async function() {
    const url = makeFeedUrl('notice');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'notice', tag: 'N', name: 'Notice', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // replace with a mix of valid and invalid feeds to trigger notice
    await app.replaceConfig({
      feeds: [
        { name: 'Good', url: 'https://good.com/rss' },
        { name: 'Bad' }
      ]
    });

    const lastRender = harness.renders[harness.renders.length - 1];
    assert.equal(lastRender.statusMsg, 'Some feeds were ignored.');
  });

  it('q key does nothing in browser mode', async function() {
    const url = makeFeedUrl('qbr');
    const harness = createPlatform({
      mode: 'browser',
      prefs: { feeds: [{ id: 'qbr', tag: 'Q', name: 'QBR', url: url }] },
      feedMap: { [url]: makeRSS([{ title: 'T', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' }]) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // q in browser mode should not quit, just render
    app.handleKey('q');
    // no crash, still active
    assert.equal(app.getView().state.active, 'all');
  });

  it('ArrowUp and k move cursor up in normal mode', async function() {
    const harness = makeThreeItemPlatform();
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    app.handleKey('G'); // go to end
    assert.equal(app.getView().state.cursor, 2);

    app.handleKey('ArrowUp');
    assert.equal(app.getView().state.cursor, 1);

    app.handleKey('k');
    assert.equal(app.getView().state.cursor, 0);
  });

  it('syncScroll clamps cursor when items shrink', async function() {
    const url = makeFeedUrl('shrink');
    let items = [
      { title: 'A', link: 'http://a.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 10:00:00 GMT' },
      { title: 'B', link: 'http://b.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 11:00:00 GMT' },
      { title: 'C', link: 'http://c.com', desc: 'd', pubDate: 'Tue, 05 Mar 2024 12:00:00 GMT' }
    ];
    const harness = createPlatform({
      listHeight: 2,
      prefs: { feeds: [{ id: 'shrink', tag: 'S', name: 'Shrink', url: url }] },
      feedMap: { [url]: makeRSS(items) }
    });
    const app = core.createApp(harness.platform);
    await app.refreshAll();

    // move cursor to end
    app.handleKey('G');
    assert.equal(app.getView().state.cursor, 2);

    // now refresh with fewer items - cursor should clamp
    harness.platform.fetchXML = function() {
      return Promise.resolve(makeRSS([items[0]]));
    };
    await app.refreshAll();

    const view = app.getView();
    assert.equal(view.state.cursor, 0);
    assert.equal(view.state.scroll, 0);
  });

  it('getConfig returns persisted config shape', async function() {
    const url = makeFeedUrl('gc');
    const harness = createPlatform({
      prefs: { feeds: [{ id: 'gc', tag: 'GC', name: 'GetConfig', url: url }] },
      feedMap: { [url]: makeRSS([]) }
    });
    const app = core.createApp(harness.platform);

    const config = app.getConfig();
    assert.equal(config.active, 'all');
    assert.equal(config.feeds.length, 1);
    assert.equal(config.feeds[0].id, 'gc');
  });
});

describe('normalizeCatalogFeed edge cases', function() {
  it('derives id from tag/name when id is empty after normalization', function() {
    const usedIds = Object.create(null);
    const result = core.normalizeCatalogFeed({
      name: 'My Feed',
      url: 'https://example.com/rss'
    }, usedIds);

    assert.ok(result);
    assert.ok(result.id.length > 0);
  });
});
