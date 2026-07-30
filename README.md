# PYRo Wiki platform workspace

This directory contains the development and deployment platform for the shared Wiki. It is intentionally kept outside the documentation-site Git repository.

```text
platform/
├─ apps/vscode-extension/   # VS Code extension source and tests
├─ workers/api/             # Cloudflare Worker source and tests
├─ infra/cloudflare/        # Wrangler configuration
├─ migrations/              # D1 migrations
└─ scripts/                 # local/production smoke checks
```

The documentation site itself is the sibling `PYRo-Wiki/` directory. The extension pulls that site through the Worker; the site repository does not contain Worker or extension source code.

Run platform checks from this directory:

```powershell
npm run typecheck
npm test
npm run build
```
