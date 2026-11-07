package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/domains"
	"gptibo/storefront/internal/httpapi"
	"gptibo/storefront/internal/recharge"
	"gptibo/storefront/internal/security"
)

func unsubmittedRechargeFixture(t *testing.T) recoveryFixture {
	t.Helper()
	owner, app, identity, base, mail := identityFixture(t)
	admin := login(t, base, mail, "admin", "")
	client, fake := newRechargeFake(t)
	s := &recharge.Service{CredentialSecret: strings.Repeat("ab", 32), Store: app, Client: client, Checkout: true, Products: map[string]string{"plus": "plus"}, Notify: testOrigin + "/api/recharge/webhook"}
	h := httpapi.Router(app, "fixture", slog.New(slog.NewTextHandler(io.Discard, nil)), httpapi.Options{Origin: testOrigin, Auth: identity, Recharge: s})
	execSQL(t, owner, `INSERT INTO catalog_plans(id,product_id,name,price_cents,enabled) VALUES('plus','chatgpt','Plus',10000,true)`)
	buyer := &http.Cookie{Name: "__Host-sf_buyer", Value: security.Token()}
	id := object(t, request(h, "POST", "/api/orders", map[string]any{"plan": "plus", "email": "buyer@example.test", "key": security.ID(), "expectedPrice": 10000}, buyer), 201)["order"].(map[string]any)["id"].(string)
	fake.order.Payment = "paid"
	if err := s.Sync(context.Background(), id, true); err != nil {
		t.Fatal(err)
	}
	return recoveryFixture{owner, s, fake, h, admin, buyer, id, security.ID(), `{"user":{"email":"fixture@example.test"},"accessToken":"synthetic-token"}`}
}

func submitCR(t *testing.T, f recoveryFixture, key, session string, want int) {
	t.Helper()
	object(t, request(f.handler, "POST", "/api/orders/"+f.id+"/fulfillment", map[string]any{"action": "submit", "key": key, "customerConfirmedEmail": true, "credential": map[string]any{"mode": "session", "session": session}}, f.buyer), want)
}

func TestCRRejectedRequestDoesNotConsumeUpstreamAttempt(t *testing.T) {
	f := unsubmittedRechargeFixture(t)
	reject := true
	f.service.Client.HTTP.Transport = rechargeTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/redemptions" && r.Method == "POST" && reject {
			return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_credential","retryable":false}}`))}, nil
		}
		return f.fake.round(r)
	})
	submitCR(t, f, f.attempt, f.session, 503)
	reject = false
	accepted := security.ID()
	submitCR(t, f, accepted, f.session, 200)
	var local, upstream int64
	var remote string
	if err := f.owner.DB.QueryRow(context.Background(), `SELECT attempt_no,remote_attempt_no,remote_id FROM recharge_redemptions WHERE id=$1`, accepted).Scan(&local, &upstream, &remote); err != nil || local != 2 || upstream != 1 || remote != "attempt" {
		t.Fatal("local request number was confused with upstream task", local, upstream, remote, err)
	}
	submitCR(t, f, accepted, f.session, 200)
	submitCR(t, f, accepted, f.session+" ", 409)
	// A real first task failure can still lead to a second accepted upstream attempt.
	f.failed()
	if err := f.service.Verify(context.Background(), f.id); err != nil {
		t.Fatal(err)
	}
	n := int64(2)
	f.fake.redemption.Attempt = &n
	f.fake.redemption.ID = "attempt-2"
	f.fake.redemption.Status = "queued"
	submitCR(t, f, security.ID(), f.session, 200)
	if f.fake.submitCalls != 2 || f.fake.createCalls != 1 {
		t.Fatal("retry created duplicate work or a new paid order")
	}
}

func TestCRLegacyUnknownAfterRejectedRequestRecoversOriginalTask(t *testing.T) {
	f := unsubmittedRechargeFixture(t)
	rejected, unknown := security.ID(), security.ID()
	execSQL(t, f.owner, `INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,created_at) VALUES($1,$3,1,'rejected','session','rejected',1),($2,$3,2,'unknown','session','unknown',2)`, rejected, unknown, f.id)
	f.fake.submitCalls = 1
	f.failed()
	if err := f.service.Verify(context.Background(), f.id); err != nil {
		t.Fatal(err)
	}
	var remote, status string
	if err := f.owner.DB.QueryRow(context.Background(), `SELECT COALESCE(remote_id,''),status FROM recharge_redemptions WHERE id=$1`, unknown).Scan(&remote, &status); err != nil || remote != "attempt" || status != "failed" {
		t.Fatal("pre-upgrade unknown did not recover its real task", remote, status, err)
	}
	if f.fake.submitCalls != 1 {
		t.Fatal("recovery resubmitted recharge")
	}
}

func TestCRFulfillmentAcceptsLongSessionWithinPublicBodyLimit(t *testing.T) {
	f := unsubmittedRechargeFixture(t)
	long := recharge.Raw(map[string]any{"user": map[string]string{"email": "fixture@example.test"}, "accessToken": "synthetic-token", "metadata": strings.Repeat("x", 50000)})
	submitCR(t, f, f.attempt, long, 200)
	var submitted struct {
		Credential recharge.Credential `json:"credential"`
	}
	if f.fake.submitCalls != 1 || json.Unmarshal([]byte(f.fake.bodies[0]), &submitted) != nil || submitted.Credential.Session != long {
		t.Fatal("long session not submitted unchanged")
	}
	oversized := recharge.Raw(map[string]any{"accessToken": "synthetic-token", "metadata": strings.Repeat("x", 256*1024)})
	submitCR(t, f, security.ID(), oversized, 400)
	if f.fake.submitCalls != 1 {
		t.Fatal("oversized body reached supplier")
	}
}

func TestCRPartnerEmailChallengesRemainScopedAcrossDomains(t *testing.T) {
	owner, _, identity, _, mail := identityFixture(t)
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,email,active) VALUES('domain-partner','DOM123','Partner','partner@example.test',true)`)
	root := context.Background()
	custom := domains.WithScope(root, domains.Scope{Host: "shop.example.test", PartnerID: "domain-partner"})
	first, err := identity.Send(root, "partner", auth.SendInput{Email: "partner@example.test"}, "192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	// Advance the fixture cooldown and creation ordering without sleeping.
	execSQL(t, owner, `UPDATE auth_limits SET reset_at=now()-interval '1 second'; UPDATE auth_challenges SET created_at=now()-interval '2 minutes'`)
	second, err := identity.Send(custom, "partner", auth.SendInput{Email: "partner@example.test"}, "192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		ctx context.Context
		id  string
	}{{root, first}, {custom, second}} {
		token, err := identity.Verify(tc.ctx, "partner", auth.VerifyInput{Email: "partner@example.test", Challenge: tc.id, Code: mail.get(tc.id).Code}, "192.0.2.1")
		if err != nil || token == "" {
			t.Fatal("valid domain-specific challenge was shadowed", err)
		}
	}
}

func TestCRUpstreamIdentityMismatchRemainsUnconfirmed(t *testing.T) {
	for _, kind := range []string{"attempt", "order"} {
		t.Run(kind, func(t *testing.T) {
			f := unsubmittedRechargeFixture(t)
			if kind == "attempt" {
				n := int64(2)
				f.fake.redemption.Attempt = &n
			} else {
				f.fake.redemption.Order = "different-order"
			}
			submitCR(t, f, f.attempt, f.session, 503)
			var remote *string
			var number *int64
			var status string
			if err := f.owner.DB.QueryRow(context.Background(), `SELECT remote_id,remote_attempt_no,status FROM recharge_redemptions WHERE id=$1`, f.attempt).Scan(&remote, &number, &status); err != nil || remote != nil || number != nil || status != "unknown" {
				t.Fatal("mismatched task was bound", err)
			}
			if f.fake.submitCalls != 1 || f.fake.createCalls != 1 {
				t.Fatal("identity failure created extra work")
			}
		})
	}
}

func TestCRRemoteAttemptMigrationPreservesHistory(t *testing.T) {
	f := newRecoveryFixture(t)
	ctx := context.Background()
	execSQL(t, f.owner, `INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,created_at) VALUES('migration-rejected',$1,2,'rejected','session','rejected',2),('migration-unknown',$1,3,'unknown','session','unknown',3)`, f.id)
	execSQL(t, f.owner, `ALTER TABLE recharge_redemptions DROP COLUMN remote_attempt_no;
DELETE FROM storefront_migrations WHERE name='034_recharge_remote_attempt.sql'`)
	var before, after string
	if err := f.owner.DB.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(a) ORDER BY attempt_no)::text FROM recharge_redemptions a WHERE order_id=$1`, f.id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.Migrate(ctx); err != nil {
		t.Fatal("migration replay", err)
	}
	if err := f.owner.DB.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(a)-'remote_attempt_no' ORDER BY attempt_no)::text FROM recharge_redemptions a WHERE order_id=$1`, f.id).Scan(&after); err != nil || before != after {
		t.Fatal("migration changed existing history", err)
	}
	var bound, unconfirmed int
	if err := f.owner.DB.QueryRow(ctx, `SELECT count(*) FILTER(WHERE remote_id IS NOT NULL AND remote_attempt_no IS NULL),count(*) FILTER(WHERE remote_id IS NULL AND remote_attempt_no IS NULL) FROM recharge_redemptions WHERE order_id=$1`, f.id).Scan(&bound, &unconfirmed); err != nil || bound != 1 || unconfirmed != 2 {
		t.Fatal("migration invented an upstream attempt", err)
	}
}

func TestCRLegacyBoundTaskLearnsActualRemoteNumber(t *testing.T) {
	f := unsubmittedRechargeFixture(t)
	execSQL(t, f.owner, `INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,remote_id,fallback,created_at) VALUES('old-rejected',$1,1,'rejected','session','rejected',NULL,0,1),('old-bound',$1,2,'bound','session','failed','attempt',1,2)`, f.id)
	f.fake.submitCalls = 1
	f.failed()
	if err := f.service.Verify(context.Background(), f.id); err != nil {
		t.Fatal("local ordinal was incorrectly treated as an upstream ordinal", err)
	}
	var local, remote int64
	if err := f.owner.DB.QueryRow(context.Background(), `SELECT attempt_no,remote_attempt_no FROM recharge_redemptions WHERE id='old-bound'`).Scan(&local, &remote); err != nil || local != 2 || remote != 1 {
		t.Fatal("legacy task identity not learned", local, remote, err)
	}
	n := int64(2)
	f.fake.redemption.Attempt = &n
	f.fake.redemption.ID = "attempt-2"
	f.fake.redemption.Status = "queued"
	submitCR(t, f, security.ID(), f.session, 200)
}

func TestCRLegacyUnknownResolvesUnnumberedPreviousTaskFirst(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "verified previous task", true: "missing supplier ordinal"}[missing], func(t *testing.T) {
			f := unsubmittedRechargeFixture(t)
			execSQL(t, f.owner, `INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,remote_id,fallback,created_at) VALUES('old-rejected',$1,1,'rejected','session','rejected',NULL,0,1),('old-bound',$1,2,'bound','session','failed','attempt',1,2),('old-unknown',$1,3,'unknown','session','unknown',NULL,0,3)`, f.id)
			f.fake.submitCalls = 1
			f.failed()
			old := f.fake.redemption
			if missing {
				old.Attempt = nil
			}
			n := int64(2)
			f.fake.redemption.Attempt = &n
			f.fake.redemption.ID = "attempt-2"
			f.service.Client.HTTP.Transport = rechargeTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/v1/redemptions/attempt" {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(recharge.Raw(map[string]any{"data": old})))}, nil
				}
				return f.fake.round(r)
			})
			err := f.service.Verify(context.Background(), f.id)
			var previous, current *int64
			var remote *string
			if scanErr := f.owner.DB.QueryRow(context.Background(), `SELECT (SELECT remote_attempt_no FROM recharge_redemptions WHERE id='old-bound'),remote_attempt_no,remote_id FROM recharge_redemptions WHERE id='old-unknown'`).Scan(&previous, &current, &remote); scanErr != nil {
				t.Fatal(scanErr)
			}
			if missing {
				if err == nil || previous != nil || current != nil || remote != nil {
					t.Fatal("missing supplier ordinal was guessed", err)
				}
			} else if err != nil || previous == nil || *previous != 1 || current == nil || *current != 2 || remote == nil || *remote != "attempt-2" {
				t.Fatal("old unknown was not recovered after verifying prior task", err)
			}
			if f.fake.submitCalls != 1 {
				t.Fatal("recovery submitted extra work")
			}
		})
	}
}
