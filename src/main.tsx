import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Root from './Root.tsx'
import { RechargeSitePreview } from './components/recharge-site-preview'
const SessionPrecheckPreview = import.meta.env.DEV ? lazy(() => import('./components/session-precheck-preview')) : null
const ReferralOrderPreview = import.meta.env.MODE === 'referral-preview'
  ? lazy(() => import('./components/referral-preview').then(module => ({ default: module.ReferralOrderPreview })))
  : null

// Apply the saved appearance before React mounts to avoid a light flash.
try { if (localStorage.getItem('ymx-theme') === 'dark') document.documentElement.classList.add('dark') } catch { /* default light */ }

// Storefront HTML stays neutral until its catalog identifies the shop.
if (location.pathname === '/admin' || location.pathname.startsWith('/admin/') || ['/join', '/join/', '/partner'].includes(location.pathname)) {
  document.title = location.pathname.startsWith('/admin') ? '管理工作台 · GPTibo' : '代理工作台 · GPTibo'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {ReferralOrderPreview && location.pathname === '/__preview/referral/order' ? <Suspense fallback={null}><ReferralOrderPreview /></Suspense> : SessionPrecheckPreview && location.pathname === '/__preview/session-precheck' ? <Suspense fallback={null}><SessionPrecheckPreview /></Suspense> : window.parent !== window && window.frameElement?.getAttribute('data-guide-scene') === 'package' ? <RechargeSitePreview /> : <Root />}
  </StrictMode>,
)
