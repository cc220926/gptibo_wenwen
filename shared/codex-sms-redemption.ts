export const CODEX_SMS_REDEEM_URL = 'https://ai.aikm.workers.dev/'

const legacyAddress = /(?<![\w@./-])(?:https?:\/\/)?sms\.llvi\.de\/?(?![\w./:?#-])/gi

/** Update old site instructions without changing CDKs or issued deep links. */
export function updateCodexSmsRedeemAddress(text: string) {
  return text.replace(legacyAddress, CODEX_SMS_REDEEM_URL)
}
