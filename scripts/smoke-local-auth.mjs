import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const port = Number(process.env.PYRO_WIKI_LOCAL_AUTH_PORT ?? 8790)
const baseUrl = `http://127.0.0.1:${port}`
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const persistTo = '.wrangler/smoke-auth'
const config = 'infra/cloudflare/wrangler.api.jsonc'
const fakeSecret = 'local-integration-only-secret'
const handoff = 'local-integration-handoff'
const handoffHash = createHash('sha256').update(handoff).digest('hex')
const vars = ['--var', 'PYRO_AUTH_MODE:feishu', '--var', 'PYRO_ENVIRONMENT:integration', '--var', `AUTH_SESSION_SECRET:${fakeSecret}`]
const args = ['dev', '--config', config, '--local', '--persist-to', persistTo, '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false', ...vars]

function assert(condition, message) { if (!condition) throw new Error(message) }
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
    try { if ((await fetch(`${baseUrl}/health`)).status === 200) return } catch { /* starting */ }
    await sleep(500)
  }
  throw new Error(`local Worker did not start\n${logs.join('')}`)
}

async function main() {
  await rm(resolve(root, persistTo), { recursive: true, force: true })
  const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'pyro-wiki-dev', '--local', '--persist-to', persistTo, '--config', config], { cwd: root, input: 'y\n', encoding: 'utf8' })
  if (migration.status !== 0) throw new Error(`local D1 migration failed\n${migration.stdout ?? ''}\n${migration.stderr ?? ''}`)
  const seedSql = `INSERT OR REPLACE INTO users (id, feishu_open_id, union_id, tenant_key, name, avatar, created_at, updated_at) VALUES ('smoke-user', 'smoke-open-id', NULL, 'smoke-tenant', 'Smoke User', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP); INSERT OR REPLACE INTO auth_handoff_codes (code_hash, user_id, expires_at, used_at, created_at) VALUES ('${handoffHash}', 'smoke-user', '2099-01-01T00:00:00.000Z', NULL, CURRENT_TIMESTAMP);`
  const seed = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'pyro-wiki-dev', '--local', '--persist-to', persistTo, '--config', config, '--command', seedSql], { cwd: root, input: 'y\n', encoding: 'utf8' })
  if (seed.status !== 0) throw new Error(`local auth seed failed\n${seed.stdout ?? ''}\n${seed.stderr ?? ''}`)

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
    const unauthenticated = await request('/documents?workspace=auth-smoke')
    assert(unauthenticated.response.status === 401, `unauthenticated documents expected 401, got ${unauthenticated.response.status}`)

    const exchange = await request('/auth/session/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoff }) })
    assert(exchange.response.status === 200, `session exchange expected 200, got ${exchange.response.status}: ${JSON.stringify(exchange.body)}`)
    assert(exchange.body.user?.name === 'Smoke User' && exchange.body.accessToken && exchange.body.refreshToken, 'session exchange response is incomplete')
    const firstAccess = exchange.body.accessToken
    const firstRefresh = exchange.body.refreshToken

    const reused = await request('/auth/session/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoff }) })
    assert(reused.response.status === 400, `reused handoff expected 400, got ${reused.response.status}`)

    const me = await request('/me', { headers: { authorization: `Bearer ${firstAccess}` } })
    assert(me.response.status === 200 && me.body.user?.name === 'Smoke User', 'me did not return exchanged user')

    const refresh = await request('/auth/session/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: firstRefresh }) })
    assert(refresh.response.status === 200 && refresh.body.accessToken && refresh.body.refreshToken, 'refresh did not rotate session tokens')
    const secondAccess = refresh.body.accessToken
    const secondRefresh = refresh.body.refreshToken

    const reusedRefresh = await request('/auth/session/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: firstRefresh }) })
    assert(reusedRefresh.response.status === 401, `reused refresh expected 401, got ${reusedRefresh.response.status}`)

    const oldMe = await request('/me', { headers: { authorization: `Bearer ${firstAccess}` } })
    assert(oldMe.response.status === 401, `rotated access token expected 401, got ${oldMe.response.status}`)
    const newMe = await request('/me', { headers: { authorization: `Bearer ${secondAccess}` } })
    assert(newMe.response.status === 200, 'rotated access token expected 200')

    const concurrentRefresh = await Promise.all([1, 2].map(() => request('/auth/session/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: secondRefresh }) })))
    const concurrentStatuses = concurrentRefresh.map(({ response }) => response.status).sort((left, right) => left - right)
    assert(concurrentStatuses[0] === 200 && concurrentStatuses[1] === 401, `concurrent refresh expected one 200 and one 401, got ${concurrentStatuses.join(', ')}`)
    const concurrentSuccess = concurrentRefresh.find(({ response }) => response.status === 200)
    assert(concurrentSuccess?.body.accessToken && concurrentSuccess.body.refreshToken, 'concurrent refresh success response is incomplete')

    const logout = await request('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${concurrentSuccess.body.accessToken}` } })
    assert(logout.response.status === 200, `logout expected 200, got ${logout.response.status}`)
    const afterLogout = await request('/me', { headers: { authorization: `Bearer ${concurrentSuccess.body.accessToken}` } })
    assert(afterLogout.response.status === 401, `logged out access token expected 401, got ${afterLogout.response.status}`)
    const revokedRefresh = await request('/auth/session/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: concurrentSuccess.body.refreshToken }) })
    assert(revokedRefresh.response.status === 401, `logged out refresh token expected 401, got ${revokedRefresh.response.status}`)
    console.log(`PYRo Wiki local auth smoke passed: ${baseUrl}`)
  } finally {
    stop()
    await sleep(250)
  }
}

main().catch((error) => {
  console.error(`PYRo Wiki local auth smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
