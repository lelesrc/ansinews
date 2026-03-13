# ansinews

> The news, nothing else.

A minimal, zero-dependency RSS reader for terminal and web.
No ads. No tracking. No noise. Just your feeds.

## Why ansinews

Reading news on the web became impossible. Every site buries its content under pop-ups, tracking banners, autoplay videos, and ads that shift the page while you're reading.

ansinews strips all of that away. It pulls headlines from public RSS feeds and presents them in a fast, keyboard-driven interface — either in your terminal or in a browser. There are no accounts, no analytics, no dependencies to audit, and nothing phoning home.

- **Zero dependencies** — plain JavaScript, no npm packages, no build step
- **Two interfaces, one core** — a full terminal TUI and a lightweight browser companion share the same engine
- **Private by design** — no telemetry, no accounts, preferences stored locally
- **Small codebase** — easy to read, audit, fork, and trust

## Quick Start

### Terminal

```
git clone https://github.com/USER/ansinews.git
cd ansinews
node news.js
```

Requires Node.js 18+. No `npm install` needed — there are no dependencies.

### Browser

Open `index.html` in any modern browser. No server required.

## Usage

### Navigation

| Key | Action |
|-----|--------|
| `↑` `k` | Move up |
| `↓` `j` | Move down |
| `PgUp` `PgDn` | Scroll by page |
| `Home` `g` / `End` `G` | Jump to start / end |
| `←` `→` `h` `l` | Cycle feed tabs |
| `0`–`9` | Switch feed tab (0 = ALL) |
| `Enter` `Space` | Open detail view |
| `Esc` | Close detail / clear filter |
| `o` | Open link in browser |
| `/` | Filter headlines |
| `r` | Refresh all feeds |
| `f` | Open feed picker |
| `q` | Quit (terminal) |

### Feeds

ansinews ships with 6 default feeds (BBC, Guardian, NYT, Hacker News, NPR, Reuters) and a built-in catalog of 64 feeds across 8 categories: world, geopolitics, finance, technology, AI, engineering, security, and science.

Press `f` to open the feed picker. Search by name or category, toggle feeds with `Space`, and save your selection. Your choices persist between sessions.

### Configuration

**Terminal:** preferences are stored in `~/.ansinews/config.json` (or `./.ansinews/config.json` in the project directory).

**Browser:** preferences are stored in `localStorage`.

Both are plain JSON. You can edit the terminal config file directly to add custom feed URLs.

## Architecture

```
news-core.js    shared core — feeds, RSS parsing, state, commands, view model
news.js         terminal shell — ANSI rendering, keyboard input, file I/O
browser.js      browser shell — DOM rendering, localStorage, click/key handling
index.html      browser container and CSS
mcp.js          MCP server — exposes feed tools over stdio JSON-RPC 2.0
```

The core handles everything platform-independent. Each shell is a thin adapter for its environment. No code is shared between the shells except through the core.

## Project Principles

1. **Minimalism** — in design, implementation, and functionality
2. **Usability** — human-centered, not clever
3. **User control** — you choose your feeds and reading flow
4. **Privacy** — simple code, zero dependencies, anonymous usage

See [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) for the full philosophy.

## Testing

```
npm test
```

Uses Node's built-in test runner. No test dependencies.

## Contributing

ansinews is intentionally small. Contributions that preserve that character are welcome.

Before submitting changes:
- Run `npm test` and verify it passes
- Test the terminal shell with `node news.js`
- Test the browser shell by opening `index.html`
- Keep changes minimal and focused

## License

MIT
