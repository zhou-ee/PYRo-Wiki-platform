import { describe, expect, it } from 'vitest'
import { mergeThreeWay } from '../src/sync/merge'

describe('three-way merge', () => {
  it('uses the changed side when the other side is unchanged', () => {
    expect(mergeThreeWay('a\nb', 'a\blocal', 'a\nb').content).toBe('a\blocal')
    expect(mergeThreeWay('a\nb', 'a\nb', 'a\nremote').content).toBe('a\nremote')
  })

  it('merges independent line changes', () => {
    expect(mergeThreeWay('one\ntwo\nthree', 'ONE\ntwo\nthree', 'one\ntwo\nTHREE')).toEqual({ content: 'ONE\ntwo\nTHREE', conflicts: 0 })
  })

  it('emits explicit markers for overlapping changes', () => {
    const result = mergeThreeWay('same', 'local', 'remote')
    expect(result.conflicts).toBe(1)
    expect(result.content).toContain('<<<<<<< LOCAL')
    expect(result.content).toContain('||||||| COMMON')
    expect(result.content).toContain('>>>>>>> REMOTE')
  })

  it('does not silently merge structural edits', () => {
    expect(mergeThreeWay('a\nb', 'a\ninserted\nb', 'a\nremote').conflicts).toBe(1)
  })
})
