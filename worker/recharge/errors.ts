// Only documented public codes cross our API/storage boundary. Supplier prose
// can contain credentials on older deployments and is deliberately not copied.
export const failureMessages: Record<string, string> = {
  session_invalid: '登录凭据已失效，请重新登录后提交。',
  mailbox_login_failed: '邮箱登录失败，请核对登录资料，或在允许重新提交后改用 Session。',
  account_has_subscription: '该账号已有有效订阅，本次未充值。请核对当前套餐及到期时间，通过原订单继续处理，无需再次付款。',
  subscription_required: '该套餐要求账号已有有效订阅，请核对续费资格。',
  precheck_rejected: '账号未通过预检，请完成账号验证或联系客服。',
  account_unavailable: '当前账号暂不可用，请核对账号或联系客服。',
  product_unavailable: '该套餐暂不可用，请联系客服。',
  order_rejected: '此次充值未被受理，请联系客服核对。',
  region_unsupported: '账号地区暂不支持，请联系客服。',
  payment_blocked: '充值付款受限，请联系客服核查，勿重复提交相同资料。',
  payment_declined: '充值付款未通过，请查看当前可用的处理方式或联系客服。',
  precharge_failed: '充值前校验未通过，请核对账号。',
  cancelled: '此次充值已取消。',
  verification_timeout: '充值结果尚未确认，请联系客服核对原任务，勿重复提交。',
  service_unavailable: '充值服务暂不可用，平台正在重试，请继续查询原任务。',
  other: '充值未完成，请联系客服。',
  request_rejected: '提交未被受理，请核对资料后重新提交。',
}
export const categoryMessages: Record<string, string> = {
  credential: '登录资料未通过验证，请核对资料或联系客服。',
  account: '账号状态需要核对，请联系客服。',
  product: '套餐暂不可用，请联系客服。',
  resource: '充值资源暂不可用，请继续查询原任务或联系客服。',
  service: '充值服务暂不可用，请继续查询原任务。',
  confirmation: '充值结果正在核对，请勿重复提交。',
  unknown: '充值结果需要进一步核对，请联系客服。',
}
export const requestMessages: Record<string, string> = {
  invalid_request: '提交内容未通过校验，请核对资料。',
  invalid_credential: failureMessages.session_invalid,
  session_invalid: failureMessages.session_invalid,
  invalid_signature: '充值服务认证异常，请联系客服。',
  timestamp_out_of_range: '充值服务时间校验异常，请联系客服。',
  nonce_replayed: '请求校验重复，请刷新原订单核对结果。',
  ip_not_allowed: '充值服务访问受限，请联系客服。',
  product_not_authorized: '该套餐暂未开放，请联系客服。',
  order_not_found: '平台暂未查到原订单，请联系客服核对，勿重新付款。',
  idempotency_conflict: '原提交编号与资料不一致，请保留原订单并联系客服。',
  idempotency_in_progress: '原请求仍在处理中，请稍后查询原订单，勿重复提交。',
  invalid_state_transition: '订单状态已变化，请刷新原订单核对。',
  provider_refund_reconciliation_required: '退款正在核对渠道记录，请查询原退款，勿重复申请。',
  price_out_of_range: '套餐价格已变化，请刷新套餐或联系客服。',
  rate_limited: '查询较频繁，请稍后刷新原订单。',
  api_poll_too_frequent: '原订单查询较频繁，请稍后刷新，勿重复付款或提交。',
  api_access_required: '充值服务接口权限尚未开通，请联系客服。',
  custom_redemption_disabled: '自动充值权限尚未开通，请联系客服。',
  direct_payment_code_disabled: '当前收款码通道尚未开放，请联系客服。',
  temporarily_unavailable: '充值服务暂不可用，请稍后查询原订单。',
}
export function publicCode(value: unknown, codes: Record<string, unknown>) {
  return typeof value === 'string' && Object.hasOwn(codes, value) ? value : null
}

/** Extract digits only from the known active-plan error, never forward prose. */
export function subscriptionExpiryHint(message: unknown) {
  if (typeof message !== 'string' || message.length > 4000 || !message.includes('GPT_PLAN_ALREADY_ACTIVE')) return null
  const value = /目标套餐有效至\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?=[，,\s（(]|$)/.exec(message)?.[1]
  if (!value) return null
  const [year, month, day, hour, minute] = value.split(/[- :]/).map(Number)
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null
}

export function subscriptionFailureMessage(hint: string | null, canRetry = false) {
  const safeHint = hint ? subscriptionExpiryHint(`目标套餐有效至 ${hint}（GPT_PLAN_ALREADY_ACTIVE）`) : null
  if (!safeHint && !canRetry) return failureMessages.account_has_subscription
  return (safeHint ? `当前目标套餐尚未到期，本次未充值。上游提示有效至 ${safeHint}（上游未注明时区，请以账号订阅页为准）。` : '该账号已有有效订阅，本次未充值。请先核对当前套餐及到期时间。') +
    (canRetry ? '核对到期后，可在本订单重新提交充值资料，无需再次付款。' : '请通过原订单核对或联系支持，无需再次付款。')
}

export const resultStages = {
  queued: 'queued', awaiting_card: 'awaiting_card', funding_pending: 'preparing_funds',
  dispatching: 'dispatching', running: 'processing', requires_action: 'requires_action',
  pending: 'confirming', plus_paid: 'upgrading', review: 'review',
  completed: 'completed', declined: 'failed', failed_precharge: 'failed', cancelled: 'cancelled',
} as const
