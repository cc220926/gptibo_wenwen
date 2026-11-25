import { registerHooks } from 'node:module'

// Run the unchanged business suite through the new configured entry. Keep its
// internal import of index.ts intact so that forwarding cannot be circular.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/tests/') && specifier.endsWith('/worker/index.ts')) {
      return nextResolve(specifier.replace('/worker/index.ts', '/worker/storefront-entry.ts'), context)
    }
    return nextResolve(specifier, context)
  },
})
