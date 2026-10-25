# Development

Requires Node.js 22+ and npm. Windows packaging also uses PowerShell 7 (`pwsh`).

```sh
npm ci --ignore-scripts
npm test
```

The only dependency is the development-only `jsdom`, pinned in the lockfile. Runtime relay modules use Node.js built-ins only. The test command enables VM modules to load the actual frontend entry point inside a simulated TT host.

The suite covers the scheduler, cancellation, full-stream permit ownership, rolling RPM, independent site quotas, authentication, protocol paths, automatic snapshot routing, native connection resynchronization, panel actions and 0.1 migration. Tests use local mock upstreams, without model credentials or paid generations.

```powershell
npm run package
```

Packaging uses an explicit source-file allowlist. It excludes `runtime/`, installed pairing files, dependencies, logs, Git metadata and development scratch files. ZIP and SHA-256 checksums are written under `dist/`.

GitHub Actions runs the same test suite on Windows and Linux with Node.js 22 and 24. A pushed `v*` tag builds a release archive after tests pass. The release job only needs the repository's built-in `GITHUB_TOKEN`.
