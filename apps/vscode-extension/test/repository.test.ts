import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { collapseRepeatedContent, parseTarArchive, safeRelativePath } from '../src/repository'

function tarEntry(name: string, content: Uint8Array, type = 48): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\\0', 100, 8, 'ascii')
  header.write('0000000\\0', 108, 8, 'ascii')
  header.write('0000000\\0', 116, 8, 'ascii')
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\\0`, 124, 12, 'ascii')
  header.write('00000000000\\0', 136, 12, 'ascii')
  header[156] = type
  header.write('ustar\\0', 257, 6, 'ascii')
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512)
  return Buffer.concat([header, Buffer.from(content), padding])
}

describe('shared repository archive parser', () => {
  it('strips the GitHub archive root and ignores traversal paths', () => {
    expect(safeRelativePath('PYRo-Wiki-main/docs/intro.md')).toBe('docs/intro.md')
    expect(safeRelativePath('PYRo-Wiki-main/../outside.txt')).toBeUndefined()
    expect(safeRelativePath('PYRo-Wiki-main/.git/config')).toBeUndefined()
  })

  it('collapses only byte-for-byte repeated archive payloads', () => {
    const original = new TextEncoder().encode('# doc\nbody\n')
    expect(new TextDecoder().decode(collapseRepeatedContent(new Uint8Array([...original, ...original, ...original])))).toBe('# doc\nbody\n')
    expect(new TextDecoder().decode(collapseRepeatedContent(new Uint8Array([...original, ...original, ...original, ...original, ...original, ...original])))).toBe('# doc\nbody\n')
    expect(new TextDecoder().decode(collapseRepeatedContent(new TextEncoder().encode('# doc\nbody\n# doc\nchanged\n')))).toBe('# doc\nbody\n# doc\nchanged\n')
  })

  it('extracts regular files from a gzip tar archive', () => {
    const archive = gzipSync(Buffer.concat([
      tarEntry('PYRo-Wiki-main/index.md', Buffer.from('# shared Wiki')),
      tarEntry('PYRo-Wiki-main/public/logo.bin', Uint8Array.from([0, 1, 2, 255])),
      Buffer.alloc(1024)
    ]))
    const files = parseTarArchive(archive)
    expect(new TextDecoder().decode(files.get('index.md'))).toBe('# shared Wiki')
    expect([...files.get('public/logo.bin') ?? []]).toEqual([0, 1, 2, 255])
  })
})
