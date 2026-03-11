# Changelog

## [Unreleased]

### Changed

- Terminal tabs line now windows gracefully when feeds overflow the terminal width, showing `<` / `>` indicators for hidden tabs.

### Fixed

- Terminal no longer flickers on every render — replaced full-screen erase with cursor-home and per-line clearing.

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
