import { startServer } from './index.js'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = parseInt(process.argv[2] ?? '3579', 10)
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')

await startServer(port, staticDir)
