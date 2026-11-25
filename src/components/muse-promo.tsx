import promo from '../../design/muse-ai-promo.svg?url'

export function MusePromo({ lazy = false }: { lazy?: boolean }) {
  return <img className="service-muse-promo" src={promo} width={1200} height={900} alt="" loading={lazy ? 'lazy' : undefined} decoding="async" />
}
