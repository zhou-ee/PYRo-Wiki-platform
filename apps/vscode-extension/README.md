# PYRo Wiki VS Code extension

This extension provides local VitePress preview, Markdown workspace navigation, Feishu-authenticated cloud document sync, and Yjs collaboration for PYRo Wiki.

## Production cloud API

The default API is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc
```

Override it with `pyroWiki.apiBaseUrl` for local development.

## Feishu login

Use `PYRo Wiki: Sign in with Feishu`. The browser authorization callback is:

```text
https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback
```

After authorization, the Worker returns a one-time handoff code to the VS Code URI handler. Long-lived refresh tokens are stored in VS Code SecretStorage, not in the repository or Webview URL.

## Cloud documents and collaboration

The PYRo Wiki activity bar includes: local Markdown documents, Cloud Documents, and Collaboration. Cloud Documents loads remote D1-backed revisions after login and shows whether each file is synced, remote-newer, local-newer, not pulled, or missing locally. Use `Search Cloud Documents`, `Pull`, `Push`, `Save Cloud Draft`, `View Cloud Revisions`, and `Compare Cloud Document` from the editor or Cloud Documents view. Collaboration connects the current Wiki Markdown document to the authenticated Durable Object/Yjs room, sends live Yjs updates, keeps editing locally during disconnects, and retries with exponential backoff. If a Push is interrupted by a network failure, use `PYRo Wiki: Retry Sync Queue` after connectivity returns.

## Initialize a new Wiki workspace

Open an empty folder in VS Code and run `PYRo Wiki: Initialize Wiki Workspace`. The command pulls the canonical shared Wiki snapshot through the configured PYRo Worker; it does not clone or pull GitHub directly. Existing workspaces offer `Pull and replace` or `Pull missing only` before any files are written.

The command requires Node.js/npm only when VitePress cannot be resolved from the pulled Wiki workspace or its parent node_modules directories and the user chooses `Run npm install`. A globally installed Node.js/npm toolchain is not the same as a workspace-resolvable VitePress dependency. Repository pulls are proxied through the Worker configured for the shared GitHub source.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package
# or install the current VSIX into the local VS Code instance
npm run install-local
```

The full preview command starts the Wiki workspace's own VitePress development server.

## Invisible editing workflow

- Normal VS Code `Ctrl+S` only saves the local Markdown file. Realtime Yjs collaboration observes content changes directly; saving does not call a per-document draft or submit endpoint.
- Connected workspace edits are checkpointed to D1 by the Workspace Durable Object alarm and when the last collaborator leaves. The Approve command checkpoints the complete workspace before creating or approving a workspace publish batch.
- The status bar shows the current workspace synchronization state. Publishing uses one complete-workspace batch rather than a per-document submit action.
- The first real content edit (typing, paste, delete, undo, or redo) automatically joins authenticated Yjs collaboration. Cursor-only movement does not join.
- Maintainer-only publish actions are hidden unless the Worker reports `permissions.canPublish=true` for the signed-in Feishu user.
