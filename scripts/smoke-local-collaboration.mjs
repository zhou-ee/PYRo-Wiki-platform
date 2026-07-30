import { spawn, spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const port = Number(process.env.PYRO_WIKI_LOCAL_COLLAB_PORT ?? 8789)
const baseUrl = `http://127.0.0.1:${port}`
const socketUrl = `ws://127.0.0.1:${port}/collaboration/docs%2Fcollab.md?workspace=collaboration-smoke`
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const persistTo = '.wrangler/smoke-collaboration'
const config = 'infra/cloudflare/wrangler.api.jsonc'
const args = ['dev', '--config', config, '--local', '--persist-to', persistTo, '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false']
const require = createRequire(import.meta.url)
const Y = require(resolve(root, 'apps/vscode-extension/node_modules/yjs'))

function assert(condition, message) { if (!condition) throw new Error(message) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function encode(value) { return Buffer.from(value).toString('base64') }
function decode(value) { return new Uint8Array(Buffer.from(value, 'base64')) }

async function waitForServer(child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local Worker exited before startup\n${logs.join('')}`)
    try { if ((await fetch(`${baseUrl}/health`)).status === 200) return } catch { /* starting */ }
    await sleep(500)
  }
  throw new Error(`local Worker did not start\n${logs.join('')}`)
}

function openSocket() {
  const socket = new WebSocket(socketUrl)
  const messages = []
  const waiters = []
  socket.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(String(event.data)) } catch { return }
    messages.push(message)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) {
        const waiter = waiters.splice(index, 1)[0]
        waiter.resolve(message)
      }
    }
  })
  const waitFor = (predicate, timeout = 5_000) => new Promise((resolve, reject) => {
    const existing = messages.find((message) => predicate(message))
    if (existing) return resolve(existing)
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for collaboration message; received=${JSON.stringify(messages.slice(-8))}`)), timeout)
    waiters.push({ predicate: (message) => predicate(message), resolve: (message) => { clearTimeout(timer); resolve(message) } })
  })
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Collaboration WebSocket error')), { once: true })
  })
  return { socket, messages, opened, waitFor }
}

async function main() {
  await rm(resolve(root, persistTo), { recursive: true, force: true })
  const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'pyro-wiki-dev', '--local', '--persist-to', persistTo, '--config', config], { cwd: root, input: 'y\n', encoding: 'utf8' })
  if (migration.status !== 0) throw new Error(`local D1 migration failed\n${migration.stdout ?? ''}\n${migration.stderr ?? ''}`)
  const logs = []
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', (error) => logs.push(`spawn error: ${error.message}\n`))
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  const stop = () => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  process.on('exit', stop)
  const sockets = []
  try {
    await waitForServer(child, logs)
    const firstDoc = new Y.Doc()
    firstDoc.getText('markdown').insert(0, 'hello')
    const first = openSocket(); sockets.push(first)
    await first.opened
    first.socket.send(JSON.stringify({ type: 'hello', state: encode(Y.encodeStateAsUpdate(firstDoc)) }))
    await first.waitFor((message) => message.type === 'sync')
    const firstPresence = await first.waitFor((message) => message.type === 'awareness' && message.status === 'online')
    assert(typeof firstPresence.presenceId === 'string', 'first presence ID is missing')

    const secondDoc = new Y.Doc()
    const second = openSocket(); sockets.push(second)
    await second.opened
    second.socket.send(JSON.stringify({ type: 'hello', state: encode(Y.encodeStateAsUpdate(secondDoc)) }))
    const sync = await second.waitFor((message) => message.type === 'sync')
    Y.applyUpdate(secondDoc, decode(sync.update), 'smoke-remote')
    assert(secondDoc.getText('markdown').toString() === 'hello', 'second client did not receive initial Yjs state')
    const secondPresence = await second.waitFor((message) => message.type === 'awareness' && message.status === 'online' && message.presenceId !== firstPresence.presenceId)
    assert(secondPresence.user === 'Development User', 'server did not provide authenticated development identity')

    let incrementalUpdate
    firstDoc.on('update', (update) => { incrementalUpdate = update })
    firstDoc.getText('markdown').insert(5, ' world')
    assert(incrementalUpdate instanceof Uint8Array, 'Yjs incremental update was not generated')
    first.socket.send(JSON.stringify({ type: 'update', update: encode(incrementalUpdate) }))
    const update = await second.waitFor((message) => message.type === 'update')
    Y.applyUpdate(secondDoc, decode(update.update), 'smoke-remote')
    assert(secondDoc.getText('markdown').toString() === 'hello world', 'second client did not receive incremental update')

    let largeUpdate
    firstDoc.once('update', (next) => { largeUpdate = next })
    firstDoc.getText('markdown').insert(firstDoc.getText('markdown').length, 'x'.repeat(100_000))
    assert(largeUpdate instanceof Uint8Array && largeUpdate.byteLength > 65_536, 'large Yjs update was not generated')
    first.socket.send(JSON.stringify({ type: 'update', update: encode(largeUpdate) }))
    const largeMessage = await second.waitFor((message) => message.type === 'update' && message.update.length > 65_536)
    Y.applyUpdate(secondDoc, decode(largeMessage.update), 'smoke-remote')
    assert(secondDoc.getText('markdown').length === firstDoc.getText('markdown').length, 'second client did not receive large incremental update')

    first.socket.close()
    const offline = await second.waitFor((message) => message.type === 'awareness' && message.status === 'offline' && message.presenceId === firstPresence.presenceId)
    assert(offline.user === 'Development User', 'offline presence did not identify the disconnected client')
    console.log(`PYRo Wiki local collaboration smoke passed: ${socketUrl}`)
  } finally {
    for (const item of sockets) { try { item.socket.close() } catch { /* already closed */ } }
    stop()
    await sleep(250)
  }
}

main().catch((error) => {
  console.error(`PYRo Wiki local collaboration smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
