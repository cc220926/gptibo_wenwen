import { CUSTOMER_HISTORY_PAGE_SIZE, isMaskedCustomerEmail } from '../../shared/customer-history.ts'

export type CustomerHistoryPage = { emails: string[]; nextCursor: number | null }
export type CustomerHistoryView = { emails: string[]; canAdvance: boolean }

export function readCustomerHistoryPage(value: unknown, cursor: number): CustomerHistoryPage | null {
  if (!value || typeof value !== 'object') return null
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.emails) || page.emails.length > CUSTOMER_HISTORY_PAGE_SIZE || !page.emails.every(isMaskedCustomerEmail)) return null
  if (new Set(page.emails).size !== page.emails.length) return null
  if (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || (page.nextCursor as number) <= cursor || page.emails.length === 0)) return null
  return { emails: page.emails, nextCursor: page.nextCursor as number | null }
}

// Keep one page ahead and the first page for wrapping. No full customer export
// or unique-customer count is needed to display this historical list.
export function customerHistoryFeed(options: {
  request: (cursor: number) => Promise<unknown>
  publish: (view: CustomerHistoryView | null) => void
}) {
  let stopped = false, failed = false, loading = false, canAdvance = false
  let firstPage: CustomerHistoryPage | null = null
  let buffer: string[] = [], cursor: number | null = 0
  const publish = () => {
    if (!stopped) options.publish(!failed && buffer.length ? { emails: buffer.slice(0, 4), canAdvance: canAdvance && buffer.length > 3 } : null)
  }
  const load = async () => {
    if (stopped || failed || loading) return
    loading = true
    try {
      const page = cursor === null && firstPage ? firstPage : readCustomerHistoryPage(await options.request(cursor ?? 0), cursor ?? 0)
      if (stopped) return
      if (!page) throw new Error('Invalid customer history')
      if (!firstPage) {
        firstPage = page
        canAdvance = page.emails.length > 3 || page.nextCursor !== null
      }
      buffer.push(...page.emails)
      cursor = page.nextCursor
      // A dataset may have been shortened after its preceding page was read.
      // Return to its known first page without fabricating replacement entries.
      if (!page.emails.length && buffer.length && firstPage.emails.length) {
        buffer.push(...firstPage.emails)
        cursor = firstPage.nextCursor
      }
      publish()
    } catch {
      if (!stopped) { failed = true; buffer = []; publish() }
    } finally { loading = false }
  }
  void load()
  return {
    advance() {
      if (stopped || failed || !canAdvance || buffer.length <= 3) return
      buffer.shift()
      publish()
      if (buffer.length <= 8) void load()
    },
    stop() { stopped = true; buffer = []; firstPage = null },
  }
}
