import { runAwareness } from './smoke-local-realtime-scenario.mjs'
runAwareness().catch((error) => { console.error(`PYRo Wiki awareness smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
