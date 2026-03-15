'use strict';

var assert = require('node:assert/strict');
var { describe, it, beforeEach, afterEach } = require('node:test');
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var MCP_PATH = path.join(__dirname, '..', 'mcp.js');

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

function sendMessage(proc, msg) {
  var json = JSON.stringify(msg);
  var byteLen = Buffer.byteLength(json, 'utf8');
  proc.stdin.write('Content-Length: ' + byteLen + '\r\n\r\n' + json);
}

function readMessages(data) {
  var messages = [];
  var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  var offset = 0;

  while (offset < buf.length) {
    var sep = buf.indexOf('\r\n\r\n', offset);
    if (sep === -1) { break; }

    var header = buf.slice(offset, sep).toString('ascii');
    var match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { break; }

    var bodyLen = parseInt(match[1], 10);
    var bodyStart = sep + 4;
    if (buf.length < bodyStart + bodyLen) { break; }

    var body = buf.slice(bodyStart, bodyStart + bodyLen).toString('utf8');
    messages.push(JSON.parse(body));
    offset = bodyStart + bodyLen;
  }

  return messages;
}

function spawnMCP(options) {
  var opts = options || {};
  var env = Object.assign({}, process.env);
  var cwd = opts.cwd || os.tmpdir();

  return cp.spawn(process.execPath, [MCP_PATH], {
    cwd: cwd,
    env: env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function mcpSession(options) {
  return new Promise(function(resolve, reject) {
    var proc = spawnMCP(options);
    var stdout = [];
    var timeout;

    proc.stdout.on('data', function(chunk) {
      stdout.push(chunk);
    });

    proc.on('error', reject);
    proc.on('close', function() {
      clearTimeout(timeout);
      var messages = readMessages(Buffer.concat(stdout));
      resolve(messages);
    });

    sendMessage(proc, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} }
    });
    sendMessage(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

    var sends = options && options.messages ? options.messages : [];
    var nextId = 2;
    sends.forEach(function(msg) {
      if (msg.id === undefined) { msg.id = nextId++; }
      msg.jsonrpc = '2.0';
      sendMessage(proc, msg);
    });

    timeout = setTimeout(function() {
      proc.stdin.end();
    }, 200);

    setTimeout(function() {
      proc.kill();
    }, 5000);
  });
}

describe('mcp server', function() {
  var tmpDir;
  var configDir;
  var configPath;

  beforeEach(function() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansinews-mcp-test-'));
    configDir = path.join(tmpDir, '.ansinews');
    configPath = path.join(configDir, 'config.json');
  });

  afterEach(function() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns server info on initialize', async function() {
    var messages = await mcpSession({ cwd: tmpDir, messages: [] });
    var init = messages.find(function(m) { return m.id === 1; });

    assert.ok(init);
    assert.equal(init.result.serverInfo.name, 'ansinews');
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.ok(init.result.capabilities.tools);
  });

  it('lists all four tools', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{ method: 'tools/list', params: {} }]
    });
    var list = messages.find(function(m) { return m.id === 2; });
    var names = list.result.tools.map(function(t) { return t.name; }).sort();

    assert.deepEqual(names, ['add_feed', 'list_feeds', 'read_news', 'remove_feed']);
  });

  it('list_feeds returns default feeds when no config exists', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'list_feeds', arguments: {} }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });
    var feeds = JSON.parse(result.result.content[0].text);

    assert.equal(feeds.length, 6);
    assert.equal(feeds[0].id, 'bbc');
  });

  it('list_feeds returns configured feeds from config file', async function() {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      active: 'all',
      feeds: [
        { id: 'test', tag: 'TEST', name: 'Test Feed', url: 'https://example.com/feed.xml' }
      ]
    }));

    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'list_feeds', arguments: {} }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });
    var feeds = JSON.parse(result.result.content[0].text);

    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].id, 'test');
    assert.equal(feeds[0].name, 'Test Feed');
  });

  it('add_feed creates config and adds a feed', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: {
          name: 'add_feed',
          arguments: { name: 'Hacker News', url: 'https://hnrss.org/frontpage' }
        }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });
    var text = result.result.content[0].text;

    assert.ok(text.includes('Added feed'));
    assert.ok(!result.result.isError);

    var saved = JSON.parse(fs.readFileSync(path.join(tmpDir, '.ansinews', 'config.json'), 'utf8'));
    assert.ok(saved.feeds.some(function(f) { return f.url === 'https://hnrss.org/frontpage'; }));
  });

  it('add_feed rejects invalid URL', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: {
          name: 'add_feed',
          arguments: { name: 'Bad Feed', url: 'not-a-url' }
        }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });

    assert.equal(result.result.isError, true);
    assert.ok(result.result.content[0].text.includes('Error'));
  });

  it('add_feed rejects missing name', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: {
          name: 'add_feed',
          arguments: { url: 'https://example.com/feed.xml' }
        }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });

    assert.equal(result.result.isError, true);
    assert.ok(result.result.content[0].text.includes('name and url are required'));
  });

  it('remove_feed removes an existing feed', async function() {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      active: 'all',
      feeds: [
        { id: 'one', tag: 'ONE', name: 'Feed One', url: 'https://example.com/one.xml' },
        { id: 'two', tag: 'TWO', name: 'Feed Two', url: 'https://example.com/two.xml' }
      ]
    }));

    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'remove_feed', arguments: { id: 'one' } }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });
    var text = result.result.content[0].text;

    assert.ok(text.includes('Removed'));
    assert.ok(text.includes('1 feed(s) remaining'));

    var saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.feeds.length, 1);
    assert.equal(saved.feeds[0].id, 'two');
  });

  it('remove_feed returns error for unknown id', async function() {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      active: 'all',
      feeds: [
        { id: 'one', tag: 'ONE', name: 'Feed One', url: 'https://example.com/one.xml' }
      ]
    }));

    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'remove_feed', arguments: { id: 'nope' } }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });

    assert.equal(result.result.isError, true);
    assert.ok(result.result.content[0].text.includes('no feed with id'));
  });

  it('remove_feed resets active when removing the active feed', async function() {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      active: 'one',
      feeds: [
        { id: 'one', tag: 'ONE', name: 'Feed One', url: 'https://example.com/one.xml' },
        { id: 'two', tag: 'TWO', name: 'Feed Two', url: 'https://example.com/two.xml' }
      ]
    }));

    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'remove_feed', arguments: { id: 'one' } }
      }]
    });

    var saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.active, 'all');
  });

  it('returns error for unknown tool', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{
        method: 'tools/call',
        params: { name: 'nonexistent', arguments: {} }
      }]
    });
    var result = messages.find(function(m) { return m.id === 2; });

    assert.ok(result.error);
    assert.equal(result.error.code, -32601);
  });

  it('returns error for unknown method', async function() {
    var messages = await mcpSession({
      cwd: tmpDir,
      messages: [{ method: 'resources/list', params: {} }]
    });
    var result = messages.find(function(m) { return m.id === 2; });

    assert.ok(result.error);
    assert.equal(result.error.code, -32601);
  });
});
