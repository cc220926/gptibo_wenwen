package integration_test

import (
	"context"
	"encoding/json"
	"gptibo/storefront/internal/importer"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestD1OfflineImportRollbackAndReconciliation(t *testing.T) {
	for _, item := range []struct{ reason, stage string }{{"card_wallet_insufficient", "supplier_failed"}, {"x_price_changed", "preflight"}, {"card_daily_limit", "card"}} {
		t.Run(item.reason, func(t *testing.T) { testD1ImportRecovery(t, item.reason, item.stage) })
	}
}

func testD1ImportRecovery(t *testing.T, reason, stage string) {
	owner, app := fixture(t, true)
	ctx := context.Background()
	root, e := filepath.Abs("../../..")
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	snapshot := filepath.Join(dir, "snapshot.json")
	script := `
 import {DatabaseSync} from 'node:sqlite';import{readFileSync,readdirSync}from'node:fs';import{pathToFileURL}from'node:url';
 const root=process.argv[1],dir=process.argv[2];const db=new DatabaseSync(dir+'/source.sqlite');for(const f of readdirSync(root+'/migrations').sort())if(f.endsWith('.sql'))db.exec(readFileSync(root+'/migrations/'+f,'utf8'));
 db.exec("INSERT INTO partners(id,slug,name,email,active,created_at,updated_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ABCDEF12','Fixture','agent@example.test',1,1700000000000,1700000000000)");
 db.exec("INSERT INTO partner_payout_accounts(partner_id,phone,name,version,last_event_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','13800000001','Fixture Receiver',4,'account-audit')");
 db.exec("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id) VALUES('YMX-RECHARGE','owner','recharge-key','plus','Plus',13900,'live','paid','failed',1700000000000,1700000000000,'recharge-initial')");
 db.exec("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,updated_at,notify_version,checked_notify_version,order_checked_notify_version,redemption_checked_notify_version) VALUES('YMX-RECHARGE','fixture-account','plus','platform_collect','{}','remote-order','paid',1700000000000,7,3,7,3)");
 db.exec("INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,remote_id,status,created_at,remote_attempt_no) VALUES('local-rejected','YMX-RECHARGE',1,'rejected-hash','session',NULL,'rejected',1700000000000,NULL),('local-accepted','YMX-RECHARGE',2,'accepted-hash','session','remote-redemption','failed',1700000000001,1)");
 db.exec("INSERT INTO recharge_api_reads(account,resource,next_allowed_at) VALUES('fixture-account','/orders/remote-order',1700000300000)");
 db.exec("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','plus',10000,16900)");
 db.exec("INSERT INTO support_contacts(owner,partner_id,wechat,qq,email,updated_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wechat_fixture','123456','','1700000000000')");
 db.exec("INSERT INTO partner_product_order(partner_id,product_ids,version,change_id,updated_at,hidden_product_ids) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','[\"chatgpt\",\"x-premium\"]',3,'change',1700000000000,'[\"chatgpt\"]')");
 db.exec("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,created_at,updated_at,last_event_id,version) VALUES('YMX-HISTORY','owner','key','x-premium-3m','X',3500,'live','paid','failed',1700000000000,1700000000000,'initial',0)");
 db.exec("INSERT INTO xgift_purchases(order_id,username,recipient_id,product_code,points,credential_hash,state,supplier_order,failure_code,updated_at,supplier_backend) VALUES('YMX-HISTORY','fixture','12345','x-3m',1700,'hash','failed','ord_original','card_wallet_insufficient',1700000000000,'platform')");
 db.exec("INSERT INTO xgift_recovery_attempts(id,order_id,attempt,merchant_order_no,previous_merchant_order_no,previous_supplier_order,previous_failure_code,expected_order_version,actor,note,created_at) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','YMX-HISTORY',1,'YMX-HISTORY:retry:1','YMX-HISTORY','ord_original','card_wallet_insufficient',0,'fixture','recovery',1700000000010)");
 db.exec("INSERT INTO telegram_partner_applications(id,user_id,group_id,partner_id,wechat,qq,email,created_at,next_attempt_at,mail_attempts,lock_token,lock_until) VALUES('tg-fixture',77,-100123,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wechat_fixture','123456','agent@example.test',1700000000000,1700000000000,1,'old-lock',9999999999999)");
 db.exec("INSERT INTO admin_sessions(token_hash,credential_version,expires_at) VALUES('must-not-import','old-secret-hash',9999999999999)");
 db.exec("INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES('legacy:reconcile:order:2026-10-07','legacy-check','YMX-HISTORY','fixture',1700000000000)");
 db.exec("ALTER TABLE xgift_recovery_attempts ADD COLUMN previous_stage TEXT");
 db.exec("DROP TRIGGER xgift_recovery_no_update; UPDATE xgift_recovery_attempts SET previous_stage='supplier_failed'");db.close();
 const {exportSnapshot}=await import(pathToFileURL(root+'/services/storefront/scripts/export-d1.mjs'));console.log(JSON.stringify(exportSnapshot(dir+'/source.sqlite',dir+'/snapshot.json')));
 `
	script = strings.ReplaceAll(script, "UPDATE xgift_recovery_attempts SET previous_stage='supplier_failed'", "PRAGMA ignore_check_constraints=ON; UPDATE xgift_recovery_attempts SET previous_failure_code='"+reason+"',previous_stage='"+stage+"'")
	command := exec.Command("node", "--input-type=module", "-e", script, root, dir)
	if out, e := command.CombinedOutput(); e != nil {
		t.Fatalf("synthetic D1 fixture failed: %s", out)
	}
	report, e := importer.Run(ctx, owner, snapshot, "", false)
	if e != nil {
		t.Fatal(e)
	}
	if report.Applied || report.Excluded["admin_sessions"] != 1 || report.Review["invitation_delivery_unconfirmed"] != 1 || report.Totals["orders_sale_cents"] != "17400" || report.Review["recharge_read_cooldowns_not_restored"] != 1 {
		t.Fatal("incorrect import report")
	}
	var n int
	owner.DB.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&n)
	if n != 0 {
		t.Fatal("dry run did not roll back")
	}
	if _, e = importer.Run(ctx, owner, snapshot, "wrong", true); e == nil {
		t.Fatal("unreviewed snapshot accepted")
	}
	// Older snapshots with neither optional tables nor attempt/watermark columns
	// must still import without guessing a platform attempt ordinal.
	legacyBytes, _ := os.ReadFile(snapshot)
	var legacy importer.Snapshot
	json.Unmarshal(legacyBytes, &legacy)
	delete(legacy.Tables, "partner_payout_accounts")
	delete(legacy.Tables, "recharge_api_reads")
	for _, row := range legacy.Tables["recharge_redemptions"] {
		delete(row, "remote_attempt_no")
	}
	for _, row := range legacy.Tables["recharge_orders"] {
		delete(row, "order_checked_notify_version")
		delete(row, "redemption_checked_notify_version")
	}
	legacyBytes, _ = json.Marshal(legacy)
	legacyPath := filepath.Join(dir, "legacy.json")
	os.WriteFile(legacyPath, legacyBytes, 0600)
	if _, e = importer.Run(ctx, owner, legacyPath, "", false); e != nil {
		t.Fatal("legacy snapshot rejected", e)
	}
	// Unknown tables remain a hard error, even if all recognized tables exist.
	legacy.Tables["unexpected_business_data"] = []importer.Row{}
	legacyBytes, _ = json.Marshal(legacy)
	os.WriteFile(legacyPath, legacyBytes, 0600)
	if _, e = importer.Run(ctx, owner, legacyPath, "", false); e == nil {
		t.Fatal("unknown table accepted")
	}
	// A missing foreign key must roll back the entire import, including the archive.
	b, _ := os.ReadFile(snapshot)
	var invalid importer.Snapshot
	json.Unmarshal(b, &invalid)
	v := "missing-plan"
	invalid.Tables["orders"][0]["plan"] = &v
	bad, _ := json.Marshal(invalid)
	badPath := filepath.Join(dir, "invalid.json")
	os.WriteFile(badPath, bad, 0600)
	if _, e = importer.Run(ctx, owner, badPath, "", false); e == nil {
		t.Fatal("orphan order accepted")
	}
	owner.DB.QueryRow(ctx, `SELECT count(*) FROM legacy_import_rows`).Scan(&n)
	if n != 0 {
		t.Fatal("failed import left data")
	}
	if reason == "card_daily_limit" {
		json.Unmarshal(b, &invalid)
		wrongStage := "payment"
		invalid.Tables["xgift_recovery_attempts"][0]["previous_stage"] = &wrongStage
		bad, _ = json.Marshal(invalid)
		os.WriteFile(badPath, bad, 0600)
		if _, e = importer.Run(ctx, owner, badPath, "", false); e == nil {
			t.Fatal("daily-limit audit with a payment-stage attempt accepted")
		}
	}
	applied, e := importer.Run(ctx, owner, snapshot, report.SHA256, true)
	if e != nil || !applied.Applied {
		t.Fatal(e)
	}
	if _, e = importer.Reconcile(ctx, owner, report.SHA256); e != nil {
		t.Fatal(e)
	}
	if _, e = importer.Run(ctx, owner, snapshot, report.SHA256, true); e == nil {
		t.Fatal("nonempty target overwritten")
	}
	var accountPhone, accountName string
	var accountVersion int64
	if e := owner.DB.QueryRow(ctx, `SELECT phone,name,version FROM partner_payout_accounts WHERE partner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`).Scan(&accountPhone, &accountName, &accountVersion); e != nil || accountPhone != "13800000001" || accountName != "Fixture Receiver" || accountVersion != 4 {
		t.Fatal("payout account changed during import", e)
	}
	var localAttempt, remoteAttempt int64
	if e := owner.DB.QueryRow(ctx, `SELECT attempt_no,remote_attempt_no FROM recharge_redemptions WHERE id='local-accepted'`).Scan(&localAttempt, &remoteAttempt); e != nil || localAttempt != 2 || remoteAttempt != 1 {
		t.Fatal("platform ordinal was replaced by local attempt", e)
	}
	var rejectedOrdinal *int64
	if e := owner.DB.QueryRow(ctx, `SELECT remote_attempt_no FROM recharge_redemptions WHERE id='local-rejected'`).Scan(&rejectedOrdinal); e != nil || rejectedOrdinal != nil {
		t.Fatal("rejected attempt received an invented remote ordinal", e)
	}
	var checked int64
	if e := owner.DB.QueryRow(ctx, `SELECT checked_notify_version FROM recharge_orders WHERE order_id='YMX-RECHARGE'`).Scan(&checked); e != nil || checked != 3 {
		t.Fatal("unread notification was acknowledged", e)
	}
	var archivedCooldown string
	if e := owner.DB.QueryRow(ctx, `SELECT payload->>'next_allowed_at' FROM legacy_import_rows WHERE source_table='recharge_api_reads'`).Scan(&archivedCooldown); e != nil || archivedCooldown != "1700000300000" {
		t.Fatal("runtime metadata was silently discarded", e)
	}
	var hidden []string
	if e := owner.DB.QueryRow(ctx, `SELECT hidden_product_ids FROM partner_order_versions WHERE partner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`).Scan(&hidden); e != nil || len(hidden) != 1 || hidden[0] != "chatgpt" {
		t.Fatal("import lost product visibility", hidden, e)
	}
	var status, merchant string
	var version int
	owner.DB.QueryRow(ctx, `SELECT status,version FROM orders WHERE id='YMX-HISTORY'`).Scan(&status, &version)
	owner.DB.QueryRow(ctx, `SELECT supplier_merchant_order_no FROM xgift_purchases WHERE order_id='YMX-HISTORY'`).Scan(&merchant)
	if status != "processing" || version != 1 || merchant != "YMX-HISTORY:retry:1" {
		t.Fatal("historical recovery replayed")
	}
	var previousStage, previousReason string
	if e := owner.DB.QueryRow(ctx, `SELECT previous_stage,previous_failure_code FROM xgift_recovery_attempts`).Scan(&previousStage, &previousReason); e != nil || previousStage != stage || previousReason != reason {
		t.Fatal("production recovery extension lost", e)
	}
	var compositeAudit int
	if e := owner.DB.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE id='legacy:reconcile:order:2026-10-07'`).Scan(&compositeAudit); e != nil || compositeAudit != 1 {
		t.Fatal("legacy audit identity lost", e)
	}
	if _, e = app.DB.Exec(ctx, `SELECT payload FROM legacy_import_rows`); e == nil {
		t.Fatal("runtime can read offline archive")
	}
	if _, e = app.DB.Exec(ctx, `UPDATE xgift_recovery_attempts SET note='mutated'`); e == nil {
		t.Fatal("recovery immutability lost")
	}
	execSQL(t, owner, `UPDATE catalog_plans SET price_cents=price_cents+1 WHERE id='plus'`)
	if _, e = importer.Reconcile(ctx, owner, report.SHA256); e == nil {
		t.Fatal("reconciliation missed mutation")
	}
}
