const baseUrl = (process.env.PYRO_WIKI_API_BASE_URL ?? 'https://pyro-wiki-api.luckyy.ccwu.cc').replace(/\/$/, '')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const noCompression = { headers: { 'accept-encoding': 'identity' } }
  const health = await fetch(`${baseUrl}/health`, noCompression)
  assert(health.status === 200, `health expected 200, got ${health.status}`)
  const healthBody = await health.json()
  assert(healthBody.ok === true && healthBody.database === 'ok', 'health response is not ready')
  assert(healthBody.environment === 'production', `expected production environment, got ${healthBody.environment}`)
  assert(healthBody.authMode === 'feishu', `expected feishu auth mode, got ${healthBody.authMode}`)
  assert(health.headers.get('cache-control') === 'no-store', 'health response must not be cached')

  const repositoryMetadata = await fetch(`${baseUrl}/repository/metadata`, noCompression)
  assert(repositoryMetadata.status === 200, `repository metadata expected 200, got ${repositoryMetadata.status}`)
  const metadata = await repositoryMetadata.json()
  assert(metadata.repositoryUrl === 'https://github.com/zhou-ee/PYRo-Wiki' && metadata.branch === 'main' && /^[0-9a-f]{40}$/i.test(metadata.commitSha), 'repository metadata is incomplete')

  const repositoryArchive = await fetch(`${baseUrl}/repository/archive`, { headers: { accept: 'application/gzip' } })
  assert(repositoryArchive.status === 200, `repository archive expected 200, got ${repositoryArchive.status}`)
  assert((repositoryArchive.headers.get('content-type') ?? '').startsWith('application/gzip'), 'repository archive must be gzip')
  assert(repositoryArchive.headers.get('x-pyro-repository-ref') === 'main', 'repository archive ref must be main')
  await repositoryArchive.arrayBuffer()

  const documents = await fetch(`${baseUrl}/documents?workspace=smoke-test`)
  assert(documents.status === 401, `unauthenticated documents expected 401, got ${documents.status}`)

  const malformedAuth = await fetch(`${baseUrl}/documents?workspace=smoke-test`, { headers: { authorization: 'Bearer malformed.token.%' } })
  assert(malformedAuth.status === 401, `malformed bearer token expected 401, got ${malformedAuth.status}`)

  const collaboration = await fetch(`${baseUrl}/collaboration/smoke.md?workspace=smoke-test`)
  assert(collaboration.status === 401, `unauthenticated collaboration expected 401, got ${collaboration.status}`)

  const workspaceCollaboration = await fetch(`${baseUrl}/workspace-collaboration/__codex_adversarial_probe`)
  assert(workspaceCollaboration.status === 401, `unauthenticated workspace collaboration expected 401, got ${workspaceCollaboration.status}`)

  const oauth = await fetch(`${baseUrl}/auth/feishu/start`, { ...noCompression, redirect: 'manual' })
  assert(oauth.status === 302, `oauth start expected 302, got ${oauth.status}`)
  assert(oauth.headers.get('cache-control') === 'no-store', 'oauth redirect must not be cached')
  const location = oauth.headers.get('location')
  assert(location, 'oauth start did not include a location header')
  const authorize = new URL(location)
  assert(authorize.hostname === 'open.feishu.cn', `oauth host is ${authorize.hostname}`)
  assert(authorize.pathname === '/open-apis/authen/v1/authorize', `oauth path is ${authorize.pathname}`)
  assert(authorize.searchParams.get('redirect_uri') === `${baseUrl}/auth/feishu/callback`, 'oauth redirect_uri does not match production callback')
  assert(authorize.searchParams.has('state'), 'oauth state is missing')

  const invalidCallback = await fetch(`${baseUrl}/auth/feishu/callback?state=invalid-smoke-state&code=invalid-smoke-code`, noCompression)
  assert(invalidCallback.status === 400, `invalid OAuth callback expected 400, got ${invalidCallback.status}`)
  assert(invalidCallback.headers.get('cache-control') === 'no-store', 'invalid OAuth callback must not be cached')

  const invalidExchange = await fetch(`${baseUrl}/auth/session/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoff: 'invalid-smoke-handoff' }) })
  assert(invalidExchange.status === 400, `invalid handoff exchange expected 400, got ${invalidExchange.status}`)
  assert(invalidExchange.headers.get('cache-control') === 'no-store', 'invalid handoff response must not be cached')

  const invalidRefresh = await fetch(`${baseUrl}/auth/session/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: 'invalid-smoke-refresh' }) })
  assert(invalidRefresh.status === 401, `invalid refresh expected 401, got ${invalidRefresh.status}`)
  assert(invalidRefresh.headers.get('cache-control') === 'no-store', 'invalid refresh response must not be cached')

  console.log(`PYRo Wiki production smoke passed: ${baseUrl}`)
}

main().catch((error) => {
  console.error(`PYRo Wiki production smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
