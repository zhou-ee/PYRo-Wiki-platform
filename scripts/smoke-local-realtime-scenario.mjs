import { assert, openClient, sleep, startLocalWorker, Y } from './smoke-local-realtime-common.mjs'

async function closeAll(items) { for (const item of items) item.close(); await sleep(250) }
async function waitUntil(predicate, timeout = 8_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error('Timed out waiting for collaboration state')
}
function sendAwareness(client, cursor, selection) {
  client.socket.send(JSON.stringify({ type: 'awareness', status: 'update', documentPath: 'docs/realtime.md', cursor, selection, updatedAt: Date.now() }))
}

export async function runRealtime() {
  const port = Number(process.env.PYRO_WIKI_LOCAL_REALTIME_PORT ?? 8791)
  const worker = await startLocalWorker('smoke-realtime-collaboration', port)
  const clients = []
  try {
    const firstDoc = new Y.Doc()
    firstDoc.getText('markdown').insert(0, 'hello')
    const first = openClient(worker.socketUrl, firstDoc); clients.push(first)
    await first.hello()
    for (let index = 1; index < 5; index += 1) {
      const client = openClient(worker.socketUrl); clients.push(client)
      await client.hello()
    }
    await waitUntil(() => clients.every((client) => client.doc.getText('markdown').toString() === 'hello'))

    clients.forEach((client, index) => sendAwareness(client, { anchor: index, head: index + 1 }, { start: index, end: index + 1 }))
    await waitUntil(() => clients[0].messages.filter((message) => message.type === 'awareness' && message.status !== 'offline').length >= 5)

    clients[0].updateText(0, 0, 'A')
    clients[1].updateText(1, clients[1].doc.getText('markdown').length, 'B')
    await waitUntil(() => clients.every((client) => client.doc.getText('markdown').toString().includes('A') && client.doc.getText('markdown').toString().includes('B')))

    for (let index = 0; index < 100; index += 1) {
      let update
      clients[2].doc.once('update', (next) => { update = next })
      clients[2].doc.getText('markdown').insert(clients[2].doc.getText('markdown').length, '.')
      clients[2].sendUpdate(update)
    }
    await waitUntil(() => clients.every((client) => client.doc.getText('markdown').length === clients[2].doc.getText('markdown').length), 12_000)

    const firstPresence = clients[1].messages.find((message) => message.type === 'awareness' && message.status === 'online' && message.presenceId)
    assert(firstPresence?.presenceId, 'realtime smoke did not receive online awareness')
    clients[0].close()
    await clients[1].waitFor((message) => message.type === 'awareness' && message.status === 'offline' && message.presenceId === firstPresence.presenceId)
    console.log('PYRo Wiki local realtime collaboration smoke passed')
  } finally {
    await closeAll(clients)
    worker.stop()
  }
}

export async function runAwareness() {
  const port = Number(process.env.PYRO_WIKI_LOCAL_AWARENESS_PORT ?? 8792)
  const worker = await startLocalWorker('smoke-awareness', port)
  const clients = []
  try {
    for (let index = 0; index < 3; index += 1) {
      const client = openClient(worker.socketUrl); clients.push(client)
      await client.hello()
    }
    sendAwareness(clients[0], { anchor: 12, head: 18 }, { start: 12, end: 18 })
    await clients[1].waitFor((message) => message.type === 'awareness' && message.status === 'online' && message.cursor?.anchor === 12 && message.selection?.end === 18)
    const presence = clients[1].messages.find((message) => message.type === 'awareness' && message.status === 'online' && message.presenceId)
    assert(presence?.color, 'awareness smoke did not receive a stable color')
    clients[0].close()
    await clients[1].waitFor((message) => message.type === 'awareness' && message.status === 'offline' && message.presenceId === presence.presenceId)
    console.log('PYRo Wiki local awareness smoke passed')
  } finally {
    await closeAll(clients)
    worker.stop()
  }
}

export async function runReconnect() {
  const port = Number(process.env.PYRO_WIKI_LOCAL_RECONNECT_PORT ?? 8793)
  const worker = await startLocalWorker('smoke-reconnect', port)
  const clients = []
  try {
    const firstDoc = new Y.Doc(); firstDoc.getText('markdown').insert(0, 'base')
    const first = openClient(worker.socketUrl, firstDoc); clients.push(first); await first.hello()
    const second = openClient(worker.socketUrl); clients.push(second); await second.hello()
    await waitUntil(() => second.doc.getText('markdown').toString() === 'base')
    first.close()
    second.updateText(1, second.doc.getText('markdown').length, '-remote')
    first.doc.getText('markdown').insert(0, 'offline-')
    const restored = openClient(worker.socketUrl, first.doc); clients.push(restored); await restored.hello()
    await waitUntil(() => restored.doc.getText('markdown').toString().includes('offline-') && restored.doc.getText('markdown').toString().includes('-remote'))
    await waitUntil(() => second.doc.getText('markdown').toString().includes('offline-'))
    assert(restored.doc.getText('markdown').toString() === second.doc.getText('markdown').toString(), 'reconnect did not converge both clients')
    console.log('PYRo Wiki local reconnect smoke passed')
  } finally {
    await closeAll(clients)
    worker.stop()
  }
}

export async function runOfflineSync() {
  const port = Number(process.env.PYRO_WIKI_LOCAL_OFFLINE_PORT ?? 8794)
  const worker = await startLocalWorker('smoke-offline-sync', port)
  const clients = []
  try {
    const firstDoc = new Y.Doc(); firstDoc.getText('markdown').insert(0, 'base')
    const first = openClient(worker.socketUrl, firstDoc); clients.push(first); await first.hello()
    const second = openClient(worker.socketUrl); clients.push(second); await second.hello()
    await waitUntil(() => second.doc.getText('markdown').toString() === 'base')
    first.close()
    for (let index = 0; index < 100; index += 1) first.doc.getText('markdown').insert(first.doc.getText('markdown').length, `-${index}`)
    second.updateText(1, second.doc.getText('markdown').length, '-server')
    const restored = openClient(worker.socketUrl, first.doc); clients.push(restored); await restored.hello()
    await waitUntil(() => restored.doc.getText('markdown').toString().includes('-server') && restored.doc.getText('markdown').toString().includes('-99'))
    await waitUntil(() => second.doc.getText('markdown').toString().includes('-99'))
    assert(restored.doc.getText('markdown').toString() === second.doc.getText('markdown').toString(), 'offline sync did not converge')
    console.log('PYRo Wiki local offline sync smoke passed')
  } finally {
    await closeAll(clients)
    worker.stop()
  }
}
