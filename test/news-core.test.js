'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const core = require('../news-core.js');

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
    assert.deepEqual(config.feeds, core.DEFAULT_FEEDS);
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
    assert.deepEqual(config.feeds, core.DEFAULT_FEEDS);
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
