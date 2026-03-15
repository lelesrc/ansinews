# ansinews

[![CI](https://github.com/lelesrc/ansinews/actions/workflows/ci.yml/badge.svg)](https://github.com/lelesrc/ansinews/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ansinews)](https://www.npmjs.com/package/ansinews)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

A minimal RSS reader for terminal, web, and AI agents. Pure JavaScript, zero dependencies, no install needed.

[Try the live demo](https://ansinews.netlify.app/)

![Terminal](https://github.com/user-attachments/assets/f19e728b-d730-40b4-9c79-6610a441b5d4)

![Browser](https://github.com/user-attachments/assets/f943f256-804c-46eb-a28c-2387fc9034ba)

---

## What it does

ansinews pulls headlines from public RSS feeds and shows them in a keyboard-driven interface.
It runs in your terminal or in your browser, from the same codebase.

- **No install needed** — `npx ansinews` and start reading. No build step, no binary to download.
- **Runs in the browser too** — `npx ansinews --browser` opens the browser UI with a local server.
- **MCP server included** — let your AI agent read the news too. See [MCP](#mcp).
- **64 curated feeds** across 8 categories. Pick the ones you want from the built-in feed picker.
- **One shared core** — two thin platform shells, ~3,500 lines of application code split evenly three ways.
- **Privacy by default** — preferences stay local. A JSON file in terminal, localStorage in browser. Nothing phones home.

## Features

- Keyboard-driven navigation with vim-style bindings across both interfaces
- Built-in feed picker with search by name, category, or tag
- Add custom feeds by URL in the browser editor or by editing the config file
- Filter headlines in real time with `/`
- Detail view with article summary, author, and date
- Auto-refresh on a 5-minute cycle with a visible countdown
- OPML and JSON import/export for feed backup and migration
- MCP server (`mcp.js`) exposes feed tools over stdio for integration with agentic workflows
- `--browser` flag starts a local server with built-in CORS proxy and opens the browser UI
- Terminal CLI flags: `--import`, `--export`, `--add-feed`, `--browser`, `--help`
- Full test suite using Node's built-in test runner, no test dependencies

---

## Quick start

Run it directly, no install needed:

```sh
npx ansinews
```

Or install globally to get the `ansinews` command:

```sh
npm install -g ansinews
```

Or clone the repo:

```sh
git clone https://github.com/lelesrc/ansinews.git
cd ansinews
node terminal.js
```

> Requires Node.js 18+. Zero dependencies.

### Browser

```sh
npx ansinews --browser
```

This starts a local server with a built-in CORS proxy and opens the browser UI. Use `--port <number>` to change the default port (9001).

---

## Keys

| Key | Action |
|-----|--------|
| `↑` `k` / `↓` `j` | Move up / down |
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

## Feeds

Pick what you want from the feed picker, import your own, or edit the config directly:

- **Terminal:** `~/.ansinews/config.json` (a local `./.ansinews/config.json` in the working directory takes priority if present.)
- **Browser:** localStorage.

---

## Architecture

```
                  ┌───────────────────────────────────┐
                  │         ansinews-core.js          │
                  │                                   │
                  │  feeds · RSS parsing · app state  │
                  │  commands · sorting · view model  │
                  └───────┬──────────┬──────────┬─────┘
                          │          │          │
             ┌────────────┘          │          └────────────┐
             │                       │                       │
┌────────────▼────────────┐  ┌───────▼────────┐  ┌───────────▼──────────────┐
│      terminal.js        │  │    mcp.js      │  │  browser.js + index.html │
│                         │  │                │  │                          │
│  ANSI rendering         │  │  stdio server  │  │  DOM rendering           │
│  keyboard input         │  │  feed tools    │  │  localStorage            │
│  file I/O               │  │  agent access  │  │  click/key handling      │
│  HTTP fetch             │  │                │  │  browser fetch           │
└─────────────────────────┘  └────────────────┘  └──────────────────────────┘
```

The core does everything platform-independent. Each shell adapts it to its environment.

## Testing

```sh
npm test
```

Uses Node's built-in test runner. No test dependencies.

## MCP

An MCP server (`mcp.js`) is included for integration with agentic workflows. Run it with `npm run mcp`.

| Tool | Description |
|------|-------------|
| `list_feeds` | List all configured RSS feeds. |
| `add_feed` | Add a new RSS feed by name and URL. Optionally pass a tag and id. |
| `remove_feed` | Remove a feed by its id. |
| `read_news` | Fetch live headlines from configured feeds. Filter by feed id, search query, or limit. |

The MCP server reads and writes the same config as the terminal shell: `./.ansinews/config.json` in the working directory, falling back to `~/.ansinews/config.json`.

---

## How it compares

There are good terminal RSS readers out there. [Newsboat](https://newsboat.org/) is the most established, with support for podcasts, service sync, macros, and deep configuration. [nom](https://github.com/guyfedwards/nom) and [tuifeed](https://lib.rs/crates/tuifeed) offer polished TUIs with markdown rendering and backend integrations.

ansinews trades features for simplicity. No compile step, no runtime dependencies, no platform-specific binary. It works in the browser too, not just the terminal. The codebase is plain JavaScript you can audit easily, which matters if you care about knowing exactly what runs on your machine.

## How this started

I was testing my new end to end agentic workflow and needed a real project to try it on. At the same time, I was trying to read the news during dead time between test runs, and having a particularly bad time with ads making it impossible to just scan headlines.

A terminal RSS reader, simple enough to glance at the latest news without slaloming between pop-ups. A perfect test case.

A single prompt, and the workflow practically zero-shotted the whole thing. What you see here is 95% that first version, with some follow-up work to make it more usable and add what I forgot to mention in the prompt.

This is the prompt:

> *I want to create ansinews, a news terminal.
> News comes from major publicly available RSS feeds.
> The code is written in JavaScript with one shared core. The flagship product runs in the terminal,
> and a lightweight browser companion reuses that core.
> The UI should resemble a terminal, with a monospaced font, compact layout, and restrained color.
> The goal is to give access to the latest news in real time. It should offer the minimal features
> needed to filter and organize feeds and news items. It saves preferences locally in the terminal
> or in browser storage.
> The code has to stay minimal and lean with zero JavaScript dependencies.
> Usability is the most important aspect. It must be fast and intuitive, with a carefully crafted
> simple UI.*

### What I learned

- **Surprise:** Probably most of the code was already in the training data. My requirements were very much in line with existing terminal RSS readers, so the model had seen a lot of similar code (evidently, existing projects did a great job). Not surprising it got most of the core right on the first try. But both the UI (terminal and browser) were good and usable from the first version, and this was a surprise.

- **Zero dependencies:** We are no longer used to writing code for a lot of things we import (I'm talking before the AI era). We often overestimate (more precisely, we don't even try to estimate) the amount of code we need to write to get a basic feature working: we throw in a library (a library we are familiar with, which is another bias) and move on. But this exercise showed:
  - That you don't need React or whatever to write a simple, usable UI in the browser. I did not ask (yet) my agent to write a React version of browser.js, but it's not hard to imagine that the amount of LOCs would be much higher for the same result, leaving aside the React import itself and all the other bells and whistles. Not to say frameworks are useless today, but in 2026 maybe they should not be the default choice for every project.
  - That you don't necessarily need a library to do HTTP requests or work with XML. The built-in fetch is good enough for most use cases, and XML parsing can be done with DOMParser.
  - That you don't necessarily need a library to do testing. Node's built-in test runner is perfectly fine for a project of this size.
  - That you don't necessarily need TypeScript. You can write clean, maintainable code with good test coverage in plain JavaScript.
  - Basically, that you can import nothing and actually do things.
  - That lots of projects can, and should, [avoid](https://nvd.nist.gov/vuln/detail/CVE-2022-23812) [unnecessary](https://nvd.nist.gov/vuln/detail/CVE-2025-59144) [dependencies](https://nvd.nist.gov/vuln/detail/CVE-2025-10894).

- **Agentic workflows** require a lot of tuning to get right, but they can be shockingly effective. My current workflow is quite complex and top-heavy (lots of research and planning before any code is written) but it produces viable results even if the prompt is far from perfect (see "the prompt"). My impression is that code should take 20-25% of the workflow time; the rest is research, design, and testing (and a couple of gates to steer when needed). This is very different from how I used to work before, where code was more like 70% of the time (with an additional 80% of time spent re-stating the specs).

- **Philosophy:** I instructed the agents to use the project PHILOSOPHY.md to drive their choices. It does its job when the agent has to decide between A or B, and in my tests it resolved most of the questions (correctly) before asking me. YMMV.


## Contributing

ansinews is small on purpose. Contributions that keep it that way are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
