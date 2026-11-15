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
  opens as a plain editor. This is the anti-leak guard from §4.
- The editor stores the launch session in `sessionStorage` (survives reloads
  in that tab, dies with it), strips `?launch=` from the URL, and shows a
  small banner "Editing for <label>".
- `maxBytes`: when set, the export dialog warns before export when the
  configured bitrate × duration would exceed it, and refuses delivery (not
  export) of a file above it.
- `suggested` preselects export settings; the user can change them.
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

Cross-origin notes (verified): the editor serves itself with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` (upstream `apps/web/public/_headers`, needed for ffmpeg.wasm's
SharedArrayBuffer). A CORS `fetch`/XHR to the receiver is allowed under those
headers; the **receiver must answer the preflight** (`OPTIONS`) with
`Access-Control-Allow-Origin: https://<editor-host>`, `Allow-Headers:
authorization, content-type`, `Allow-Methods: POST`. Upstream also sends
`X-Frame-Options: DENY`; we keep it (no iframe embedding in this version).

Size limits: upstream refuses an in-memory download above 128 MB and prefers
the File System Access API "choose a file location" path. `send` mode needs
the Blob in memory; the builder's `maxBytes` (50 MB today) is well under that.
A caller with a larger `maxBytes` gets the same 128 MB ceiling; documented.
The Supabase `media` bucket's own `file_size_limit` must be at least the
builder's `maxBytes` — **check it before setting `maxBytes`** (documents
already upload 25 MB directly, so it is at least that; 50 MB is unverified).

## Receiver obligations

- Answer the CORS preflight (`OPTIONS`) with `Access-Control-Allow-Origin: https://<editor-host>`, `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Allow-Methods: POST`.
- Check the Bearer token on init and complete; answer 401/403 for a bad or expired token.
- Respond with the documented shapes: init `200 { ok: true, upload: { url, method: "PUT", headers? }, completeUrl }` or `4xx { ok: false, message }`; complete `200 { ok: true, url?, message? }` or `4xx/5xx { ok: false, message }`.
- The upload URL is single-use, and its origin must be on the editor's `VITE_ALLOWED_UPLOAD_ORIGINS`.

## Environment variables

Build-time, set in `apps/web/.env` (see `apps/web/.env.example`):

- `VITE_ALLOWED_RETURN_ORIGINS`: comma-separated origins a launch `returnUrl` may use.
- `VITE_ALLOWED_UPLOAD_ORIGINS`: comma-separated origins an upload target may use.
- `VITE_BRAND_NAME`: product name shown in the editor.
- `VITE_BRAND_LOGO_URL`: logo image URL shown in the editor.
- `VITE_OPENREEL_CLOUD_URL`: OpenReel cloud URL; empty by default.

## Hosting

To be filled in Task 9.
