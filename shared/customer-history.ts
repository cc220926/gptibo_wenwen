export const CUSTOMER_HISTORY_PAGE_SIZE = 60

// Public history contains display-only masks, never deliverable addresses.
// Keep this check shared by the importer, API and browser boundary.
export function isMaskedCustomerEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return local.length > 0 && local.length <= 64 && local.includes('***')
    && /^[A-Za-z0-9._%+*-]+$/.test(local)
    && domain.length <= 253
    && domain.split('.').length >= 2
    && domain.split('.').every(label => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
    && /^[A-Za-z]{2,63}$/.test(domain.split('.').at(-1) ?? '')
}
