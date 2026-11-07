package recharge

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestQuoteUsesCurrentFixedPriceContract(t *testing.T) {
	for _, tc := range []struct {
		name, supply, ceiling string
		quoted                bool
		price                 int64
		want                  bool
	}{
		{"historical ceiling is not a sale limit", "110.00", "159.00", false, 17000, true},
		{"missing historical ceiling", "110.00", "", false, 13900, true},
		{"dynamic zero is not a free fixed quote", "0.00", "999.00", true, 13900, false},
		{"sale below supply", "110.00", "999.00", false, 10900, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, _ := NewClient("https://supplier.example.test/v1", "tenant", "key", "synthetic-secret")
			client.HTTP.Transport = transport(func(r *http.Request) (*http.Response, error) {
				var data any = []map[string]string{{"code": "alipay"}}
				if r.URL.Path == "/v1/products" {
					data = []map[string]any{{"product_code": "plus", "supply_price": tc.supply, "max_sale_price": tc.ceiling, "quote_required": tc.quoted, "currency": "CNY", "max_quantity": 1, "available": true, "delivery_modes": []string{"auto_recharge"}}}
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(Raw(map[string]any{"data": data})))}, nil
			})
			s := &Service{Client: client, Checkout: true, Products: map[string]string{"plus": "plus"}, Notify: "https://shop.example.test/api/recharge/webhook"}
			_, err := s.Quote(context.Background(), "plus", tc.price, nil)
			if (err == nil) != tc.want {
				t.Fatalf("quote accepted=%t, want %t: %v", err == nil, tc.want, err)
			}
		})
	}
}

func TestNormalizeCredentialPreservesLongPayloadAndBoundsToken(t *testing.T) {
	for _, tc := range []struct {
		name       string
		credential Credential
		want       bool
	}{
		{"large metadata", Credential{Mode: "session", Session: Raw(map[string]any{"user": map[string]string{"email": "fixture@example.test"}, "accessToken": "fixture-token", "metadata": strings.Repeat("x", 50000)})}, true},
		{"long token", Credential{Mode: "access_token", AccessToken: strings.Repeat("x", 64*1024)}, true},
		{"token boundary", Credential{Mode: "access_token", AccessToken: strings.Repeat("x", 128*1024)}, true},
		{"oversize token", Credential{Mode: "session", Session: Raw(map[string]any{"user": map[string]string{"email": "fixture@example.test"}, "accessToken": strings.Repeat("x", 128*1024+1)})}, false},
		{"oversize raw", Credential{Mode: "session", Session: Raw(map[string]any{"accessToken": "fixture-token", "metadata": strings.Repeat("x", 256*1024)})}, false},
		{"raw token", Credential{Mode: "session", Session: "  fixture-token  "}, true},
		{"supported wrapper", Credential{Mode: "session", Session: ` {"auth":{"access_token":"fixture-token"}} `}, true},
		{"bad json", Credential{Mode: "session", Session: `{"accessToken":"broken"`}, false},
		{"missing token", Credential{Mode: "session", Session: `{"user":{"email":"fixture@example.test"}}`}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeCredential(tc.credential)
			if (err == nil) != tc.want {
				t.Fatalf("accepted=%t, want %t: %v", err == nil, tc.want, err)
			}
			if tc.want && got != tc.credential {
				t.Fatal("normalization changed the original idempotent credential bytes")
			}
		})
	}
}

func TestPrecheckDoesNotTreatSessionCookieAsAccessToken(t *testing.T) {
	for _, raw := range []string{`{"sessionToken":"private-cookie"}`, `{"auth":{"session":"private-cookie"}}`, `private-cookie`} {
		if _, _, err := precheckCredentialParts(Credential{Mode: "session", Session: raw}); err == nil {
			t.Fatal("session cookie accepted by access-token precheck")
		}
	}
	token, _, err := precheckCredentialParts(Credential{Mode: "session", Session: `{"sessionToken":"private-cookie","data":{"access_token":"allowed-token"}}`})
	if err != nil || token != "allowed-token" {
		t.Fatal("wrapped access token not selected", err)
	}
}
