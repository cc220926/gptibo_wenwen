import commerceWorker from './index.ts'
import { publicStorefront, type SeoEnv } from './public-seo.ts'

// API requests and scheduled work retain the original handler and Env identity.
// This wrapper is deliberately separate from payment / fulfillment routing.
export function withPublicStorefront(worker: typeof commerceWorker) {
  return {
    scheduled: worker.scheduled,
    async fetch(request: Request, env: SeoEnv): Promise<Response> {
      if (new URL(request.url).pathname.startsWith('/api/')) return worker.fetch(request, env)
      try {
        return await publicStorefront(request, env) ?? await worker.fetch(request, env)
      } catch {
        // SEO must fail closed for indexing, without blocking the original app.
        const response = await worker.fetch(request, env)
        const headers = new Headers(response.headers)
        headers.set('X-Robots-Tag', 'noindex, nofollow')
        headers.set('Cache-Control', 'no-store')
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      }
    },
  }
}
export default withPublicStorefront(commerceWorker)
