import { describe, expect, it } from 'vitest'
import { DAILY_REQUEST_LIMIT, D1_READ_SAFETY_LIMIT, D1_WRITE_SAFETY_LIMIT, beijingDayKey, decideD1Budget, decideQuota, resetAtForBeijingDay } from '../src/quota'

describe('daily request quota', () => {
  it('starts a new Beijing day at zero', () => {
    const decision = decideQuota(undefined, Date.parse('2026-07-20T16:00:00.000Z'))
    expect(decision.day).toBe('2026-07-21')
    expect(decision.count).toBe(1)
    expect(decision.allowed).toBe(true)
  })

  it('allows through the internal limit and rejects the next request', () => {
    const day = beijingDayKey(Date.parse('2026-07-20T04:00:00.000Z'))
    const beforeLimit = decideQuota({ day, count: DAILY_REQUEST_LIMIT - 1 }, Date.parse('2026-07-20T04:00:00.000Z'))
    const atLimit = decideQuota({ day, count: DAILY_REQUEST_LIMIT }, Date.parse('2026-07-20T04:00:01.000Z'))
    expect(beforeLimit.allowed).toBe(true)
    expect(beforeLimit.count).toBe(DAILY_REQUEST_LIMIT)
    expect(atLimit.allowed).toBe(false)
    expect(atLimit.count).toBe(DAILY_REQUEST_LIMIT)
  })

  it('resets after Beijing midnight', () => {
    const timestamp = Date.parse('2026-07-20T16:00:00.000Z')
    expect(beijingDayKey(timestamp)).toBe('2026-07-21')
    expect(resetAtForBeijingDay('2026-07-21')).toBe('2026-07-21T16:00:00.000Z')
    expect(decideQuota({ day: '2026-07-20', count: DAILY_REQUEST_LIMIT }, timestamp).allowed).toBe(true)
  })
})


describe('D1 budget guard', () => {
  it('reserves rows below the safety watermarks', () => {
    const decision = decideD1Budget(undefined, 10, 4, Date.parse('2026-07-20T04:00:00.000Z'))
    expect(decision.allowed).toBe(true)
    expect(decision.rowsRead).toBe(10)
    expect(decision.rowsWritten).toBe(4)
  })

  it('defers a reservation that would cross either watermark', () => {
    const day = beijingDayKey(Date.parse('2026-07-20T04:00:00.000Z'))
    const decision = decideD1Budget({ day, rowsRead: D1_READ_SAFETY_LIMIT - 1, rowsWritten: D1_WRITE_SAFETY_LIMIT - 1 }, 2, 2, Date.parse('2026-07-20T04:00:00.000Z'))
    expect(decision.allowed).toBe(false)
    expect(decision.rowsRead).toBe(D1_READ_SAFETY_LIMIT - 1)
    expect(decision.rowsWritten).toBe(D1_WRITE_SAFETY_LIMIT - 1)
  })
})
