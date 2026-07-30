import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { startLocalWorker, sleep, encode, decode, assert } from './smoke-local-realtime-common.mjs'
const root = resolve(process.cwd())
const require = createRequire(import.meta.url)
const Y = require(resolve(root, 'apps/vscode-extension/node_modules/yjs'))
const { WebSocket } = require(resolve(root, 'apps/vscode-extension/node_modules/ws'))

function makeClient(baseUrl, workspaceId, index) {
  const doc = new Y.Doc(); const messages = []; const waiters = []
  let socket
  const attach = () => {
    socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/workspace-collaboration/${encodeURIComponent(workspaceId)}`)
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()); messages.push(message)
      if (message.type === 'workspace-sync') for (const item of message.documentUpdates ?? []) Y.applyUpdate(doc, decode(item.update), 'remote')
      if (message.type === 'document-update' && message.documentPath === 'docs/adversarial.md') Y.applyUpdate(doc, decode(message.update), 'remote')
      for (let i = waiters.length - 1; i >= 0; i -= 1) if (waiters[i].predicate(message)) { const waiter = waiters.splice(i, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) }
    })
    return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  }
  const waitFor = (predicate, timeout = 10000) => new Promise((resolve, reject) => { const existing = messages.find(predicate); if (existing) return resolve(existing); const timer = setTimeout(() => reject(new Error(`client ${index} timeout`)), timeout); waiters.push({ predicate, resolve, timer }) })
  const hello = async () => { await attach(); socket.send(JSON.stringify({ type: 'workspace-hello', workspaceId, clientId: `adversarial-${index}`, yClientId: doc.clientID, documentStateVectors: { 'docs/adversarial.md': encode(Y.encodeStateVector(doc)) }, manifestVersion: 0 })); await waitFor((m) => m.type === 'workspace-sync') }
  const update = async (offset, text) => { let update; doc.once('update', (value) => { update = value }); doc.getText('markdown').insert(offset, text); const id = `u-${index}-${Date.now()}-${Math.random()}`; socket.send(JSON.stringify({ type: 'document-update', updateId: id, documentPath: 'docs/adversarial.md', update: encode(update), provenance: [{ start: offset, end: offset + text.length }] })); await waitFor((m) => m.type === 'ack' && m.updateId === id) }
  return { doc, get socket() { return socket }, messages, waitFor, hello, update, reconnect: async () => { try { socket.close() } catch {}; await sleep(100); await attach(); socket.send(JSON.stringify({ type: 'workspace-hello', workspaceId, clientId: `adversarial-${index}-reconnect`, yClientId: doc.clientID, documentStateVectors: { 'docs/adversarial.md': encode(Y.encodeStateVector(doc)) }, manifestVersion: 0 })); await waitFor((m) => m.type === 'workspace-sync') } }
}

async function main() {
  const worker = await startLocalWorker('workspace-adversarial-smoke', 8794)
  const clients = []; const workspaceId = `adversarial-${Date.now()}`
  try {
    for (let i = 0; i < 5; i += 1) { const client = makeClient(worker.baseUrl, workspaceId, i); clients.push(client); await client.hello() }
    const first = clients[0]; let initialUpdate; first.doc.once('update', (value) => { initialUpdate = value }); first.doc.getText('markdown').insert(0, 'base'); first.socket.send(JSON.stringify({ type: 'manifest-op', operationId: 'create-adversarial', operation: { kind: 'create', documentPath: 'docs/adversarial.md', content: 'base' } })); first.socket.send(JSON.stringify({ type: 'document-update', updateId: 'initial-adversarial', documentPath: 'docs/adversarial.md', update: encode(initialUpdate), provenance: [{ start: 0, end: 4 }] })); await first.waitFor((m) => m.type === 'ack' && m.updateId === 'initial-adversarial'); await sleep(300)
    for (let i = 1; i < clients.length; i += 1) { Y.applyUpdate(clients[i].doc, initialUpdate, 'seed') }
    await Promise.all(clients.map((client, index) => client.update(1, String.fromCharCode(65 + index))))
    await sleep(500)
    const values = clients.map((client) => client.doc.getText('markdown').toString())
    assert(values.every((value) => value.length === values[0].length), `concurrent clients diverged: ${values.join('|')}`)
    const merged = values[0].toLowerCase()
    for (const character of ['b', 'a', 's', 'e']) assert(merged.includes(character), 'base character was lost: ' + values.join('|'))
    await clients[2].reconnect()
    await clients[2].update(clients[2].doc.getText('markdown').length, '-offline-recovered')
    await sleep(300)
    const conflict = clients[3]
    conflict.socket.send(JSON.stringify({ type: 'manifest-op', operationId: 'conflict-create', operation: { kind: 'create', documentPath: 'docs/adversarial.md', content: 'conflict' } }))
    await conflict.waitFor((m) => m.type === 'workspace-conflict')
    clients.forEach((client) => { try { client.socket.close() } catch {} })
    console.log('PYRo Wiki local workspace adversarial smoke passed')
  } finally { clients.forEach((client) => { try { client.socket.close() } catch {} }); worker.stop(); await sleep(300) }
}
main().catch((error) => { console.error(`PYRo Wiki local workspace adversarial smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
