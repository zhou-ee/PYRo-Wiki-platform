export interface TextChangeLike {
  rangeOffset: number
  rangeLength: number
  text: string
}

export function applyTextChanges(source: string, changes: readonly TextChangeLike[]): string {
  let result = source
  for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
    result = result.slice(0, change.rangeOffset) + change.text + result.slice(change.rangeOffset + change.rangeLength)
  }
  return result
}

export interface TextDeltaPart {
  retain?: number
  delete?: number
  insert?: string
}

export interface TextEditLike {
  offset: number
  length: number
  text: string
}

export function textDeltaToEdits(delta: readonly TextDeltaPart[]): TextEditLike[] {
  const edits: TextEditLike[] = []
  let offset = 0
  for (const part of delta) {
    if (typeof part.retain === 'number') offset += part.retain
    if (typeof part.delete === 'number') {
      const existing = edits[edits.length - 1]
      if (existing && existing.offset === offset && existing.length === 0) existing.length = part.delete
      else edits.push({ offset, length: part.delete, text: '' })
    }
    if (typeof part.insert === 'string') {
      const existing = edits[edits.length - 1]
      if (existing && existing.offset === offset) existing.text += part.insert
      else edits.push({ offset, length: 0, text: part.insert })
      offset += part.insert.length
    }
  }
  return edits.sort((left, right) => right.offset - left.offset)
}
