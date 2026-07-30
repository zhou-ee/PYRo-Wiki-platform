import { runRealtime } from './smoke-local-realtime-scenario.mjs'
runRealtime().catch((error) => { console.error(`PYRo Wiki realtime collaboration smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
