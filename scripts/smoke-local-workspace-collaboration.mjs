import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { startLocalWorker, sleep, encode, decode, assert } from './smoke-local-realtime-common.mjs'
const root = resolve(process.cwd())
const require = createRequire(import.meta.url)
const Y = require(resolve(root, 'apps/vscode-extension/node_modules/yjs'))
const { WebSocket } = require(resolve(root, 'apps/vscode-extension/node_modules/ws'))


async function checkpoint(baseUrl, workspaceId) {
  const response = await fetch(`${baseUrl}/workspace-collaboration/${encodeURIComponent(workspaceId)}?checkpoint=1`, { method: 'POST' })
  const body = await response.json()
  assert(response.status === 200 && body.ok === true, `workspace checkpoint failed: ${JSON.stringify(body)}`)
  return body
}

function client(baseUrl, workspaceId) {
  const doc = new Y.Doc()
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/workspace-collaboration/${encodeURIComponent(workspaceId)}`)
  const messages = []
  const waiters = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()); messages.push(message)
    for (let i = waiters.length - 1; i >= 0; i -= 1) if (waiters[i].predicate(message)) { const waiter = waiters.splice(i, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  const waitFor = (predicate, timeout = 8000) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('workspace message timeout')), timeout); const existing = messages.find(predicate); if (existing) { clearTimeout(timer); return resolve(existing) } waiters.push({ predicate, resolve, timer }) })
  const open = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const hello = async () => { await open; socket.send(JSON.stringify({ type: 'workspace-hello', workspaceId, clientId: `smoke-${Math.random()}`, yClientId: doc.clientID, documentStateVectors: {}, manifestVersion: 0 })); return waitFor((m) => m.type === 'workspace-sync') }
  return { doc, socket, waitFor, hello }
}

async function main() {
  const worker = await startLocalWorker('workspace-collaboration-smoke', 8792)
  const sockets = []
  try {
    const first = client(worker.baseUrl, 'workspace-smoke'); sockets.push(first)
    const second = client(worker.baseUrl, 'workspace-smoke'); sockets.push(second)
    await first.hello(); await second.hello()
    const firstDoc = first.doc.getText('markdown')
    firstDoc.insert(0, 'hello workspace')
    const operationId = `op-${Date.now()}`
    const initialUpdate = encode(Y.encodeStateAsUpdate(first.doc))
    first.socket.send(JSON.stringify({ type: 'manifest-op', operationId, operation: { kind: 'create', documentPath: 'docs/hello.md', content: 'hello workspace', initialUpdate } }))
    const remoteCreate = await second.waitFor((m) => m.type === 'manifest-op' && m.operationId === operationId)
    Y.applyUpdate(second.doc, decode(remoteCreate.operation.initialUpdate), 'smoke')
    assert(second.doc.getText('markdown').toString() === 'hello workspace', 'second client did not merge workspace bootstrap')
    await first.waitFor((m) => m.type === 'ack' && m.operationId === operationId)
    const afterCreate = await checkpoint(worker.baseUrl, 'workspace-smoke')
    assert(afterCreate.manifestCount === 1 && afterCreate.changedCount === 1 && afterCreate.changedDocumentPaths.includes('docs/hello.md'), 'create checkpoint did not report the changed document')
    const renameId = `op-${Date.now()}`
    first.socket.send(JSON.stringify({ type: 'manifest-op', operationId: renameId, operation: { kind: 'rename', from: 'docs/hello.md', to: 'docs/renamed.md' } }))
    await second.waitFor((m) => m.type === 'manifest-op' && m.operationId === renameId)
    const afterRename = await checkpoint(worker.baseUrl, 'workspace-smoke')
    assert(afterRename.manifestCount === 1 && afterRename.changedCount === 2 && afterRename.changedDocumentPaths.includes('docs/renamed.md'), 'rename checkpoint did not report both affected paths')
    const conflictId = `op-${Date.now()}`
    second.socket.send(JSON.stringify({ type: 'manifest-op', operationId: conflictId, operation: { kind: 'create', documentPath: 'docs/renamed.md', content: 'conflict' } }))
    await second.waitFor((m) => m.type === 'workspace-conflict')
    const deleteId = `op-${Date.now()}`
    first.socket.send(JSON.stringify({ type: 'manifest-op', operationId: deleteId, operation: { kind: 'delete', documentPath: 'docs/renamed.md' } }))
    await second.waitFor((m) => m.type === 'manifest-op' && m.operationId === deleteId)
    const afterDelete = await checkpoint(worker.baseUrl, 'workspace-smoke')
    assert(afterDelete.manifestCount === 0 && afterDelete.changedCount === 1 && afterDelete.changedDocumentPaths[0] === 'docs/renamed.md', 'delete checkpoint did not report the changed document')
    first.socket.close(); second.socket.close()
    console.log('PYRo Wiki local workspace collaboration smoke passed')
  } finally { for (const item of sockets) try { item.socket.close() } catch {} ; worker.stop(); await sleep(300) }
}
main().catch((error) => { console.error(`PYRo Wiki local workspace collaboration smoke failed: ${error.message}`); process.exitCode = 1 })
