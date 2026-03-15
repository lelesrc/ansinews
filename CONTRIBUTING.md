# Contributing to ansinews

ansinews is intentionally small. Contributions that preserve that character are welcome.

## Principles

Before contributing, read [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md). Every change should align with:

1. **Minimalism** — the smallest change that solves the problem
2. **Usability** — simple and obvious over clever
3. **User control** — the user decides what they read
4. **Privacy** — no telemetry, no accounts, no external services

## What we welcome

- Bug fixes
- Performance improvements that reduce complexity
- Feed compatibility fixes (RSS/Atom edge cases)
- Accessibility improvements
- Documentation corrections

## What we'll likely decline

- New dependencies
- Build steps or transpilation
- Features that add significant complexity for marginal benefit
- Analytics, tracking, or remote persistence
- UI changes that move away from the terminal aesthetic

## Before you submit

1. Run `npm test` and make sure it passes.
2. Test the terminal shell: `node terminal.js` — navigate, filter, refresh, open detail view.
3. Test the browser shell: open `index.html` — verify the same interactions.
4. If your change touches feed loading or parsing, verify at least one success and one failure path.

## Architecture

```
ansinews-core.js  shared core (feeds, parsing, state, commands)
terminal.js       terminal shell (ANSI rendering, keyboard, file I/O)
browser.js      browser shell (DOM rendering, localStorage, clicks)
index.html      browser container and CSS
```

- Shared behavior belongs in `ansinews-core.js`.
- Platform-specific I/O belongs in the shell files.
- Don't leak terminal escape codes into the core.
- Don't leak DOM concerns into the core.

## Style

- Plain JavaScript, no frameworks, ES5/ES2015 patterns.
- Small functions, explicit conditionals, low abstraction.
- Match the existing code style — read the file you're changing first.

## Submitting

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Open a pull request with a clear description of what and why.

Keep pull requests focused. One fix or feature per PR.
