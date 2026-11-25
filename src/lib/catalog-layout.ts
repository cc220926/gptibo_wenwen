type CatalogCard = { id: string; compact?: boolean }

export function placeMuseBelowSms<Card extends CatalogCard>(cards: Card[], museId?: string): Array<Card & { museColumn?: 1 | 2 }> {
  const muse = cards.find(card => card.id === museId && !card.compact)
  if (!muse || !cards.some(card => card.id === 'codex-sms' && !card.compact)) return cards

  const reordered = cards.filter(card => card !== muse)
  const smsIndex = reordered.findIndex(card => card.id === 'codex-sms')
  let groupStart = smsIndex
  while (groupStart > 0 && !reordered[groupStart - 1].compact) groupStart--
  const museColumn = (smsIndex - groupStart) % 2 === 0 ? 1 : 2
  const next = reordered[smsIndex + 1]
  const insertAt = smsIndex + (next && !next.compact ? 2 : 1)
  return [...reordered.slice(0, insertAt), { ...muse, museColumn }, ...reordered.slice(insertAt)]
}
