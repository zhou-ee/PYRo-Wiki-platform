import { spawn, spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const port = Number(process.env.PYRO_WIKI_LOCAL_API_PORT ?? 8788)
const baseUrl = `http://127.0.0.1:${port}`
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const persistTo = '.wrangler/smoke-local'
const config = 'infra/cloudflare/wrangler.api.jsonc'
const args = ['dev', '--config', config, '--local', '--persist-to', persistTo, '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { response, body }
}

async function waitForServer(child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local Worker exited before startup\n${logs.join('')}`)
    try {
      const { response } = await request('/health')
      if (response.status === 200) return
    } catch { /* server is still starting */ }
    await sleep(500)
  }
  throw new Error(`local Worker did not start\n${logs.join('')}`)
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
  try {
    await waitForServer(child, logs)
    const health = await request('/health')
    assert(health.body.environment === 'development', `expected development environment, got ${health.body.environment}`)
    assert(health.body.authMode === 'none', `expected none auth mode, got ${health.body.authMode}`)

    const workspace = 'integration-smoke'
    const missingPath = encodeURIComponent('docs/missing.md')
    const missingUrl = `/documents/${missingPath}?workspace=${workspace}`
    const missingDocument = await request(missingUrl)
    assert(missingDocument.response.status === 404, `missing document GET expected 404, got ${missingDocument.response.status}`)
    const missingRevisions = await request(`/documents/${missingPath}/revisions?workspace=${workspace}`)
    assert(missingRevisions.response.status === 404, `missing document revisions expected 404, got ${missingRevisions.response.status}`)

    const documentPath = encodeURIComponent('docs/intro.md')
    const documentUrl = `/documents/${documentPath}?workspace=${workspace}`
    const first = await request(documentUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, content: '# v1', baseRevision: 0 }) })
    assert(first.response.status === 200, `initial PUT expected 200, got ${first.response.status}: ${JSON.stringify(first.body)}`)
    assert(first.body.revision === 1 && first.body.content === '# v1', 'initial PUT did not create revision 1')

    const pulled = await request(documentUrl)
    assert(pulled.response.status === 200 && pulled.body.content === '# v1' && pulled.body.revision === 1, 'GET did not return revision 1')

    const stale = await request(documentUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, content: '# stale', baseRevision: 0 }) })
    assert(stale.response.status === 409, `stale PUT expected 409, got ${stale.response.status}`)
    assert(stale.body.remote?.revision === 1 && stale.body.local?.revision === 0, 'conflict payload is incomplete')

    const second = await request(documentUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, content: '# v2', baseRevision: 1 }) })
    assert(second.response.status === 200 && second.body.revision === 2, 'second PUT did not create revision 2')

    const staleWithCommon = await request(documentUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, content: '# stale from v1', baseRevision: 1 }) })
    assert(staleWithCommon.response.status === 409, `stale PUT with common ancestor expected 409, got ${staleWithCommon.response.status}`)
    assert(staleWithCommon.body.common?.revision === 1 && staleWithCommon.body.common?.content === '# v1', 'conflict response did not include common ancestor')

    const draft = await request(`/documents/${documentPath}/drafts?workspace=${workspace}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, content: '# draft', baseRevision: 2 }) })
    assert(draft.response.status === 200 && draft.body.revision === 3, 'draft did not create revision 3')

    const restored = await request(`/documents/${documentPath}/revisions/1/restore?workspace=${workspace}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, baseRevision: 3 }) })
    assert(restored.response.status === 200 && restored.body.revision === 4 && restored.body.content === '# v1', 'revision restore did not create a new published revision')

    const revisions = await request(`/documents/${documentPath}/revisions?workspace=${workspace}`)
    assert(revisions.response.status === 200 && revisions.body.revisions.length === 4, 'revision history should contain four revisions after restore')

    const documents = await request(`/documents?workspace=${workspace}`)
    assert(documents.response.status === 200 && documents.body.documents.length === 1, 'document listing should contain one document')

    const publish = await request('/publish-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, documentPath: 'docs/intro.md', revision: 4 }) })
    assert(publish.response.status === 201 && publish.body.request?.status === 'submitted', `publish request creation failed: ${JSON.stringify(publish.body)}`)
    const publishId = publish.body.request.id
    const listedPublish = await request(`/publish-requests?workspace=${workspace}`)
    assert(listedPublish.response.status === 200 && listedPublish.body.requests.some((item) => item.id === publishId), 'publish request listing did not include the new request')
    const approve = await request(`/publish-requests/${encodeURIComponent(publishId)}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'local smoke' }) })
    assert(approve.response.status === 502, `unconfigured local GitHub App approve expected 502, got ${approve.response.status}: ${JSON.stringify(approve.body)}`)
    const failedPublish = await request(`/publish-requests/${encodeURIComponent(publishId)}`)
    assert(failedPublish.response.status === 200 && failedPublish.body.request.status === 'failed', 'failed publish request was not retained for retry')

    const malformedPath = await request(`/documents/%E0%A4%A?workspace=${workspace}`)
    assert(malformedPath.response.status === 400, `malformed document path expected 400, got ${malformedPath.response.status}`)
    const malformedCollaborationPath = await request(`/collaboration/%E0%A4%A?workspace=${workspace}`)
    assert(malformedCollaborationPath.response.status === 400, `malformed collaboration path expected 400, got ${malformedCollaborationPath.response.status}`)
    console.log(`PYRo Wiki local API smoke passed: ${baseUrl}`)
  } finally {
    stop()
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

main().catch((error) => {
  console.error(`PYRo Wiki local API smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
