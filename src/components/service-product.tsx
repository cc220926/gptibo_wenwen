import { useState } from 'react'
import { ArrowRight, ChevronRight, Package, ShieldCheck } from 'lucide-react'
import type { CatalogPlan } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { storefrontHref } from '@/lib/storefront-routing'
import '@/styles/service-product.css'

export function ServiceProductPage({ productId, offers, ready, busy, checkoutEnabled, onBuy, onNavigate }: { productId: string; offers: CatalogPlan[]; ready: boolean; busy: boolean; checkoutEnabled: boolean; onBuy: (plan: CatalogPlan) => void; onNavigate: (page: string) => void }) {
  const [selected, setSelected] = useState('')
  const plans = offers.filter(p => p.product_id === productId && p.delivery_type && p.delivery_type !== 'legacy')
  const plan = plans.find(p => p.id === selected) ?? plans.find(p => p.enabled) ?? plans[0]
  if (!plan) return <section className="empty-orders page-width"><h1>{ready ? '该商品已下架或暂不可用' : '正在读取商品'}</h1><p>已有订单仍可在「我的订单」查看。</p><Button onClick={() => onNavigate('store')}>返回商店</Button></section>
  return <section className="page-width service-product-detail"><nav className="product-breadcrumb" aria-label="当前位置"><a href={storefrontHref('store')} onClick={e => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onNavigate('store') }}>全部商品</a><ChevronRight size={13} /><span>{plan.category}</span></nav><div className="service-product-layout"><div className="service-product-intro"><Package size={48} strokeWidth={1.2} /><h1>{plan.product_name}</h1><p>{plan.description}</p><span><ShieldCheck size={16} />订单内查看交付与售后记录</span></div><div className="service-product-options"><h2>选择规格</h2><div role="group" aria-label="商品规格" className="service-specs">{plans.map(p => <button key={p.id} aria-pressed={p.id === plan.id} onClick={() => setSelected(p.id)}><span><strong>{p.name}</strong><small>{p.delivery_type === 'stock' ? p.stock_available ? '付款确认后自动发货' : '暂时缺货' : '人工服务交付'}{!p.enabled && ' · 暂不可购买'}</small></span><strong>¥{(p.price_cents / 100).toFixed(2)}</strong></button>)}</div><div className="service-product-note"><h3>购买前请确认</h3><p>{plan.purchase_note}</p><p>{plan.delivery_type === 'stock' ? '每单一份，付款确认后在订单页领取，同一份内容也会发送至下单邮箱。交付不代表已经激活或兑换。' : '每单一份，付款后由工作人员处理，交付结果将在原订单展示，并通过邮件通知。'}</p></div><Button className="primary-action" disabled={!ready || busy || !checkoutEnabled || !plan.enabled} onClick={() => onBuy(plan)}>{!plan.enabled ? plan.delivery_type === 'stock' && !plan.stock_available ? '暂时缺货' : '暂停售卖' : '确认规格，立即购买'}<ArrowRight size={16} /></Button></div></div></section>
}
