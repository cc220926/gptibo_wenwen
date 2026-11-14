-- Additive catalog entries only. Existing orders and their snapshots are untouched.
-- Partner resale stays off until separately configured with a confirmed cost.
INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled,renewal_only,updated_at,partner_enabled,purchase_note)
VALUES
('codex-credits-250','codex-credits','250 点',9900,1,0,unixepoch()*1000,0,'一次性 Codex 250 点数包，不是月度订阅。付款后提交要充值账号的完整 ChatGPT Session JSON，并核对目标账号邮箱；上游确认充值成功后完成交付。请在原订单查看进度，等待或超时时不要重复下单。'),
('codex-credits-500','codex-credits','500 点',19900,1,0,unixepoch()*1000,0,'一次性 Codex 500 点数包，不是月度订阅。付款后提交要充值账号的完整 ChatGPT Session JSON，并核对目标账号邮箱；上游确认充值成功后完成交付。请在原订单查看进度，等待或超时时不要重复下单。');
