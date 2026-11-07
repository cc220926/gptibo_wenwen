package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func TestPlatformSettingsIsolationValidationAndReset(t *testing.T) {
	owner, _, _, h, mail := identityFixture(t)
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,email,active) VALUES('a','AAAAAA','Account A','a@example.test',true);INSERT INTO partner_branding(partner_id,name,page_title) VALUES('a','分站店铺','分站标题');INSERT INTO partner_announcements(partner_id,enabled,placement,title,content) VALUES('a',true,'both','分站公告','分站内容')`)
	admin := login(t, h, mail, "admin", "")
	partner := login(t, h, mail, "partner", "a@example.test")
	path := "/api/admin/branding"
	in := map[string]any{"name": " 星河主站 ", "logo": "", "pageTitle": "星河订阅", "headline": "欢迎来到星河", "description": "按需选择服务", "version": 0}
	object(t, request(h, "GET", path, nil, nil), 401)
	object(t, request(h, "POST", path, in, partner), 401)
	object(t, request(h, "POST", path, in, nil), 401)
	initial := object(t, request(h, "GET", path, nil, admin), 200)
	if initial["name"] != "" || initial["version"] != float64(0) {
		t.Fatal(initial)
	}
	// Missing and null revisions must not silently become version zero.
	for _, bad := range []map[string]any{{"name": "bad"}, {"name": "bad", "version": nil}, {"name": strings.Repeat("字", 33), "version": 0}, {"headline": "bad\ncopy", "version": 0}, {"logo": "https://evil.invalid/logo.svg", "version": 0}} {
		object(t, request(h, "POST", path, bad, admin), 400)
	}
	var raw bytes.Buffer
	if e := png.Encode(&raw, image.NewNRGBA(image.Rect(0, 0, 2, 2))); e != nil {
		t.Fatal(e)
	}
	logo := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(raw.Bytes(), []byte("private metadata")...))
	uploaded := object(t, request(h, "POST", path+"/logo", map[string]any{"logo": logo}, admin), 200)
	clean := uploaded["logo"].(string)
	decoded, e := base64.StdEncoding.DecodeString(strings.TrimPrefix(clean, "data:image/png;base64,"))
	if e != nil || bytes.Contains(decoded, []byte("private metadata")) {
		t.Fatal("unsafe logo retained")
	}
	in["logo"] = clean
	saved := object(t, request(h, "POST", path, in, admin), 200)
	if saved["name"] != "星河主站" || saved["version"] != float64(1) {
		t.Fatal(saved)
	}
	object(t, request(h, "POST", path, in, admin), 409)
	notice := map[string]any{"enabled": true, "placement": "both", "title": "主站公告", "content": "主站内容\n第二行", "version": 0}
	object(t, request(h, "POST", "/api/admin/announcement", notice, partner), 401)
	object(t, request(h, "POST", "/api/admin/announcement", notice, admin), 200)
	object(t, request(h, "POST", "/api/admin/announcement", notice, admin), 409)
	main := object(t, request(h, "GET", "/api/catalog", nil, nil), 200)
	brand := main["platformBranding"].(map[string]any)
	if main["partner"] != nil || brand["name"] != "星河主站" || brand["logo"] != clean || brand["pageTitle"] != "星河订阅" || main["announcement"].(map[string]any)["title"] != "主站公告" {
		t.Fatal("platform settings not applied")
	}
	sub := object(t, request(h, "GET", "/api/catalog?partner=AAAAAA", nil, nil), 200)
	if sub["platformBranding"] != nil || sub["partner"].(map[string]any)["brandName"] != "分站店铺" || sub["announcement"].(map[string]any)["title"] != "分站公告" {
		t.Fatal("partner settings overwritten")
	}
	var audits int
	if e := owner.DB.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action IN ('platform-branding','platform-announcement') AND target='platform'`).Scan(&audits); e != nil || audits != 2 {
		t.Fatal("audit missing", audits, e)
	}
	object(t, request(h, "POST", path, map[string]any{"name": "", "logo": "", "pageTitle": "", "headline": "", "description": "", "version": 1}, admin), 200)
	object(t, request(h, "POST", "/api/admin/announcement", map[string]any{"enabled": false, "placement": "home", "title": "站点公告", "content": "", "version": 1}, admin), 200)
	reset := object(t, request(h, "GET", "/api/catalog", nil, nil), 200)
	if reset["platformBranding"].(map[string]any)["name"] != "" || reset["announcement"] != nil {
		t.Fatal("reset failed")
	}
}

func TestPlatformSettingsMigrationPreservesPartners(t *testing.T) {
	owner, app := fixture(t, true)
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,active) VALUES('a','AAAAAA','Existing',true);INSERT INTO partner_branding(partner_id,name,version) VALUES('a','原来的分站',7);DROP TABLE platform_branding,platform_announcements;DELETE FROM storefront_migrations WHERE name='035_platform_store_settings.sql'`)
	ctx := context.Background()
	if e := owner.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	if e := owner.GrantRuntime(ctx, app.DB.Config().ConnConfig.User, app.DB.Config().ConnConfig.Password); e != nil {
		t.Fatal(e)
	}
	if e := app.VerifyRuntime(ctx); e != nil {
		t.Fatal(e)
	}
	if e := owner.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	var intact bool
	if e := app.DB.QueryRow(ctx, `SELECT name='原来的分站' AND version=7 FROM partner_branding WHERE partner_id='a'`).Scan(&intact); e != nil || !intact {
		t.Fatal("partner changed", e)
	}
	execSQL(t, app, `UPDATE platform_branding SET name='主站';UPDATE platform_announcements SET title='公告'`)
}
