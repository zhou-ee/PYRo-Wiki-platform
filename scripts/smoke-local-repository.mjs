import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const port = Number(process.env.PYRO_WIKI_LOCAL_REPOSITORY_PORT ?? 8791)
const baseUrl = `http://127.0.0.1:${port}`
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const config = 'infra/cloudflare/wrangler.api.jsonc'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function request(path) { return fetch(`${baseUrl}${path}`) }
async function waitForServer(child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local Worker exited before startup\n${logs.join('')}`)
    try { const response = await request('/health'); if (response.status === 200) return } catch { /* starting */ }
    await sleep(500)
  }
  throw new Error(`local Worker did not start\n${logs.join('')}`)
}

async function main() {
  const logs = []
  const child = spawn(process.execPath, [wrangler, 'dev', '--config', config, '--local', '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  const stop = () => { if (child.exitCode === null && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) }
  process.on('exit', stop)
  try {
    await waitForServer(child, logs)
    const metadataResponse = await request('/repository/metadata')
    if (metadataResponse.status !== 200) throw new Error(`repository metadata expected 200, got ${metadataResponse.status}: ${await metadataResponse.text()}`)
    const metadata = await metadataResponse.json()
    if (metadata.repositoryUrl !== 'https://github.com/zhou-ee/PYRo-Wiki' || metadata.branch !== 'main' || !/^[0-9a-f]{40}$/i.test(metadata.commitSha)) throw new Error('repository metadata did not include repository, branch and commit SHA')
    const response = await request('/repository/archive')
    if (response.status !== 200) throw new Error(`repository archive expected 200, got ${response.status}: ${await response.text()}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length < 512 || response.headers.get('content-type') !== 'application/gzip') throw new Error('repository archive response is not a gzip payload')
    if (response.headers.get('x-pyro-repository-ref') !== 'main') throw new Error('repository archive ref header is incorrect')
    console.log(`PYRo Wiki local repository proxy smoke passed: ${bytes.length} bytes`)
  } finally {
    stop()
    await sleep(250)
  }
}

main().catch((error) => {
  console.error(`PYRo Wiki local repository proxy smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
