# PYRo Wiki API

The Worker serves authenticated document sync and Yjs collaboration. Development uses `infra/cloudflare/wrangler.api.jsonc`; production uses `infra/cloudflare/wrangler.api.prod.jsonc` and the custom domain `https://pyro-wiki-api.luckyy.ccwu.cc`.

## Production secrets

Configure these only through Wrangler Secret Store; never commit them:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `AUTH_SESSION_SECRET`
- `FEISHU_TENANT_KEY` (optional internal-tenant restriction)

The Feishu callback URL is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback
```

The production database must be created and its ID inserted into the production Wrangler config before applying remote migrations.

## Production deployment

```powershell
npx wrangler deploy `
  --config .\infra\cloudflare\wrangler.api.prod.jsonc `
  --domain pyro-wiki-api.luckyy.ccwu.cc
```

The public health endpoint is `GET https://pyro-wiki-api.luckyy.ccwu.cc/health`; it returns `503` when the Worker cannot reach D1. Document and collaboration endpoints require a Feishu-backed Bearer access token. WebSocket clients authenticate during the Worker upgrade; tokens are not placed in query parameters.

## Local API integration smoke

From the repository root, run:

```powershell
npm run smoke:local-api
```

This starts the development Worker with local D1 persistence, applies migrations to an isolated `.wrangler/smoke-local` directory, and verifies document creation, pull, revision history, drafts, and stale-revision conflicts.

The local collaboration protocol can be checked with:

```powershell
npm run smoke:local-collaboration
```

This opens two local WebSocket clients and verifies initial Yjs sync, incremental updates, connection-scoped Presence, and offline Presence events.

The local session lifecycle can be checked with:

```powershell
npm run smoke:local-auth
```

It uses only fake local credentials and verifies one-time handoff exchange, `/me`, refresh-token rotation, logout, and session revocation.

To verify the production D1 schema without printing document or user data:

```powershell
npm run check:production-d1
```

Authentication housekeeping prunes expired OAuth states, handoff codes, and revoked/expired sessions during authentication flows. Production internal-tenant mode also requires a Feishu tenant key.


## Production route summary

| Route | Purpose | Authentication |
| --- | --- | --- |
| `GET /health` | Worker and D1 readiness check | Public |
| `GET /auth/feishu/start` | Start Feishu OAuth | Public |
| `GET /auth/feishu/callback` | Validate OAuth state and create one-time handoff | Feishu callback |
| `POST /auth/session/exchange` | Exchange handoff for access/refresh tokens | Handoff code |
| `POST /auth/session/refresh` | Atomically rotate a refresh session | Refresh token |
| `POST /auth/logout` | Revoke the current access session | Bearer access token |
| `GET /me` | Return the authenticated Feishu user | Bearer access token |
| `GET /documents` | List cloud documents | Bearer access token |
| `GET /documents/{path}` | Pull one cloud document | Bearer access token |
| `PUT /documents/{path}` | Publish a new revision | Bearer access token |
| `POST /documents/{path}/drafts` | Save a draft revision | Bearer access token |
| `GET /documents/{path}/revisions` | List revision history | Bearer access token |
| `POST /documents/{path}/revisions/{revision}/restore` | Restore a historical revision as a new revision | Bearer access token |
| `GET /collaboration/{path}` | Upgrade to authenticated Yjs WebSocket | Bearer access token in upgrade headers |

The VS Code callback URI is `vscode://pyro-wiki.pyro-wiki-vscode-extension/auth/callback`. The production Feishu callback configured in the Feishu developer console must remain `https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback`.

## GitHub Pages publishing

The GitHub App installation must have `Contents: Read and write`, `Actions: Read and write`, and repository metadata read permission. A publish request writes the document through the Contents API, explicitly dispatches `.github/workflows/deploy.yml`, and remains `publishing` until the Pages workflow succeeds. Workflow permission failures are retained on the request as actionable errors.
