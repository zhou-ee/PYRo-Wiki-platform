export const NAVIGATION_SECTIONS = ['/PYRo-uCtrl-Unity', '/Course/embedded', '/Course/front-end', '/Course/others'] as const

export function navigationSectionForPath(relativePath: string): string | undefined {
  const route = `/${relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')}`
  return NAVIGATION_SECTIONS.find((section) => route === section || route.startsWith(`${section}/`))
}

export function navigationRouteForDocument(documentPath: string): string {
  const normalized = documentPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '')
  return `/${normalized}`
}

export function publishedNavigationRoutes(sources: readonly string[]): Set<string> {
  const routes = new Set<string>()
  for (const source of sources) {
    try {
      const index = JSON.parse(source.replace(/^\uFEFF/, '')) as Record<string, unknown>
      if (index && typeof index === 'object' && !Array.isArray(index)) {
        for (const [documentPath, label] of Object.entries(index)) if (typeof label === 'string' && label.trim()) routes.add(navigationRouteForDocument(documentPath))
      }
    } catch { /* TypeScript navigation source */ }
    for (const match of source.matchAll(/\blink\s*:\s*(['"`])([^'"`\r\n]+)\1/g)) routes.add(match[2].startsWith('/') ? match[2] : `/${match[2]}`)
  }
  return routes
}
