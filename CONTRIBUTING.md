# Contributing to OneAgent

Thank you for your interest in contributing to OneAgent!

## Getting Started

### Prerequisites

- Node.js >= 22
- Git

### Setup

```bash
git clone https://github.com/user/oneagent.git
cd oneagent
npm install
npx playwright install chromium
npm run build
```

### Verify Setup

```bash
npx vitest run        # All tests should pass
npx tsc --noEmit      # No type errors
node dist/index.js doctor  # Health check
```

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run tests: `npx vitest run`
4. Run type check: `npx tsc --noEmit`
5. Submit a pull request

## Code Style

- TypeScript strict mode
- Fail-closed security: when in doubt, deny
- Bare `catch` blocks must log the error (no silent swallowing)
- Use `getLogger()` from `src/core/logger.ts` for logging

## Testing

- Framework: vitest
- Config objects in tests must include `daemon: { port: 19420, autoStart: false }`
- Use the `makeTestConfig()` helper from `tests/helpers.ts`
- Browser tests mock Playwright via `vi.mock('playwright')`
- All tests must be deterministic (no timing-dependent assertions)

### Running Tests

```bash
npx vitest run                              # All tests
npx vitest run tests/unit/config.test.ts    # Specific test
npx vitest --watch                          # Watch mode
npx vitest run --coverage                   # With coverage
```

## Architecture Notes

- **Engine boundary**: All browser/skill operations go through Engine. Never bypass.
- **Policy boundary**: 9 security gates on every execution. Never skip gates.
- **Daemon boundary**: CLI connects to daemon via UDS. No direct engine access from CLI.
- **Storage boundary**: All data access through repositories. Never raw SQL.

## Pull Request Process

1. Ensure all tests pass
2. Update documentation if needed
3. Add tests for new functionality
4. Keep PRs focused — one feature or fix per PR
5. Write descriptive commit messages

## Security

If you discover a security vulnerability, please see [SECURITY.md](SECURITY.md) for responsible disclosure instructions. Do NOT open a public issue for security vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
