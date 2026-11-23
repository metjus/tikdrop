const TIKTOK_HOSTS = ["tiktok.com"];
const VIDEO_CDN_SUFFIXES = [
  "tiktokcdn.com", "tiktokv.com", "byteoversea.com",
  "ibytedtos.com", "muscdn.com", "bytecdn.cn",
  "tiktokcdn-us.com", "bytefcdn-oversea.com"
];

function isTikTokPageHost(host) {
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}
function isAllowedVideoHost(host) {
  return VIDEO_CDN_SUFFIXES.some(s => host === s || host.endsWith("." + s));
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}
function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function decodeJsString(s) {
  return s.replace(/\\u002F/g, "/").replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/").replace(/&amp;/g, "&");
}
function collectVideoCandidates(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  let count = 0;
  while (stack.length && count++ < 30000) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) { for (const v of item) stack.push(v); continue; }
    const video = item.video;
    if (video && typeof video === "object") {
      const bitrate = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
      for (const b of bitrate) {
        const u = b?.PlayAddr?.UrlList || b?.playAddr?.urlList || [];
        for (const url of u) if (typeof url === "string") found.push({url, quality: b?.GearName || b?.gearName || "available"});
      }
      for (const key of ["playAddr", "downloadAddr", "play_addr", "download_addr"]) {
        const value = video[key];
        if (typeof value === "string") found.push({url:value, quality:key});
        if (value && Array.isArray(value.UrlList)) for (const url of value.UrlList) found.push({url, quality:key});
        if (value && Array.isArray(value.urlList)) for (const url of value.urlList) found.push({url, quality:key});
      }
    }
    for (const [k,v] of Object.entries(item)) {
      if (typeof v === "string" && /^(playAddr|downloadAddr|play_addr|download_addr)$/i.test(k)) {
        found.push({url:v, quality:k});
      } else if (v && typeof v === "object") stack.push(v);
    }
  }
  return found.map(x => ({...x, url: decodeJsString(decodeHtml(x.url))}))
    .filter(x => /^https?:\/\//i.test(x.url))
    .filter(x => { try { const u = new URL(x.url); return u.protocol === "https:" && isAllowedVideoHost(u.hostname); } catch { return false; } })
    .filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; });
}
function extractPageData(html) {
  const candidates = [];
  const scripts = [
    ...html.matchAll(/<script[^>]+id=["'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE)["'][^>]*>([\s\S]*?)<\/script>/gi)
  ];
  for (const match of scripts) {
    try { candidates.push(...collectVideoCandidates(JSON.parse(match[1]))); } catch {}
  }
  // Fallback for embedded JSON where TikTok changes the script wrapper.
  if (!candidates.length) {
    const patterns = [
      /"playAddr"\s*:\s*"((?:\\.|[^"\\])+)"/g,
      /"downloadAddr"\s*:\s*"((?:\\.|[^"\\])+)"/g,
      /"play_addr"\s*:\s*"((?:\\.|[^"\\])+)"/g
    ];
    for (const re of patterns) for (const m of html.matchAll(re)) {
      const url = decodeJsString(m[1]);
      try { const u = new URL(url); if (u.protocol === "https:" && isAllowedVideoHost(u.hostname)) candidates.push({url, quality:"available"}); } catch {}
    }
  }
  const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1]
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "TikTok video";
  const thumbnail = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i)?.[1] || "";
  const duration = html.match(/"duration"\s*:\s*(\d+)/)?.[1] || null;
  return { candidates, title: decodeHtml(title).replace(/&quot;/g, '"'), thumbnail: decodeHtml(thumbnail), duration };
}
async function resolveTikTok(input) {
  let current;
  try { current = new URL(input); } catch { throw new Error("Zadaj platný TikTok odkaz."); }
  if (current.protocol !== "https:" || !isTikTokPageHost(current.hostname)) throw new Error("Podporované sú iba HTTPS odkazy z TikToku.");
  // Resolve short links safely, following only TikTok-owned page hosts.
  for (let i = 0; i < 6; i++) {
    const res = await fetch(current.toString(), {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; VideoLinkResolver/1.0)", "accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12000)
    });
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("TikTok vrátil neplatné presmerovanie.");
      const next = new URL(loc, current);
      if (next.protocol !== "https:" || !isTikTokPageHost(next.hostname)) throw new Error("Odkaz presmeroval mimo TikToku.");
      current = next; continue;
    }
    if (!res.ok) throw new Error(`TikTok stránka nie je dostupná (HTTP ${res.status}).`);
    const html = await res.text();
    if (html.length > 8_000_000) throw new Error("Stránka je príliš veľká na spracovanie.");
    const data = extractPageData(html);
    if (!data.candidates.length) throw new Error("Video URL sa z verejnej stránky nepodarilo získať. TikTok môže vyžadovať prihlásenie alebo blokovať automatické načítanie.");
    return { ...data, videoUrl: data.candidates[0].url, sourceUrl: current.toString() };
  }
  throw new Error("Príliš veľa presmerovaní.");
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/api/resolve" && request.method === "POST") {
      try {
        const body = await request.json();
        if (typeof body.url !== "string" || body.url.length > 2048) return json({error:"Neplatný odkaz."},400);
        const result = await resolveTikTok(body.url.trim());
        return json({ title: result.title, thumbnail: result.thumbnail, duration: result.duration,
          downloadUrl: "/api/download?src=" + encodeURIComponent(result.videoUrl) });
      } catch (e) { return json({error: e.message || "Spracovanie zlyhalo."}, 422); }
    }
    if (url.pathname === "/api/download" && request.method === "GET") {
      const src = url.searchParams.get("src");
      if (!src || src.length > 8192) return new Response("Missing source", {status:400});
      let video;
      try { video = new URL(src); } catch { return new Response("Invalid source", {status:400}); }
      if (video.protocol !== "https:" || !isAllowedVideoHost(video.hostname)) return new Response("Blocked source", {status:403});
      try {
        let upstream;
        let current = video;
        for (let hop = 0; hop < 6; hop++) {
          upstream = await fetch(current.toString(), {
            redirect: "manual",
            headers: { "user-agent":"Mozilla/5.0", "referer":"https://www.tiktok.com/" },
            signal: AbortSignal.timeout(30000)
          });
          if ([301,302,303,307,308].includes(upstream.status)) {
            const location = upstream.headers.get("location");
            if (!location) return new Response("Invalid video redirect", {status:502});
            current = new URL(location, current);
            if (current.protocol !== "https:" || !isAllowedVideoHost(current.hostname)) return new Response("Blocked video redirect", {status:403});
            continue;
          }
          break;
        }
        if (!upstream || [301,302,303,307,308].includes(upstream.status) || !upstream.ok || !upstream.body) return new Response("Video source unavailable", {status:502});
        const headers = new Headers({
          "content-type": upstream.headers.get("content-type") || "video/mp4",
          "content-disposition": 'attachment; filename="tiktok-video.mp4"',
          "cache-control":"no-store", "x-content-type-options":"nosniff"
        });
        const len = upstream.headers.get("content-length"); if (len) headers.set("content-length",len);
        return new Response(upstream.body, {status:200,headers});
      } catch { return new Response("Download failed or timed out", {status:502}); }
    }
    return new Response("Not found", {status:404});
  }
};
function corsHeaders() { return { "access-control-allow-origin":"*", "access-control-allow-methods":"GET,POST,OPTIONS", "access-control-allow-headers":"content-type" }; }
