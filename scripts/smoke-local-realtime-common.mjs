import { spawn, spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const require = createRequire(import.meta.url)
const Y = require(resolve(root, 'apps/vscode-extension/node_modules/yjs'))
const { WebSocket } = require(resolve(root, 'apps/vscode-extension/node_modules/ws'))
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const encode = (value) => Buffer.from(value).toString('base64')
export const decode = (value) => new Uint8Array(Buffer.from(value, 'base64'))
export function assert(condition, message) { if (!condition) throw new Error(message) }

export async function startLocalWorker(label, port) {
  const persistTo = `.wrangler/${label}`
  const config = 'infra/cloudflare/wrangler.api.jsonc'
  await rm(resolve(root, persistTo), { recursive: true, force: true })
  const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'pyro-wiki-dev', '--local', '--persist-to', persistTo, '--config', config], { cwd: root, input: 'y\n', encoding: 'utf8' })
  if (migration.status !== 0) throw new Error(`local D1 migration failed\n${migration.stdout ?? ''}\n${migration.stderr ?? ''}`)
  const logs = []
  const args = ['dev', '--config', config, '--local', '--persist-to', persistTo, '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false']
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  const stop = () => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local Worker exited before startup\n${logs.join('')}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.status === 200) return { child, stop, baseUrl: `http://127.0.0.1:${port}`, socketUrl: `ws://127.0.0.1:${port}/collaboration/docs%2Frealtime.md?workspace=${label}` }
    } catch { /* starting */ }
    await sleep(250)
  }
  stop()
  throw new Error(`local Worker did not start\n${logs.join('')}`)
}

export function openClient(socketUrl, doc = new Y.Doc()) {
  const socket = new WebSocket(socketUrl)
  const messages = []
  const waiters = []
  let syncReady = false
  const waitFor = (predicate, timeout = 8_000) => new Promise((resolve, reject) => {
    const existing = messages.find((message) => predicate(message))
    if (existing) return resolve(existing)
    const timer = setTimeout(() => reject(new Error('Timed out waiting for collaboration message')), timeout)
    waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message) } })
  })
  socket.on('message', (data) => {
    let message
    try { message = JSON.parse(data.toString()) } catch { return }
    messages.push(message)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) {
        const waiter = waiters.splice(index, 1)[0]
        waiter.resolve(message)
      }
    }
    if (message.type === 'sync') {
      if (message.update) Y.applyUpdate(doc, decode(message.update), 'smoke-remote')
      if (!syncReady && message.stateVector) {
        syncReady = true
        const update = Y.encodeStateAsUpdate(doc, decode(message.stateVector))
        socket.send(JSON.stringify({ type: 'sync', id: `sync-${Date.now()}-${Math.random()}`, update: encode(update) }))
      }
    } else if (message.type === 'update' && message.update) {
      Y.applyUpdate(doc, decode(message.update), 'smoke-remote')
    }
  })
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const hello = async () => {
    await opened
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: `smoke-${Math.random()}`, stateVector: encode(Y.encodeStateVector(doc)) }))
    await waitFor((message) => message.type === 'sync')
    await sleep(50)
  }
  const sendUpdate = (update, id = `update-${Date.now()}-${Math.random()}`) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'update', id, update: encode(update) })) }
  const updateText = (index, offset, value) => {
    let update
    doc.once('update', (next) => { update = next })
    doc.getText('markdown').insert(offset, value)
    assert(update instanceof Uint8Array, `client ${index} did not produce a Yjs update`)
    sendUpdate(update)
  }
  const close = () => { try { socket.close() } catch {} }
  return { socket, doc, messages, opened, hello, waitFor, sendUpdate, updateText, close }
}

export { Y }
