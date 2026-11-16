// N-REMOTE INTEGRATION: in-app branding, overridable per host at build time.
const name = (import.meta.env.VITE_BRAND_NAME as string | undefined)?.trim();
const logo = (import.meta.env.VITE_BRAND_LOGO_URL as string | undefined)?.trim();

export const BRAND_NAME: string = name ? name : "NR Video";
export const BRAND_LOGO_URL: string = logo ? logo : "/brand/logo.png";
