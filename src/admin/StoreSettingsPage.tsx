import { BrandingSettings } from '@/partner/BrandingSettings'
import { AnnouncementSettingsPanel } from '@/components/announcement-settings'

export function StoreSettingsPage({ revision }: { revision: number }) {
  return <>
    <BrandingSettings endpoint="/api/admin/branding" revision={revision} readOnly={false} platform />
    <AnnouncementSettingsPanel endpoint="/api/admin/announcement" revision={revision} />
  </>
}
