import commerceWorker from './index.ts'
import { secureResponse } from './security.ts'
import { publicStorefront, privateNavigationShell, type SeoEnv } from './public-seo.ts'

// API requests and scheduled work retain the original handler and Env identity.
// This wrapper is deliberately separate from payment / fulfillment routing.
export function withPublicStorefront(worker: typeof commerceWorker) {
  return {
    scheduled: worker.scheduled,
    async fetch(request: Request, env: SeoEnv): Promise<Response> {
      if (new URL(request.url).pathname.startsWith('/api/')) return worker.fetch(request, env)
      try {
        const publicResponse = await publicStorefront(request, env)
        if (publicResponse) return publicResponse
        return await privateNavigationShell(request, env, await worker.fetch(request, env))
      } catch {
        // SEO must fail closed for indexing, without blocking the original app.
        if (['/sitemap.xml', '/robots.txt'].includes(new URL(request.url).pathname)) {
          return secureResponse(request, new Response(request.method === 'HEAD' ? null : 'Public discovery temporarily unavailable', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Retry-After': '120' } }))
        }
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
