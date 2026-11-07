package management

import (
	"context"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/fault"
)

func (s Service) PlatformBranding(ctx context.Context) (Branding, error) {
	var b Branding
	e := s.Store.DB.QueryRow(ctx, `SELECT name,logo,page_title,headline,description,version FROM platform_branding WHERE id=1`).Scan(&b.Name, &b.Logo, &b.PageTitle, &b.Headline, &b.Description, &b.Version)
	return b, e
}

func (s Service) SavePlatformBranding(ctx context.Context, token string, in Branding) error {
	logo := in.Logo
	in.Logo = ""
	in, e := cleanBranding(in)
	if e != nil {
		return e
	}
	if logo != "" {
		// The browser normalizes JPG/PNG uploads to PNG before submission.
		if !strings.HasPrefix(logo, "data:image/png;base64,") {
			return fault.New(400, "请通过上传按钮选择 Logo。")
		}
		prepared, err := prepareLogo("platform", logo)
		if err != nil {
			return err
		}
		in.Logo = "data:image/png;base64," + prepared.Data
	}
	return s.write(ctx, "admin", token, func(tx pgx.Tx, p auth.Principal) error {
		tag, e := tx.Exec(ctx, `UPDATE platform_branding SET name=$1,logo=$2,page_title=$3,headline=$4,description=$5,version=version+1 WHERE id=1 AND version=$6`, in.Name, in.Logo, in.PageTitle, in.Headline, in.Description, in.Version)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return conflict()
		}
		return audit(ctx, tx, p, "platform-branding", "platform", map[string]any{"name": in.Name, "hasLogo": in.Logo != "", "version": in.Version + 1})
	})
}

func (s Service) PlatformAnnouncement(ctx context.Context) (map[string]any, error) {
	out, e := rows(ctx, s.Store.DB, `SELECT enabled,placement,title,content,version FROM platform_announcements WHERE id=1`)
	if e != nil {
		return nil, e
	}
	if len(out) != 1 {
		return nil, fault.New(503, "主站公告暂不可用。")
	}
	return out[0], nil
}

func (s Service) SavePlatformAnnouncement(ctx context.Context, token string, in Announcement) error {
	if in.Enabled == nil || in.Version == nil || *in.Version < 0 || (in.Placement != "home" && in.Placement != "product" && in.Placement != "both") || !validText(in.Title, 80) || !validText(in.Content, 5000) || strings.ContainsFunc(in.Title, unicode.IsControl) || strings.ContainsFunc(in.Content, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) {
		return fault.New(400, "公告内容或版本无效。")
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Content = strings.TrimSpace(in.Content)
	if *in.Enabled && (in.Title == "" || in.Content == "") {
		return fault.New(400, "启用公告前，请填写标题和内容。")
	}
	return s.write(ctx, "admin", token, func(tx pgx.Tx, p auth.Principal) error {
		tag, e := tx.Exec(ctx, `UPDATE platform_announcements SET enabled=$1,placement=$2,title=$3,content=$4,version=version+1 WHERE id=1 AND version=$5`, *in.Enabled, in.Placement, in.Title, in.Content, *in.Version)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return conflict()
		}
		return audit(ctx, tx, p, "platform-announcement", "platform", map[string]any{"enabled": *in.Enabled, "version": *in.Version + 1})
	})
}
