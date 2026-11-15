# N-Remote Video: integration notes

## Purpose

This repo is a fork of OpenReel (a browser video editor). N-Remote turns it into "N-Remote Video": an editor that a calling app launches with a session and that sends the finished export back. All N-Remote code lives under `apps/web/src/integration/`; every edit to an upstream file is marked `// N-REMOTE INTEGRATION`.

## Pinned upstream

Upstream commit `367d7e90`. To rebase onto newer upstream:

```bash
git fetch upstream && git rebase upstream/main
```

Then grep for `N-REMOTE INTEGRATION` to re-check every touch point in upstream files.

## Launch contract

The calling app opens (new tab) `https://<editor-host>/?launch=<base64url(JSON)>`:

```json
{
  "v": 1,
  "app": "nremote-builder",
  "label": "N-Remote Builder",
  "returnUrl": "https://buildnow.n-remote.com/api/video-editor/deliver",
  "token": "<opaque, issued by the caller, short-lived>",
  "backUrl": "https://buildnow.n-remote.com/visual-editor/<projectId>",
  "maxBytes": 52428800,
  "suggested": { "container": "mp4", "preset": "web-1080p" },
  "expiresAt": "2026-11-15T18:00:00Z"
}
```

- `app`, `label`, `returnUrl`, `token` are required; the rest optional.
- The editor **validates `returnUrl`'s origin against an allowlist baked in at
  build time** (`VITE_ALLOWED_RETURN_ORIGINS`, comma-separated). A launch with
  a non-allowlisted origin is refused with a visible message and the editor
  opens as a plain editor. This is so a crafted link cannot make the editor upload to an arbitrary host.
- The editor stores the launch session in `sessionStorage` (survives reloads
  in that tab, dies with it), strips `?launch=` from the URL, and shows a
  small banner "Editing for <label>".
- `maxBytes`: when set, the export dialog warns before export when the
  configured bitrate × duration would exceed it, and refuses delivery (not
  export) of a file above it.
- `suggested` is accepted and ignored in this version (reserved: a future
  version preselects container/preset).
- Reserved for a later phase: `assets: [{url, name}]` to pre-load the caller's
  media. Not implemented now; the field is documented as reserved so
  callers do not invent their own.
- The editor does **not** verify the token. It cannot keep a secret (static
  site) and does not need to: the token only has to satisfy the receiver.

## Delivery contract

OpenReel's export runner already has an `ExportDeliveryMode` of `"download" |
"file"` (`apps/web/src/services/export-runner.ts`) and the export dialog shows
it as "Save video". We add a third mode, **`"send"`**, offered only when a
launch session exists, labelled "Send to <label>".

**Why two steps, not one POST.** Serverless receivers cannot take a video in
the request body: Vercel functions cap bodies at 4.5 MB (the builder already
works around this for images and documents by uploading straight to Supabase
Storage and then "registering" the row, see `api/projects/[id]/media/register`).
So delivery is *init → upload → complete*, and the receiver decides where the
bytes go. A receiver that can take bodies directly may return its own URL as
the upload target; the editor does not care.

On export completion in `send` mode:

1. The export is **also kept as a normal download** (Blob + "Download" button
   in the result panel, or the regular download). The user never loses the file.
2. **Init:** `POST <returnUrl>` JSON, `Authorization: Bearer <token>`:
   `{ v: 1, app, filename, mimeType, sizeBytes, durationSec, width, height }`.
   The receiver checks the token, the type, the size against its own limits
   and the user's quota, and answers
   `200 { ok: true, upload: { url, method: "PUT", headers?: {...} }, completeUrl }`
   or `4xx { ok: false, message }`. Nothing has been uploaded yet, so a refusal
   here is cheap and the message is shown as-is.
3. **Upload:** the editor sends the Blob with XHR (`method`, `headers` as given,
   body = the file) to `upload.url`, showing a progress bar. The upload target's
   origin **must be on the editor's build-time allowlist**
   `VITE_ALLOWED_UPLOAD_ORIGINS` (for the builder: the Supabase project host),
   in addition to `returnUrl` being on `VITE_ALLOWED_RETURN_ORIGINS`. Two
   allowlists because the receiver and the storage are different hosts; a
   receiver on the allowlist cannot redirect bytes to an arbitrary host.
4. **Complete:** `POST <completeUrl>` JSON, same Bearer token:
   `{ v: 1, filename, mimeType, sizeBytes, durationSec, width, height }`.
   The receiver verifies the object exists where it expected it, writes its
   own record, and answers `200 { ok: true, url?, message? }` or `4xx/5xx
   { ok: false, message }`.
5. Result panel: success → message + "Back to <label>" (`backUrl`, when
   given); failure at any step → the receiver's `message`, a Retry button
   (restarts from init with the same Blob), and the Download button. 401/403
   → "Your session for <label> has expired — download the file and upload it
   there." No automatic retry loop.

Cross-origin notes: the editor serves itself with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` (upstream `apps/web/public/_headers`, needed for ffmpeg.wasm's
SharedArrayBuffer). A CORS `fetch`/XHR to the receiver is allowed under those
headers; the **receiver must answer the preflight** (`OPTIONS`) with
`Access-Control-Allow-Origin: https://<editor-host>`, `Allow-Headers:
authorization, content-type`, `Allow-Methods: POST, OPTIONS`. Upstream also sends
`X-Frame-Options: DENY`; we keep it (no iframe embedding in this version).

Size limits: upstream refuses an in-memory download above 128 MB and prefers
the File System Access API "choose a file location" path. `send` mode needs
the Blob in memory; the builder's `maxBytes` (50 MB today) is well under that.
A caller with a larger `maxBytes` gets the same 128 MB ceiling; documented.
The Supabase `media` bucket's own `file_size_limit` must be at least the
builder's `maxBytes` — **check it before setting `maxBytes`** (documents
already upload 25 MB directly, so it is at least that; 50 MB is unverified).

## Receiver obligations

A receiver (the app that launches the editor) must satisfy all of the following.

1. **Return origin allowlisted.** The origin of `returnUrl` must be on the editor's `VITE_ALLOWED_RETURN_ORIGINS`.
2. **Upload origin allowlisted.** The origin of the init response's `upload.url` must be on the editor's `VITE_ALLOWED_UPLOAD_ORIGINS`.
3. **`completeUrl` has exactly the same origin as `returnUrl`.** The editor refuses otherwise, because the Bearer token is posted to `completeUrl`.
4. **CORS.** Both `returnUrl` and `completeUrl` must answer the `OPTIONS` preflight with:
   - `Access-Control-Allow-Origin: <editor origin>`
   - `Access-Control-Allow-Methods: POST, OPTIONS`
   - `Access-Control-Allow-Headers: authorization, content-type`

   The upload target is PUT directly by the browser and must accept CORS from the editor origin as well (Supabase signed upload URLs do).
5. **Token.** The token is opaque to the editor. It must be short-lived and single-purpose. Check it on init and on complete.
6. **Response shapes.**
   - Init: `200 { ok: true, upload: { url, method: "PUT", headers? }, completeUrl }`.
   - Complete: `200 { ok: true, url?, message? }`.
   - Failures: `{ ok: false, message }`. A 401 or 403 means "session expired" and the editor says so.
7. **Absolute URLs.** `upload.url` and `completeUrl` must be absolute URLs; relative ones are refused.
8. **`https:` origins.** Every origin on either allowlist must be `https:`. Only `http://localhost[:port]` is exempt, for development.
9. **`backUrl`** must be http(s) or it is ignored.
10. **`maxBytes`** is advisory in the export dialog (a warning before export) and is enforced before the upload starts.

## Environment variables

All are build-time (Vite) variables. Set them in `apps/web/.env` locally (see `apps/web/.env.example`) or in the Cloudflare Pages project. **An empty value counts as unset**, so the default applies.

| Variable | Required? | Default | Meaning |
| --- | --- | --- | --- |
| `VITE_ALLOWED_RETURN_ORIGINS` | Required for launch | none | Comma-separated origins a launch `returnUrl` may use. |
| `VITE_ALLOWED_UPLOAD_ORIGINS` | Required for delivery | none | Comma-separated origins an upload target may use. |
| `VITE_BRAND_NAME` | No | `N-Remote Video` | Product name shown in the editor. |
| `VITE_BRAND_LOGO_URL` | No | OpenReel's own logo | Logo shown in the editor. Must be a same-origin path such as `/brand/logo.svg` under `apps/web/public`, because the page is served with `Cross-Origin-Embedder-Policy: require-corp`. |
| `VITE_OPENREEL_CLOUD_URL` | No | empty (cloud off) | Upstream OpenReel cloud URL. Leave empty to switch share links and cloud templates off. |
| `VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST` | No | empty (analytics off) | PostHog analytics. Leave empty. |

The two allowlists are **required** for launch and delivery to work at all. With both empty, every launch is refused and the editor behaves as plain OpenReel.

## Hosting

Cloudflare Pages project `build-video`:

- URL: `https://build-video.pages.dev`. The custom domain `video.n-remote.com` will be attached later.
- Git: GitHub `squartier/openreel-video`, production branch `main`.
- Framework preset: None.
- Root directory: `apps/web`. Upstream's `functions/` directory (the AI key relay at `functions/api/proxy`) lives there, so the root must be `apps/web` for Pages to deploy it.
- Build command: `pnpm -w install --frozen-lockfile && pnpm -w build`
- Build output directory: `dist`

Build environment variables:

- `NODE_VERSION=22`
- `PNPM_VERSION=11.7.0`
- `SKIP_DEPENDENCY_INSTALL=1`

App environment variables (set for **both Production and Preview** in the Pages project):

- `VITE_ALLOWED_RETURN_ORIGINS=https://buildnow.n-remote.com`
- `VITE_ALLOWED_UPLOAD_ORIGINS=https://qvedzwdlpdhzoumuxcsc.supabase.co`
- `VITE_BRAND_NAME=N-Remote Video`
- `VITE_BRAND_LOGO_URL`: optional, same-origin path only (see the table above).
- `VITE_OPENREEL_CLOUD_URL`: left **empty** (cloud off).

`apps/web/wrangler.toml` sits in the Pages root directory (`apps/web`), so Pages reads it.

**First build:** open a good launch link and confirm it is accepted (the "Editing for <label>" banner shows). If every launch is refused, the `VITE_*` values did not reach the build: they are baked in at build time, so set them in the Pages project and rebuild.

`apps/web/public/_headers` sets COOP/COEP for static responses only. Pages Functions responses (the `functions/api/proxy` AI key relay) are JSON fetches and do not need them.

## What is switched off on this host

- Share links and cloud templates: they need the upstream cloud, and `VITE_OPENREEL_CLOUD_URL` is empty.
- PostHog analytics: the keys are empty.

AI editing (OpenAI, Anthropic, ElevenLabs) works with the user's own key, relayed by the same-origin Pages Function.

**Known external dependencies (inbound only):**

- Auto-caption models are downloaded by the browser from `https://media.openreel.video/models/` (`apps/web/src/workers/whisper-worker.ts`). No user content is sent there, but captions depend on that host being up. Follow-up: point `MODEL_HOST` at the Hugging Face default when the cloud is off.
- Video stabilization downloads its vidstab wasm build from `https://mediashares.openreel.video/ffmpeg-vidstab/` (`packages/core/src/video/stabilization/vidstab-engine.ts:26-27`). Same framing: no user content is sent there, but stabilization depends on that host being up.

## Rebasing on upstream

```bash
git fetch upstream && git rebase upstream/main
```

Then re-check every touch point in upstream files:

```bash
grep -rn "N-REMOTE INTEGRATION" apps/web/src apps/web/index.html
```

lists every upstream edit. `apps/web/src/vite-env.d.ts` and `apps/web/index.html` are N-Remote touch points that may collide if upstream adds its own changes there.

The fork deletes four upstream workflows (`.github/workflows/claude.yml`, `copilot-code-review.yml`, `label-for-claude.yml`, `release.yml`). If upstream edits one of them, the rebase reports a modify/delete conflict; resolve it by deleting the file again (`git rm <file>`).

## Manual acceptance checklist

Run these on the deployed site (`https://build-video.pages.dev`).

- [ ] Open `/` with no `?launch=`: plain OpenReel loads, no banner.
- [ ] Open `/?launch=<base64url(good launch with returnUrl on buildnow.n-remote.com)>`: the banner "Editing for N-Remote Builder" shows, the URL no longer contains `launch`, and a reload keeps the banner.
- [ ] Open with a `returnUrl` on another origin: an alert banner shows, there is no Send option, and DevTools Network shows no request to that origin.
- [ ] Import a clip and export with "Send to N-Remote Builder" against the builder's production endpoints. Until the adapter is deployed, check that the init request is sent and a 404/503 shows as a failure with Download still available.
- [ ] Import a clip and export with "Download to this device": behaviour is unchanged.
