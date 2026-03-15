# Changelog

## [Unreleased]

## [0.3.0] - 2026-03-15

### Added

- `ansinews --browser` starts a local HTTP server with a built-in CORS proxy and opens the browser UI. Use `--port <number>` to change the default port (9001). The browser shell auto-detects localhost and routes feed requests through the local proxy instead of an external CORS service.
- Browser: GitHub repository link in the header.
- Terminal auto-detects the terminal background color at startup via OSC 11 query, falling back to the `COLORFGBG` environment variable, then to dark. The correct dark or light theme is applied before the first render. Press `t` to override for the current session (not persisted).
- Day/night mode in the browser: respects OS `prefers-color-scheme` by default, with a manual toggle button in the header. Preference is persisted in browser storage.
- Light theme color palettes for both terminal and browser, tuned for WCAG 2.1 AA contrast (4.5:1 minimum for body text, 3:1 for UI chrome).
- Feed tag colors now adapt to the active theme in both shells, using darker/saturated variants on light backgrounds.
- Terminal: press `a` in the feed picker to add a custom feed by URL inline. Type the URL, press Enter to validate and auto-select it, or Escape to cancel.
- Import/export feeds in OPML (industry standard) and JSON formats.
- Terminal: `--export <path>` and `--import <path>` CLI flags for non-interactive feed backup, restore, and migration. `--help` flag documents usage.
- Browser: export and import buttons in the feed editor panel. Export downloads an OPML file; import opens a file picker accepting `.opml`, `.xml`, and `.json` files.
- Browser: add custom feed by URL in the feed editor. Type a feed URL and optional name, click "add", and it appears in the draft selection. Validates URL format and rejects duplicates.
- GitHub Actions CI workflow with test badge in README.
- Automated npm publish on GitHub release and Netlify deploy on push to main.
- npm version, license, and zero-dependencies badges in README.

### Fixed

- RSS headlines and OPML feed names now correctly decode numeric HTML entities (`&#x2018;`, `&#8217;`, etc.) instead of displaying raw codes.

### Changed

- Dark mode: bumped `--muted` and `--dim` colors for better contrast on dark backgrounds (5.5:1 and 3.4:1 respectively).
- Light mode: darkened cyan, green, and red accent colors so all text and feed tags meet 4.5:1 contrast on both `--bg` and `--bg2`.
- Light mode: header and active tab now use light-on-dark text to maintain contrast against their colored backgrounds.
- Terminal hint bar uses `⏎` symbol instead of `enter`, compacts feed navigation hint, and wraps gracefully on narrow terminals.
- Browser hint bar wraps on narrow viewports, keeping each shortcut–label pair on the same line.
- Browser CSS: replaced ~10 hardcoded hex color literals with CSS custom properties for full theme support. Extracted `--hdr-accent` variable for header accent color.
- Browser: cached `matchMedia` query at module level to avoid re-evaluating on every render tick.
- Browser: feed tag colors now use CSS classes instead of inline styles, enabling per-theme color switching.
- Terminal: color codes refactored from a flat constant object into swappable dark/light palette objects.
- Test suite expanded from 38 to 95 tests, improving ansinews-core.js coverage from 81% to 98% lines and 66% to 93% branches.

## [0.2.0] - 2026-03-13

### Added

- MCP server (`mcp.js`) exposes four tools over stdio JSON-RPC 2.0: `list_feeds`, `add_feed`, `remove_feed`, `read_news`. Zero dependencies, shares config and RSS parsing with the terminal shell.
- Browser feed editor now supports full keyboard navigation matching the terminal picker: `j`/`k` and arrow keys to navigate, `Space` to toggle, `/` to search, `Enter` to save, `Escape`/`q` to close, `PageUp`/`PageDown`/`Home`/`End`/`g`/`G` for fast movement.
- Press `f` in the browser to open the feed editor without clicking.
- Shared `moveCursor` helper in the core ensures consistent cursor navigation between terminal and browser shells.

### Fixed

- Terminal rendering no longer flickers on refresh; full-screen erase replaced with cursor-home rewrite.
- Browser feed editor scroll position no longer resets on the 1-second render tick; the overlay DOM is preserved when unchanged.
- Browser feed editor now retries catalog loading on reopen after a network failure.

### Changed

- Consolidated shared utility functions (`trimText`, `makeSlug`, `cloneFeed`, `cloneFeeds`, `sameFeed`, `normalizeCatalogFeed`, `normalizeCatalog`, `getCatalogMap`) from both shells into the core, removing ~150 lines of duplicated code and unifying inconsistent defaults.
- Catalog feed category default is now `Other` (was `OTHER` in terminal); category length limit is now 40 characters in both shells.
- Terminal feed tabs, detail panel, and hint bar now use subtle background fills for clearer visual hierarchy.
- Errored feed tabs are shown in bold red for better visibility against the new background.
- Terminal tabs line now windows gracefully when feeds overflow the terminal width, showing `<` / `>` indicators for hidden tabs.
- Left/right arrow keys and `h`/`l` now cycle through feed tabs, making all feeds keyboard-accessible beyond the `0-9` shortcuts.
- Hint bar uses arrow symbols and consolidates feed navigation into a single `[←→ hl] feed` hint.

## [0.1.0] - 2026-03-08

### Added

- Configurable RSS feeds now persist through a shared config model: the terminal reads `./.ansinews/config.json`, and the browser companion includes a minimal in-app feed editor backed by browser storage.
- A built-in automated test suite now covers shared core behaviors and runs with `npm test` using Node's built-in test runner.
- The browser companion now includes a searchable feed picker backed by `default_feeds.json`, so users can locate, select, and deselect bundled feeds while keeping the current default set on first run.
- The terminal UI now includes an in-app feed picker opened with `f`, so users can search the bundled `default_feeds.json` catalog, toggle feeds, and save selections without editing JSON by hand.
- GitHub launch files now include a contributor guide, code of conduct, issue templates, pull request template, and repository launch notes for the public release workflow.

### Changed

- The project name, visible app title, browser global, storage key, and terminal config directory now use `ansinews` consistently.
- The README and launch notes now reflect the current feed catalog size, use a safe repository URL placeholder, and avoid stale pre-rename copy.
