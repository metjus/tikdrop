# TikDrop — Cloudflare Worker

Mobile-first TikTok URL resolver/downloader. No external downloader API or database.

## Deploy
1. Install Node.js and run `npm install`.
2. Run `npx wrangler login`.
3. Run `npx wrangler deploy`.

The Worker serves `public/index.html` through Cloudflare Workers Static Assets and handles `/api/resolve` and `/api/download`.

## Important limitations
- This is a best-effort parser of publicly accessible TikTok page HTML/embedded JSON. TikTok frequently changes its markup, rate-limits automated requests, or requires cookies/login. In those cases resolution will fail.
- It does not bypass login, private-account restrictions, DRM, signatures, CAPTCHAs, or other access controls.
- It cannot guarantee watermark-free output. The file returned is whichever publicly exposed video URL the page provides first; TikTok may expose a watermarked rendition.
- Download only videos you own or are authorized to download.
- This project has no third-party downloader API, but it necessarily fetches the TikTok page and TikTok's video CDN to retrieve the content.

## Security notes
The resolver accepts only HTTPS TikTok page URLs and follows redirects only to TikTok domains. The download proxy accepts only HTTPS URLs on a fixed allowlist of TikTok/ByteDance video CDN suffixes. Do not broaden these allowlists without reviewing SSRF implications.

## Local development
`npm run dev`

## Troubleshooting
If a public video cannot be resolved, TikTok may have changed its page structure or blocked the Worker request. This implementation intentionally reports an error instead of pretending the download succeeded.
