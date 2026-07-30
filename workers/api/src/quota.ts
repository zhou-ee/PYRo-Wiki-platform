export const DAILY_REQUEST_LIMIT = 9_000
const D1_READ_BUDGET = 1_000_000
const D1_WRITE_BUDGET = 20_000
const D1_READ_SAFETY_LIMIT = 900_000
const D1_WRITE_SAFETY_LIMIT = 18_000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export { D1_READ_BUDGET, D1_WRITE_BUDGET, D1_READ_SAFETY_LIMIT, D1_WRITE_SAFETY_LIMIT }

export interface QuotaSnapshot { day: string; count: number }
export interface D1BudgetSnapshot { day: string; rowsRead: number; rowsWritten: number }
export interface QuotaDecision { allowed: boolean; day: string; count: number; limit: number; resetAt: string }
export interface D1BudgetDecision { allowed: boolean; day: string; rowsRead: number; rowsWritten: number; requestedRead: number; requestedWrite: number; resetAt: string; reason?: string }

export function beijingDayKey(timestamp = Date.now()): string { return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10) }
export function resetAtForBeijingDay(day: string): string { return new Date(Date.parse(`${day}T16:00:00.000Z`)).toISOString() }
export function decideQuota(snapshot: QuotaSnapshot | undefined, timestamp = Date.now()): QuotaDecision {
  const day = beijingDayKey(timestamp); const current = snapshot?.day === day ? snapshot.count : 0; const allowed = current < DAILY_REQUEST_LIMIT
  return { allowed, day, count: allowed ? current + 1 : current, limit: DAILY_REQUEST_LIMIT, resetAt: resetAtForBeijingDay(day) }
}
export function decideD1Budget(snapshot: D1BudgetSnapshot | undefined, requestedRead: number, requestedWrite: number, timestamp = Date.now()): D1BudgetDecision {
  const day = beijingDayKey(timestamp)
  const current = snapshot?.day === day ? snapshot : { day, rowsRead: 0, rowsWritten: 0 }
  const read = Math.max(0, Math.floor(requestedRead)); const write = Math.max(0, Math.floor(requestedWrite))
  const allowed = current.rowsRead + read <= D1_READ_SAFETY_LIMIT && current.rowsWritten + write <= D1_WRITE_SAFETY_LIMIT
  return { allowed, day, rowsRead: current.rowsRead + (allowed ? read : 0), rowsWritten: current.rowsWritten + (allowed ? write : 0), requestedRead: read, requestedWrite: write, resetAt: resetAtForBeijingDay(day), reason: allowed ? undefined : 'D1 daily safety budget reached' }
}
export function quotaExceededResponse(decision: QuotaDecision): Response { return new Response(JSON.stringify({ error: 'DAILY_REQUEST_LIMIT_REACHED', limit: decision.limit, usage: decision.count, resetAt: decision.resetAt, message: "Today's PYRo Wiki API quota has been reached. Try again after Beijing midnight." }), { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(Math.max(1, Math.ceil((Date.parse(decision.resetAt) - Date.now()) / 1000))), 'x-pyro-daily-limit': String(decision.limit), 'x-pyro-daily-usage': String(decision.count), 'x-pyro-daily-reset-at': decision.resetAt } }) }

export class RequestQuota {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/internal/d1-reserve' && request.method === 'POST') {
      const input = await request.json().catch(() => ({})) as { rowsRead?: number; rowsWritten?: number }
      const previous = await this.state.storage.get<D1BudgetSnapshot>('d1-budget')
      const decision = decideD1Budget(previous, input.rowsRead ?? 0, input.rowsWritten ?? 0)
      if (decision.allowed) await this.state.storage.put<D1BudgetSnapshot>('d1-budget', { day: decision.day, rowsRead: decision.rowsRead, rowsWritten: decision.rowsWritten })
      return new Response(JSON.stringify(decision), { status: decision.allowed ? 200 : 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
    const previous = await this.state.storage.get<QuotaSnapshot>('daily')
    const decision = decideQuota(previous)
    if (decision.allowed) await this.state.storage.put<QuotaSnapshot>('daily', { day: decision.day, count: decision.count })
    return new Response(JSON.stringify(decision), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  }
}

export async function reserveD1Budget(env: { PYRO_ENVIRONMENT?: string; REQUEST_QUOTA?: DurableObjectNamespace }, rowsRead: number, rowsWritten: number): Promise<D1BudgetDecision | undefined> {
  if (env.PYRO_ENVIRONMENT !== 'production' || !env.REQUEST_QUOTA) return undefined
  const id = env.REQUEST_QUOTA.idFromName('global')
  const response = await env.REQUEST_QUOTA.get(id).fetch('https://pyro-wiki-quota/internal/d1-reserve', { method: 'POST', body: JSON.stringify({ rowsRead, rowsWritten }) })
  return await response.json() as D1BudgetDecision
}

export async function enforceDailyQuota(request: Request, env: { PYRO_ENVIRONMENT?: string; REQUEST_QUOTA?: DurableObjectNamespace }): Promise<Response | undefined> {
  if (env.PYRO_ENVIRONMENT !== 'production' || request.method === 'OPTIONS' || !env.REQUEST_QUOTA) return undefined
  const id = env.REQUEST_QUOTA.idFromName('global')
  const response = await env.REQUEST_QUOTA.get(id).fetch('https://pyro-wiki-quota/internal/count')
  const decision = await response.json() as QuotaDecision
  return decision.allowed ? undefined : quotaExceededResponse(decision)
}
