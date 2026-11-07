package recharge

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"gptibo/storefront/internal/fault"
)

const maxCredentialBytes = 256 * 1024
const maxTokenBytes = 128 * 1024

// Extract for validation only. The original credential bytes are retained for
// the submission hash, receipt and any replay using the same idempotency key.
func credentialParts(c Credential) (string, map[string]json.RawMessage, error) {
	raw := c.Session
	keys := []string{"sessionToken", "session", "accessToken", "access_token"}
	if c.Mode == "access_token" {
		raw = c.AccessToken
		keys = []string{"accessToken", "access_token"}
	} else if c.Mode != "session" {
		return "", nil, fault.New(400, "请选择有效的凭据类型。")
	}
	invalid := func() (string, map[string]json.RawMessage, error) {
		return "", nil, fault.New(400, "Session 内容无效、缺少凭据或超出长度限制，请重新获取。")
	}
	if len(raw) > maxCredentialBytes || !utf8.ValidString(raw) {
		return invalid()
	}
	token := strings.TrimSpace(raw)
	if token == "" {
		return invalid()
	}
	var selected map[string]json.RawMessage
	if strings.HasPrefix(token, "{") || strings.HasPrefix(token, "[") {
		var root map[string]json.RawMessage
		if json.Unmarshal([]byte(token), &root) != nil || root == nil {
			return invalid()
		}
		containers := []map[string]json.RawMessage{root}
		for _, wrapper := range []string{"data", "auth"} {
			var nested map[string]json.RawMessage
			if json.Unmarshal(root[wrapper], &nested) == nil && nested != nil {
				containers = append(containers, nested)
			}
		}
		token = ""
		for _, object := range containers {
			for _, key := range keys {
				var value string
				if json.Unmarshal(object[key], &value) == nil && strings.TrimSpace(value) != "" {
					token, selected = strings.TrimSpace(value), object
					break
				}
			}
			if token != "" {
				if len(selected["expires"]) == 0 || string(selected["expires"]) == "null" {
					selected["expires"] = root["expires"]
				}
				break
			}
		}
	}
	if token == "" || len(token) > maxTokenBytes {
		return invalid()
	}
	return token, selected, nil
}

// The precheck service accepts an access token, never a session cookie. A
// session credential must explicitly contain an accessToken/access_token field.
func precheckCredentialParts(c Credential) (string, map[string]json.RawMessage, error) {
	if c.Mode == "session" {
		if !strings.HasPrefix(strings.TrimSpace(c.Session), "{") {
			return "", nil, fault.New(400, "账号检测需要包含 Access Token 的完整 Session。")
		}
		c = Credential{Mode: "access_token", AccessToken: c.Session}
	}
	return credentialParts(c)
}

func normalizeCredential(c Credential) (Credential, error) {
	if _, _, err := credentialParts(c); err != nil {
		return c, err
	}
	if c.Mode == "session" {
		c.AccessToken = ""
	} else {
		c.Session = ""
	}
	return c, nil
}
