import { permissionsFor } from './permissions'

export interface AuthEnv {
  DB: D1Database
  PYRO_AUTH_MODE: string
  PYRO_ENVIRONMENT: string
  PYRO_AUTH_CALLBACK_URL?: string
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  FEISHU_TENANT_KEY?: string
  FEISHU_TENANT_RESTRICTION?: string
  AUTH_SESSION_SECRET?: string
  PYRO_PUBLISHER_IDS?: string
}

export interface AuthUser {
  id: string
  openId: string
  unionId?: string
  tenantKey?: string
  name: string
  avatar?: string
  permissions?: { canPublish: boolean }
}

interface AccessClaims {
  sub: string
  sid: string
  exp: number
  iat: number
  name: string
  tenantKey?: string
}

const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
const HANDOFF_TTL_SECONDS = 2 * 60
const STATE_TTL_SECONDS = 10 * 60
const VSCODE_CALLBACK = 'vscode://pyro-wiki.pyro-wiki-vscode-extension/auth/callback'
const AUTH_CLEANUP_RETENTION_SECONDS = 24 * 60 * 60
const FEISHU_AUTHORIZE_URL = 'https://open.feishu.cn/open-apis/authen/v1/authorize'
const FEISHU_ACCESS_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v1/access_token'
const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

type JsonRecord = Record<string, unknown>

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET,PUT,POST,OPTIONS'
    }
  })
}

function html(message: string, status = 200): Response {
  const safe = message.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>PYRo Wiki Login</title></head><body><h1>${safe}</h1><p>You can close this window and return to VS Code.</p></body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

function handoffPage(returnUrl: string, handoff: string): Response {
  const safeUrl = returnUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const safeCode = handoff.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeUrl}"><title>Return to VS Code</title></head><body><h1>Returning to VS Code...</h1><p>If VS Code did not open automatically, click <a href="${safeUrl}">Return to VS Code</a>.</p><p>Fallback handoff code:</p><pre>${safeCode}</pre><p>Use <b>PYRo Wiki: Complete Feishu Login</b> in VS Code if needed.</p></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000) }
function isoAfter(seconds: number): string { return new Date(Date.now() + seconds * 1000).toISOString() }
function isExpired(value: string): boolean { return Date.parse(value) <= Date.now() }

async function purgeExpiredAuthData(env: AuthEnv): Promise<void> {
  const current = new Date().toISOString()
  const retention = new Date(Date.now() - AUTH_CLEANUP_RETENTION_SECONDS * 1000).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(current),
    env.DB.prepare('DELETE FROM auth_handoff_codes WHERE expires_at <= ? OR used_at <= ?').bind(current, retention),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at <= ?').bind(current, retention)
  ])
}

function base64Url(value: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index])
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlText(value: string): string { return base64Url(new TextEncoder().encode(value)) }
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0))
}
function randomToken(): string { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return base64Url(bytes) }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

async function signAccessToken(env: AuthEnv, claims: AccessClaims): Promise<string> {
  if (!env.AUTH_SESSION_SECRET) throw new Error('AUTH_SESSION_SECRET is not configured')
  const header = base64UrlText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64UrlText(JSON.stringify(claims))
  const input = `${header}.${payload}`
  return `${input}.${base64Url(await hmac(env.AUTH_SESSION_SECRET, input))}`
}

async function verifyAccessToken(env: AuthEnv, token: string): Promise<AccessClaims | undefined> {
  if (!env.AUTH_SESSION_SECRET) return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signature = decodeBase64Url(parts[2])
    const signatureBuffer = new ArrayBuffer(signature.byteLength)
    new Uint8Array(signatureBuffer).set(signature)
    const valid = await crypto.subtle.verify('HMAC', key, signatureBuffer, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!valid) return undefined
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as Partial<AccessClaims>
    const now = nowSeconds()
    const issuedAt = claims.iat
    const expiresAt = claims.exp
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.name !== 'string' || typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return undefined
    return issuedAt <= now + 60 && expiresAt > now ? claims as AccessClaims : undefined
  } catch {
    return undefined
  }
}

function authMode(env: AuthEnv): 'none' | 'feishu' { return env.PYRO_AUTH_MODE === 'none' ? 'none' : 'feishu' }
function callbackUrl(env: AuthEnv): string { return env.PYRO_AUTH_CALLBACK_URL || 'https://pyro-wiki-api.luckyy.ccwu.cc/auth/feishu/callback' }
function bearer(request: Request): string | undefined {
  const value = request.headers.get('authorization')
  const match = value?.match(/^Bearer\s+(.+)$/i)
  return match?.[1].trim() || undefined
}

async function getUser(env: AuthEnv, userId: string): Promise<AuthUser | undefined> {
  const row = await env.DB.prepare('SELECT id, feishu_open_id as openId, union_id as unionId, tenant_key as tenantKey, name, avatar FROM users WHERE id=?').bind(userId).first<AuthUser>()
  if (!row) return undefined
  return { ...row, permissions: permissionsFor(env, row) }
}

export async function authenticateRequest(request: Request, env: AuthEnv): Promise<AuthUser | Response> {
  if (authMode(env) === 'none') { const user = { id: 'dev-anonymous', openId: 'dev-anonymous', name: 'Development User' }; return { ...user, permissions: permissionsFor(env, user) } }
  const token = bearer(request)
  if (!token) return json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, 401)
  const claims = await verifyAccessToken(env, token)
  if (!claims) return json({ error: 'Invalid or expired access token', code: 'AUTH_INVALID' }, 401)
  const session = await env.DB.prepare('SELECT user_id as userId, expires_at as expiresAt, revoked_at as revokedAt FROM auth_sessions WHERE id=?').bind(claims.sid).first<{ userId: string; expiresAt: string; revokedAt?: string }>()
  if (!session || session.userId !== claims.sub || session.revokedAt || isExpired(session.expiresAt)) return json({ error: 'Session expired', code: 'AUTH_EXPIRED' }, 401)
  const user = await getUser(env, claims.sub)
  return user ?? json({ error: 'User not found', code: 'AUTH_USER_NOT_FOUND' }, 401)
}

export function isAuthResponse(value: AuthUser | Response): value is Response { return value instanceof Response }

async function exchangeFeishuCode(env: AuthEnv, code: string): Promise<{ openId: string; unionId?: string; tenantKey?: string; name: string; avatar?: string }> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu application secrets are not configured')
  const response = await fetch(FEISHU_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  })
  const tokenBody = await response.json() as JsonRecord
  const tokenData = (tokenBody.data ?? tokenBody) as JsonRecord
  const accessToken = typeof tokenData.access_token === 'string' ? tokenData.access_token : undefined
  if (!response.ok || (typeof tokenBody.code === 'number' && tokenBody.code !== 0) || !accessToken) throw new Error('Feishu authorization code exchange failed')
  const userResponse = await fetch(FEISHU_USER_INFO_URL, { headers: { authorization: `Bearer ${accessToken}` } })
  const userBody = await userResponse.json() as JsonRecord
  const userData = (userBody.data ?? userBody) as JsonRecord
  if (!userResponse.ok || (typeof userBody.code === 'number' && userBody.code !== 0)) throw new Error('Feishu user information request failed')
  const openId = String(userData.open_id ?? tokenData.open_id ?? '')
  const name = String(userData.name ?? '')
  const tenantKey = userData.tenant_key ? String(userData.tenant_key) : tokenData.tenant_key ? String(tokenData.tenant_key) : undefined
  if (!openId || !name) throw new Error('Feishu did not return a usable user identity')
  if (env.FEISHU_TENANT_KEY && tenantKey !== env.FEISHU_TENANT_KEY) throw new Error('The Feishu user is outside the configured tenant')
  if (env.FEISHU_TENANT_RESTRICTION === 'internal' && !tenantKey) throw new Error('Feishu did not return an internal tenant identity')
  return { openId, unionId: userData.union_id ? String(userData.union_id) : undefined, tenantKey, name, avatar: userData.avatar_url ? String(userData.avatar_url) : undefined }
}

async function issueTokens(env: AuthEnv, user: AuthUser): Promise<JsonRecord> {
  const sessionId = crypto.randomUUID()
  const refreshToken = randomToken()
  await env.DB.prepare('INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(sessionId, user.id, await sha256(refreshToken), isoAfter(REFRESH_TTL_SECONDS), new Date().toISOString()).run()
  const issuedAt = nowSeconds()
  const accessToken = await signAccessToken(env, { sub: user.id, sid: sessionId, exp: issuedAt + ACCESS_TTL_SECONDS, iat: issuedAt, name: user.name, tenantKey: user.tenantKey })
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user }
}

export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (url.pathname === '/auth/feishu/start' && request.method === 'GET') {
    if (authMode(env) !== 'feishu') return errorJson('Feishu authentication is disabled', 503)
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return errorJson('Feishu application is not configured', 503)
    await purgeExpiredAuthData(env)
    const state = randomToken()
    await env.DB.prepare('INSERT INTO oauth_states (state_hash, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(await sha256(state), callbackUrl(env), isoAfter(STATE_TTL_SECONDS), new Date().toISOString()).run()
    const authorize = new URL(FEISHU_AUTHORIZE_URL)
    authorize.searchParams.set('app_id', env.FEISHU_APP_ID)
    authorize.searchParams.set('redirect_uri', callbackUrl(env))
    authorize.searchParams.set('state', state)
    return new Response(null, { status: 302, headers: { location: authorize.toString(), 'cache-control': 'no-store' } })
  }
  if (url.pathname === '/auth/feishu/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (!state || !code) return html('Feishu authorization was cancelled or returned no code.', 400)
    const stateHash = await sha256(state)
    const stateRow = await env.DB.prepare('SELECT state_hash as stateHash, redirect_uri as redirectUri, expires_at as expiresAt FROM oauth_states WHERE state_hash=?').bind(stateHash).first<{ stateHash: string; redirectUri: string; expiresAt: string }>()
    await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?').bind(stateHash).run()
    if (!stateRow || stateRow.redirectUri !== callbackUrl(env) || isExpired(stateRow.expiresAt)) return html('The Feishu login request expired. Please start again from VS Code.', 400)
    try {
      const identity = await exchangeFeishuCode(env, code)
      const existing = await env.DB.prepare('SELECT id FROM users WHERE feishu_open_id=?').bind(identity.openId).first<{ id: string }>()
      const userId = existing?.id ?? crypto.randomUUID()
      await env.DB.prepare(`INSERT INTO users (id, feishu_open_id, union_id, tenant_key, name, avatar, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feishu_open_id) DO UPDATE SET union_id=excluded.union_id, tenant_key=excluded.tenant_key, name=excluded.name, avatar=excluded.avatar, updated_at=excluded.updated_at`).bind(userId, identity.openId, identity.unionId ?? null, identity.tenantKey ?? null, identity.name, identity.avatar ?? null, new Date().toISOString(), new Date().toISOString()).run()
      const handoff = randomToken()
      await env.DB.prepare('INSERT INTO auth_handoff_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(await sha256(handoff), userId, isoAfter(HANDOFF_TTL_SECONDS), new Date().toISOString()).run()
      const returnUrl = new URL(VSCODE_CALLBACK)
      returnUrl.searchParams.set('handoff', handoff)
      return handoffPage(returnUrl.toString(), handoff)
    } catch (error) {
      return html(error instanceof Error ? error.message : 'Feishu login failed.', 502)
    }
  }
  if (url.pathname === '/auth/session/exchange' && request.method === 'POST') {
    try {
      await purgeExpiredAuthData(env)
      const input = await request.json() as { handoff?: string }
      if (!input.handoff) return errorJson('handoff is required', 400)
      const handoffHash = await sha256(input.handoff)
      const handoff = await env.DB.prepare('SELECT user_id as userId, expires_at as expiresAt, used_at as usedAt FROM auth_handoff_codes WHERE code_hash=?').bind(handoffHash).first<{ userId: string; expiresAt: string; usedAt?: string }>()
      if (!handoff || handoff.usedAt || isExpired(handoff.expiresAt)) return errorJson('Invalid or expired handoff code', 400)
      const consumed = await env.DB.prepare('UPDATE auth_handoff_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').bind(new Date().toISOString(), handoffHash).run()
      if (!consumed.meta.changes) return errorJson('Handoff code has already been used', 400)
      const user = await getUser(env, handoff.userId)
      if (!user) return errorJson('User not found', 400)
      return json(await issueTokens(env, user))
    } catch (error) { return errorJson(error instanceof Error ? error.message : 'Invalid session exchange', 400) }
  }
  if (url.pathname === '/auth/session/refresh' && request.method === 'POST') {
    try {
      await purgeExpiredAuthData(env)
      const input = await request.json() as { refreshToken?: string }
      if (!input.refreshToken) return errorJson('refreshToken is required', 400)
      const hash = await sha256(input.refreshToken)
      const session = await env.DB.prepare('SELECT id, user_id as userId, expires_at as expiresAt, revoked_at as revokedAt FROM auth_sessions WHERE refresh_token_hash=?').bind(hash).first<{ id: string; userId: string; expiresAt: string; revokedAt?: string }>()
      if (!session || session.revokedAt || isExpired(session.expiresAt)) return errorJson('Invalid or expired refresh token', 401)
      const revoked = await env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND expires_at > ?').bind(new Date().toISOString(), session.id, new Date().toISOString()).run()
      if (!revoked.meta.changes) return errorJson('Refresh token has already been used', 401)
      const user = await getUser(env, session.userId)
      if (!user) return errorJson('User not found', 401)
      return json(await issueTokens(env, user))
    } catch (error) { return errorJson(error instanceof Error ? error.message : 'Invalid refresh request', 400) }
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    const authenticated = await authenticateRequest(request, env)
    if (isAuthResponse(authenticated)) return authenticated
    const token = bearer(request)
    const claims = token ? await verifyAccessToken(env, token) : undefined
    if (claims) await env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), claims.sid).run()
    return json({ ok: true })
  }
  if (url.pathname === '/me' && request.method === 'GET') {
    const authenticated = await authenticateRequest(request, env)
    return isAuthResponse(authenticated) ? authenticated : json({ user: authenticated })
  }
  return undefined
}

function errorJson(message: string, status: number): Response { return json({ error: message }, status) }
