// One-time credit packages, separate from subscriptions and Codex SMS service.
export const CODEX_CREDITS = {
  'codex-credits-250': { points: 250, productCode: 'chatgpt_codex_250_cdk', priceCents: 9900 },
  'codex-credits-500': { points: 500, productCode: 'chatgpt_codex_500_cdk', priceCents: 19900 },
} as const
export const isCodexCreditsPlan = (plan: string) => Object.hasOwn(CODEX_CREDITS, plan)
