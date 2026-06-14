import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    css: false,
    // Gate/runner integration tests spawn processes + git worktrees and poll status
    // for up to 8s internally. The 5s Vitest default is below that, so slower CI legs
    // (notably windows-latest + Node 22) time out. 20s gives ample headroom.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
