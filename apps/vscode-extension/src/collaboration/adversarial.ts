import * as path from 'node:path'
import * as vscode from 'vscode'
import * as Y from 'yjs'
import WebSocket from 'ws'
import type { AuthManager } from '../auth/session'

type TestMessage = { type?: string; update?: string; documentPath?: string; updateId?: string; operationId?: string; manifest?: Array<{ path: string }>; status?: string; presenceId?: string; error?: string }
const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'
const TEST_DOCUMENT = 'PYRo-uCtrl-Unity/Peripheral/__codex_navigation_probe.md'
const TEST_LABEL = 'Codex Navigation Probe'
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
const encode = (value: Uint8Array): string => Buffer.from(value).toString('base64')
const decode = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))
const randomId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
async function api<T>(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } }); if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`); return response.json() as Promise<T> }
async function waitForLivePage(url: string, predicate: (html: string, status: number) => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    await sleep(5_000)
    try {
      const response = await fetch(`${url}?adversarial=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } })
      const html = response.ok ? await response.text() : ''
      if (predicate(html, response.status)) return
    } catch {
      // GitHub Pages polling tolerates transient network failures.
    }
  }
  throw new Error(message)
}

class SimulatedClient implements vscode.Disposable {
  readonly doc = new Y.Doc()
  readonly messages: TestMessage[] = []
  private socket: WebSocket | undefined
  private readonly waiters: Array<{ predicate: (message: TestMessage) => boolean; resolve: (message: TestMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []

  constructor(private readonly baseUrl: string, private readonly workspaceId: string, private readonly token: string, private readonly index: number) {}

  private url(): string { return `${this.baseUrl.replace(/^http/, 'ws')}/workspace-collaboration/${encodeURIComponent(this.workspaceId)}` }
  private receive(message: TestMessage): void {
    this.messages.push(message)
    if (message.type === 'workspace-sync') for (const item of (message as TestMessage & { documentUpdates?: Array<{ update: string }> }).documentUpdates ?? []) if (item.update) Y.applyUpdate(this.doc, decode(item.update), 'adversarial-remote')
    if (message.type === 'document-update' && message.update) Y.applyUpdate(this.doc, decode(message.update), 'adversarial-remote')
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) if (this.waiters[index].predicate(message)) { const waiter = this.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message) }
  }
  async connect(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const socket = new WebSocket(this.url(), { headers: { authorization: `Bearer ${this.token}` } })
      this.socket = socket
      socket.on('message', (raw) => { try { this.receive(JSON.parse(String(raw)) as TestMessage) } catch { /* ignore malformed test messages */ } })
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
        socket.send(JSON.stringify({ type: 'workspace-hello', workspaceId: this.workspaceId, clientId: randomId(`adversarial-${this.index}`), yClientId: this.doc.clientID, documentStateVectors: { [TEST_DOCUMENT]: encode(Y.encodeStateVector(this.doc)) }, manifestVersion: 0 }))
        await this.waitFor((message) => message.type === 'workspace-sync')
        return
      } catch (error) {
        lastError = error
        socket.removeAllListeners()
        socket.close()
        this.socket = undefined
        if (attempt < 3) await sleep(1_000 * (attempt + 1))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  waitFor(predicate: (message: TestMessage) => boolean, timeout = 12_000): Promise<TestMessage> {
    const existing = this.messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`adversarial client ${this.index} timed out`)), timeout); this.waiters.push({ predicate, resolve, reject, timer }) })
  }
  send(message: Record<string, unknown>): void { assert(this.socket?.readyState === WebSocket.OPEN, `adversarial client ${this.index} is not connected`); this.socket.send(JSON.stringify(message)) }
  async close(): Promise<void> { if (!this.socket) return; const socket = this.socket; this.socket = undefined; socket.close(); await sleep(150) }
  dispose(): void { void this.close() }
}

export async function runProductionAdversarialTest(auth: AuthManager, output?: vscode.OutputChannel): Promise<{ workspaceId: string; documentPath: string }> {
  const token = await auth.getAccessToken()
  if (!token) throw new Error('No authenticated Feishu session is available for production adversarial testing')
  const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL).replace(/\/$/, '')
  const workspaceId = `__codex_adversarial_${Date.now()}`
  const clients = Array.from({ length: 5 }, (_, index) => new SimulatedClient(baseUrl, workspaceId, token, index))
  const log = (message: string): void => { output?.appendLine(`[adversarial] ${message}`) }
  try {
    log(`workspace=${workspaceId}`)
    for (const client of clients) await client.connect()
    const first = clients[0]
    let initialUpdate: Uint8Array | undefined
    first.doc.once('update', (update: Uint8Array) => { initialUpdate = update })
    first.doc.getText('markdown').insert(0, 'production adversarial base')
    assert(initialUpdate, 'initial Yjs update was not generated')
    first.send({ type: 'manifest-op', operationId: 'adversarial-create', operation: { kind: 'create', documentPath: TEST_DOCUMENT, content: 'production adversarial base', initialUpdate: encode(initialUpdate), sidebarLabel: TEST_LABEL } })
    await first.waitFor((message) => message.type === 'ack' && message.operationId === 'adversarial-create')
    await sleep(400)
    for (const client of clients.slice(1)) Y.applyUpdate(client.doc, initialUpdate, 'adversarial-seed')
    await Promise.all(clients.map(async (client, index) => {
      let update: Uint8Array | undefined
      client.doc.once('update', (next: Uint8Array) => { update = next })
      client.doc.getText('markdown').insert(1, `-${index}-`)
      assert(update, `concurrent update ${index} missing`)
      const updateId = `adversarial-concurrent-${index}`
      client.send({ type: 'document-update', updateId, documentPath: TEST_DOCUMENT, update: encode(update), provenance: [{ start: 1, end: 4 }] })
      await client.waitFor((message) => message.type === 'ack' && message.updateId === updateId)
    }))
    await sleep(500)
    const mergedLengths = clients.map((client) => client.doc.getText('markdown').length)
    assert(mergedLengths.every((length) => length === mergedLengths[0]), `clients diverged after concurrent updates: ${mergedLengths.join(',')}`)
    for (const client of clients) client.send({ type: 'awareness', documentPath: TEST_DOCUMENT, cursor: { anchor: 2, head: 2 }, selection: { start: 1, end: 3 }, status: 'online' })
    await sleep(300)
    const presenceIds = new Set(clients.flatMap((client) => client.messages.filter((message) => message.type === 'awareness' && message.status === 'online' && message.presenceId).map((message) => message.presenceId!)))
    assert(presenceIds.size >= 5, `awareness did not expose five presences; got ${presenceIds.size}`)
    await clients[2].close()
    await clients[2].connect()
    let reconnectUpdate: Uint8Array | undefined
    clients[2].doc.once('update', (next: Uint8Array) => { reconnectUpdate = next })
    clients[2].doc.getText('markdown').insert(clients[2].doc.getText('markdown').length, '-reconnected')
    assert(reconnectUpdate, 'reconnect update was not generated')
    clients[2].send({ type: 'document-update', updateId: 'adversarial-reconnect', documentPath: TEST_DOCUMENT, update: encode(reconnectUpdate), provenance: [{ start: clients[2].doc.getText('markdown').length - 12, end: clients[2].doc.getText('markdown').length }] })
    await clients[2].waitFor((message) => message.type === 'ack' && message.updateId === 'adversarial-reconnect')
    clients[3].send({ type: 'manifest-op', operationId: 'adversarial-conflict', operation: { kind: 'create', documentPath: TEST_DOCUMENT, content: 'conflict' } })
    await clients[3].waitFor((message) => message.type === 'workspace-conflict')
    for (const client of clients) await client.close()
    await api(baseUrl, token, `/workspace-collaboration/${encodeURIComponent(workspaceId)}?checkpoint=1`, { method: 'POST' })
    const created = await api<{ batch: { id: string } }>(baseUrl, token, '/workspace-publish-requests', { method: 'POST', body: JSON.stringify({ workspace: workspaceId }) })
    await api(baseUrl, token, `/workspace-publish-requests/${encodeURIComponent(created.batch.id)}/approve`, { method: 'POST', body: JSON.stringify({ message: 'production navigation adversarial publish' }) })
    const liveUrl = `https://zhou-ee.github.io/PYRo-Wiki/${TEST_DOCUMENT.replace(/\.md$/, '.html')}`
    await waitForLivePage(liveUrl, (html, status) => status === 200 && html.includes(TEST_LABEL) && html.includes('/PYRo-Wiki/PYRo-uCtrl-Unity/Peripheral/__codex_navigation_probe'), 'published navigation probe did not appear on GitHub Pages')
    const gpioUrl = 'https://zhou-ee.github.io/PYRo-Wiki/PYRo-uCtrl-Unity/Peripheral/GPIO.html'
    await waitForLivePage(gpioUrl, (html, status) => status === 200 && html.includes('/PYRo-Wiki/PYRo-uCtrl-Unity/Peripheral/GPIO'), 'GPIO did not appear in the published Peripheral sidebar')
    const cleanup = new SimulatedClient(baseUrl, workspaceId, token, 99)
    await cleanup.connect()
    cleanup.send({ type: 'manifest-op', operationId: 'adversarial-delete', operation: { kind: 'delete', documentPath: TEST_DOCUMENT } })
    await cleanup.waitFor((message) => message.type === 'ack' && message.operationId === 'adversarial-delete')
    await cleanup.close()
    await api(baseUrl, token, `/workspace-collaboration/${encodeURIComponent(workspaceId)}?checkpoint=1`, { method: 'POST' })
    const cleanupBatch = await api<{ batch: { id: string } }>(baseUrl, token, '/workspace-publish-requests', { method: 'POST', body: JSON.stringify({ workspace: workspaceId }) })
    await api(baseUrl, token, `/workspace-publish-requests/${encodeURIComponent(cleanupBatch.batch.id)}/approve`, { method: 'POST', body: JSON.stringify({ message: 'production navigation adversarial cleanup' }) })
    await waitForLivePage(liveUrl, (_html, status) => status === 404, 'navigation probe remained on GitHub Pages after cleanup')
    await waitForLivePage(gpioUrl, (html, status) => status === 200 && html.includes('/PYRo-Wiki/PYRo-uCtrl-Unity/Peripheral/GPIO') && !html.includes(TEST_LABEL), 'cleanup removed GPIO or left the probe navigation label behind')
    const verify = new SimulatedClient(baseUrl, workspaceId, token, 100)
    await verify.connect()
    const sync = verify.messages.find((message) => message.type === 'workspace-sync') as TestMessage & { manifest?: Array<{ path: string }> } | undefined
    assert(!sync?.manifest?.some((entry) => entry.path === TEST_DOCUMENT), 'adversarial document remained after cleanup')
    await verify.close()
    log('five-client collaboration, approved navigation publication, static Pages verification and cleanup passed')
    return { workspaceId, documentPath: TEST_DOCUMENT }
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`)
    for (const client of clients) await client.close()
    throw error
  }
}
