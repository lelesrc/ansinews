'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fs = require('node:fs');
const path = require('node:path');
const core = require('../news-core.js');

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
