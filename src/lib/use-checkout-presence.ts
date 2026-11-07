import { useEffect, useRef, useState } from 'react'
import { checkoutPresence } from './checkout-presence'
import { storefrontScopeHeaders } from './storefront-routing'

export function useCheckoutPresence(enabled: boolean, checkingOut: boolean, partner?: string) {
  const [others, setOthers] = useState<number | null>(null)
  const controller = useRef<ReturnType<typeof checkoutPresence> | null>(null)
  const currentCheckout = useRef(checkingOut)
  useEffect(() => { currentCheckout.current = checkingOut; controller.current?.setCheckout(checkingOut) }, [checkingOut])
  useEffect(() => {
    const query = new URLSearchParams({ product: 'chatgpt', ...(partner ? { partner } : {}) })
    const session = checkoutPresence({
      enabled,
      checkout: currentCheckout.current,
      publish: setOthers,
      interaction: event => event.isTrusted && event.target instanceof Element && Boolean(event.target.closest('[data-checkout-presence-active="true"]')),
      request: async activity => {
        const response = await fetch('/api/checkout-presence' + (activity ? '' : '?' + query.toString()), {
          method: activity ? 'POST' : 'GET', credentials: 'same-origin',
          headers: { ...storefrontScopeHeaders(), ...(activity ? { 'Content-Type': 'application/json' } : {}) },
          body: activity ? JSON.stringify({ product: 'chatgpt', ...(partner ? { partner } : {}), ...activity }) : undefined,
          keepalive: activity?.active === false,
          signal: AbortSignal.timeout(8000),
        })
        if (!response.ok) throw new Error('Presence unavailable')
        return response.json()
      },
    })
    controller.current = session
    return () => { session.stop(); controller.current = null }
  }, [enabled, partner])
  return enabled ? others : null
}
