const base = 'http://127.0.0.1:8793'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
const root = resolve(process.cwd())
const require = createRequire(import.meta.url)
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const persistTo = '.wrangler/workspace-publish-smoke'
await rm(resolve(root, persistTo), { recursive: true, force: true })
const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'pyro-wiki-dev', '--local', '--persist-to', persistTo, '--config', 'infra/cloudflare/wrangler.api.jsonc'], { cwd: root, input: 'y\n', encoding: 'utf8' })
if (migration.status !== 0) throw new Error(migration.stderr || migration.stdout)
const child = spawn(process.execPath, [wrangler, 'dev', '--config', 'infra/cloudflare/wrangler.api.jsonc', '--local', '--persist-to', persistTo, '--port', '8793', '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], { cwd: root, stdio: 'ignore' })
const stop = () => { if (child.exitCode === null) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) }
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) break } catch {} await new Promise((resolve) => setTimeout(resolve, 250)) }
  const workspace = `workspace-publish-${Date.now()}`
  const { WebSocket } = require(resolve(root, 'apps/vscode-extension/node_modules/ws'))
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/workspace-collaboration/${encodeURIComponent(workspace)}`)
  const messages = []
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
  const waitFor = async (predicate) => { for (let i = 0; i < 80; i++) { const found = messages.find(predicate); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error(`workspace message timeout: ${JSON.stringify(messages)}`) }
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'workspace-hello', workspaceId: workspace, clientId: 'publish-smoke', yClientId: 1, documentStateVectors: {}, manifestVersion: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const Y = require(resolve(root, 'apps/vscode-extension/node_modules/yjs'))
  const doc = new Y.Doc(); doc.getText('markdown').insert(0, '# Publish smoke\n')
  const initialUpdate = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  socket.send(JSON.stringify({ type: 'manifest-op', operationId: 'create-publish-smoke', operation: { kind: 'create', documentPath: 'docs/publish.md', content: '# Publish smoke\n', initialUpdate } }))
  // Deliberately checkpoint immediately, before waiting for the WebSocket ack.
  // The Durable Object must serialize the checkpoint after queued WebSocket messages.
  const checkpoint = await fetch(`${base}/workspace-collaboration/${encodeURIComponent(workspace)}?checkpoint=1`, { method: 'POST' })
  const checkpointBody = await checkpoint.text()
  if (!checkpoint.ok) throw new Error(`checkpoint failed ${checkpoint.status} ${checkpointBody}`)
  const checkpointPayload = JSON.parse(checkpointBody)
  if (checkpointPayload.manifestCount !== 1 || checkpointPayload.changedCount !== 1 || checkpointPayload.changedDocumentPaths?.[0] !== 'docs/publish.md') throw new Error(`checkpoint missed changed manifest operation: ${checkpointBody}`)
  await waitFor((message) => message.type === 'ack' && message.operationId === 'create-publish-smoke')
  socket.close()
  const batch = await fetch(`${base}/workspace-publish-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace }) })
  if (!batch.ok) throw new Error(`batch failed ${batch.status} ${await batch.text()}`)
  const payload = await batch.json()
  if (payload.batch?.status !== 'submitted' || payload.batch?.changedCount !== 1 || payload.batch?.changedDocumentPaths?.[0] !== 'docs/publish.md') throw new Error(`workspace batch did not contain the incremental diff: ${JSON.stringify(payload)}`)
  console.log('PYRo Wiki local workspace publish smoke passed')
} finally { stop(); await new Promise((resolve) => setTimeout(resolve, 300)) }
