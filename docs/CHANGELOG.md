# Changelog

## [Unreleased]

### Added

- Import/export feeds in OPML (industry standard) and JSON formats.
- Terminal: `--export <path>` and `--import <path>` CLI flags for non-interactive feed backup, restore, and migration. `--help` flag documents usage.
- Browser: export and import buttons in the feed editor panel. Export downloads an OPML file; import opens a file picker accepting `.opml`, `.xml`, and `.json` files.
- Browser: add custom feed by URL in the feed editor. Type a feed URL and optional name, click "add", and it appears in the draft selection. Validates URL format and rejects duplicates.

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
- Hint bar uses arrow symbols and consolidates feed navigation into a single `[←→ hl 0-9] feed` hint.

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
