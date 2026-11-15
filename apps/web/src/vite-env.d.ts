/// <reference types="vite/client" />

// N-REMOTE INTEGRATION: typed build-time env for the N-Remote launch/delivery layer.
interface ImportMetaEnv {
  /** Comma-separated origins a launch `returnUrl` may point at. */
  readonly VITE_ALLOWED_RETURN_ORIGINS?: string;
  /** Comma-separated origins a delivery upload target may point at. */
  readonly VITE_ALLOWED_UPLOAD_ORIGINS?: string;
  /** Product name shown in the editor chrome. */
  readonly VITE_BRAND_NAME?: string;
  /** Logo image URL shown in the editor chrome. */
  readonly VITE_BRAND_LOGO_URL?: string;
  /** Optional OpenReel cloud URL; empty disables it. */
  readonly VITE_OPENREEL_CLOUD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
