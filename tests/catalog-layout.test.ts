import assert from 'node:assert/strict'
import test from 'node:test'
import { placeMuseBelowSms, swapGeminiWithCodexCredits } from '../src/lib/catalog-layout.ts'

const chatgpt = { id: 'chatgpt' }, sms = { id: 'codex-sms' }, gptAccount = { id: 'custom-gpt' }, muse = { id: 'custom-muse' }, extra = { id: 'custom-extra' }
const upcoming = { id: 'grok', compact: true }
const gemini = { id: 'gemini-contact' }, codexCredits = { id: 'codex-credits' }

test('Gemini and Codex credits exchange slots without moving ChatGPT, Codex SMS or Muse', () => {
  const cards = placeMuseBelowSms([chatgpt, codexCredits, upcoming, sms, gptAccount, muse, gemini], muse.id)
  assert.deepEqual(swapGeminiWithCodexCredits(cards), [chatgpt, gemini, upcoming, sms, gptAccount, { ...muse, museColumn: 1 }, codexCredits])
  assert.equal(cards[1], codexCredits)
  assert.equal(cards.at(-1), gemini)
})

test('filters and reseller catalogs keep their order when either of the two cards is absent', () => {
  const withoutGemini = [chatgpt, codexCredits], withoutCredits = [chatgpt, gemini]
  assert.equal(swapGeminiWithCodexCredits(withoutGemini), withoutGemini)
  assert.equal(swapGeminiWithCodexCredits(withoutCredits), withoutCredits)
})

test('Muse is directly below Codex SMS without moving the other visible products', () => {
  const cards = placeMuseBelowSms([chatgpt, upcoming, sms, gptAccount, extra, muse], muse.id)
  assert.deepEqual(cards, [chatgpt, upcoming, sms, gptAccount, { ...muse, museColumn: 1 }, extra])
})

test('Muse follows Codex SMS into the right column when the saved order puts SMS there', () => {
  const cards = placeMuseBelowSms([chatgpt, sms, gptAccount, upcoming, muse], muse.id)
  assert.deepEqual(cards, [chatgpt, sms, gptAccount, { ...muse, museColumn: 2 }, upcoming])
})

test('Muse stays in the same full-card group when SMS has no card to its right', () => {
  assert.deepEqual(placeMuseBelowSms([sms, upcoming, muse], muse.id), [sms, { ...muse, museColumn: 1 }, upcoming])
})

test('filtering out either product preserves the order of the remaining results', () => {
  const withoutSms = [muse, gptAccount], withoutMuse = [chatgpt, sms]
  assert.equal(placeMuseBelowSms(withoutSms, muse.id), withoutSms)
  assert.equal(placeMuseBelowSms(withoutMuse, muse.id), withoutMuse)
})
