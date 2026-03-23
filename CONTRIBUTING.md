# Contributing to Schrute

Thank you for contributing.

## Prerequisites

- Node.js 22 or newer
- Git
- Playwright Chromium: `npx playwright install chromium`

## Setup

```bash
git clone https://github.com/sheeki03/schrute.git
cd schrute
npm install
npm run build
```

## Verify Your Environment

```bash
npm run lint
npx vitest run
node bin/schrute.cjs doctor
```

## Development Expectations

- Keep changes focused. Prefer one feature or one fix per pull request.
- Add or update tests for behavioral changes.
- Update user-facing docs when behavior, flags, commands, or APIs change.
- Route execution, browser, and skill behavior through the engine and existing repositories instead of adding side paths.
- Keep error handling fail-closed. If an operation is unsafe or ambiguous, deny it and log the reason.

## Repo Hygiene

- Do not commit local assistant/editor instruction files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `COPILOT.md`, `.cursorrules`, or `.clinerules`.
- Do not commit personal experiment artifacts or generated local assets unless they are intentionally part of the product.
- Do not add package-manager lockfiles unless the project explicitly adopts one.

## Testing Notes

- Tests use Vitest.
- Prefer `makeTestConfig()` from `tests/helpers.ts` when a full config object is needed.
- Browser-facing tests should mock Playwright unless the test is explicitly integration or E2E.
- Keep tests deterministic. Avoid timing-sensitive assertions where possible.

## Useful Commands

```bash
npm run build
npm run lint
npx vitest run
npx vitest run tests/unit/engine.test.ts
npx vitest --watch
```

## Pull Requests

Before opening a pull request:

1. Run the relevant tests and type checks.
2. Update documentation if the change affects how Schrute is used or operated.
3. Review the diff for accidental local files or generated artifacts.
4. Write a clear pull request description explaining the behavior change and validation performed.

## Security Issues

If you discover a security vulnerability, follow [SECURITY.md](SECURITY.md). Do not open a public issue for undisclosed security bugs.

## License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0.
