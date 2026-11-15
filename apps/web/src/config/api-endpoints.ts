/**
 * Centralized API endpoint configuration.
 *
 * All external service URLs should be defined here so they can be
 * swapped for different environments or self-hosted instances.
 */

const isDev = import.meta.env.DEV;

/** OpenReel cloud services */
// N-REMOTE INTEGRATION: the cloud is opt-in. An unset or empty
// VITE_OPENREEL_CLOUD_URL means OFF in production (nothing leaves the host);
// dev keeps upstream's localhost default so upstream dev flows still work.
const configuredCloudUrl = import.meta.env.VITE_OPENREEL_CLOUD_URL;
export const OPENREEL_CLOUD_URL: string =
  typeof configuredCloudUrl === "string" && configuredCloudUrl !== ""
    ? configuredCloudUrl
    : isDev
      ? "http://localhost:8787"
      : "";

// N-REMOTE INTEGRATION
export const CLOUD_ENABLED = OPENREEL_CLOUD_URL !== "";

/**
 * Third-party API base URLs.
 * These are used by the api-proxy service in dev mode (direct calls)
 * and by the Cloudflare Pages Function proxy in production.
 * Application code should use apiFetch() from services/api-proxy.ts
 * instead of importing these directly.
 */
