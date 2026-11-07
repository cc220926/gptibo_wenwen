package httpapi

import (
	"github.com/gin-gonic/gin"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/management"
)

func registerPlatformSettings(admin *gin.RouterGroup, m management.Service, token func(*gin.Context, string) string) {
	admin.GET("/branding", func(c *gin.Context) {
		out, e := m.PlatformBranding(c.Request.Context())
		if e != nil {
			fail(c, e)
			return
		}
		c.JSON(200, out)
	})
	admin.POST("/branding/logo", func(c *gin.Context) {
		var in struct {
			Logo string `json:"logo"`
		}
		if !readLimit(c, &in, 360000) {
			return
		}
		out, e := m.PrepareLogo(c.Request.Context(), "platform", in.Logo)
		if e != nil {
			fail(c, e)
			return
		}
		c.JSON(200, gin.H{"logo": "data:image/png;base64," + out.Data})
	})
	admin.POST("/branding", func(c *gin.Context) {
		var in struct {
			management.Branding
			Revision *int64 `json:"version"`
		}
		if !readLimit(c, &in, 360000) {
			return
		}
		if in.Revision == nil {
			fail(c, fault.New(400, "设置版本无效，请刷新后重试。"))
			return
		}
		in.Branding.Version = *in.Revision
		if e := m.SavePlatformBranding(c.Request.Context(), token(c, "admin"), in.Branding); e != nil {
			fail(c, e)
			return
		}
		out, e := m.PlatformBranding(c.Request.Context())
		if e != nil {
			fail(c, e)
			return
		}
		c.JSON(200, out)
	})
	announcement := func(c *gin.Context) {
		if c.Request.Method == "POST" {
			var in management.Announcement
			if !readLimit(c, &in, 32768) {
				return
			}
			if e := m.SavePlatformAnnouncement(c.Request.Context(), token(c, "admin"), in); e != nil {
				fail(c, e)
				return
			}
		}
		out, e := m.PlatformAnnouncement(c.Request.Context())
		if e != nil {
			fail(c, e)
			return
		}
		c.JSON(200, out)
	}
	admin.GET("/announcement", announcement)
	admin.POST("/announcement", announcement)
}
