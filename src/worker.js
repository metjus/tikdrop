
const VIDEO_CDN_SUFFIXES = [
  "tiktokcdn.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com",
  "muscdn.com", "bytecdn.cn", "tiktokcdn-us.com", "bytefcdn-oversea.com"
];

function isTikTokHost(host) {
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function isAllowedVideoHost(host) {
  return VIDEO_CDN_SUFFIXES.some(s => host === s || host.endsWith("." + s));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function decodeString(value) {
  let s = String(value);
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/").replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return s;
}

function addCandidate(out, value, quality = "available") {
  const values = typeof value === "string" ? [value]
    : Array.isArray(value) ? value
    : value && typeof value === "object"
      ? (value.UrlList || value.urlList || value.url_list || []) : [];

  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const decoded = decodeString(raw);
    try {
      const u = new URL(decoded);
      if (u.protocol === "https:" && isAllowedVideoHost(u.hostname)) {
        out.push({ url: u.toString(), quality });
      }
    } catch {}
  }
}

function walkForVideoUrls(root, out) {
  const stack = [root];
  const seenObjects = new Set();
  let visited = 0;

  while (stack.length && visited++ < 60000) {
    const item = stack.pop();
    if (!item || typeof item !== "object" || seenObjects.has(item)) continue;
    seenObjects.add(item);

    if (Array.isArray(item)) {
      for (const value of item) stack.push(value);
      continue;
    }

    for (const [key, value] of Object.entries(item)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");

      if (["playaddr", "downloadaddr", "playaddress", "downloadaddress"].includes(normalizedKey)) {
        addCandidate(out, value, key);
      } else if (normalizedKey === "bitrateinfo" && Array.isArray(value)) {
        for (const entry of value) {
          if (!entry || typeof entry !== "object") continue;
          addCandidate(
            out,
            entry.PlayAddr || entry.playAddr || entry.play_addr,
            entry.GearName || entry.gearName || "bitrate"
          );
        }
      }

      if (value && typeof value === "object") stack.push(value);
    }
  }
}

function extractScriptPayloads(html) {
  const payloads = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRe)) {
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    if (!body) continue;

    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || "";

    if (["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE", "RENDER_DATA"].includes(id)) {
      if (id === "RENDER_DATA") {
        try { payloads.push(JSON.parse(atob(body))); } catch {}
      } else {
        try { payloads.push(JSON.parse(body)); } catch {}
      }
    }

    if (body.includes('"playAddr"') || body.includes('"downloadAddr"') || body.includes('"bitrateInfo"')) {
      try { payloads.push(JSON.parse(body)); } catch {}
    }
  }

  return payloads;
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${escaped}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`, "i"),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])(?=[^>]*\\bproperty=["']${escaped}["'])[^>]*>`, "i")
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeString(m[1]);
  }

  return "";
}

function parseTikTokHtml(html) {
  const candidates = [];

  for (const payload of extractScriptPayloads(html)) {
    walkForVideoUrls(payload, candidates);
  }

  if (!candidates.length) {
    const fieldRe = /["'](?:playAddr|downloadAddr|play_addr|download_addr)["']\s*:\s*["']((?:\\.|[^"'\\]){20,})["']/gi;
    for (const m of html.matchAll(fieldRe)) {
      addCandidate(candidates, m[1], "embedded-field");
    }
  }

  const unique = [...new Map(candidates.map(c => [c.url, c])).values()];
  const title = extractMeta(html, "og:title") ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
    "TikTok video";

  const thumbnail = extractMeta(html, "og:image");

  return { candidates: unique, title, thumbnail };
}

async function resolveTikTok(input) {
  let current;

  try {
    current = new URL(input);
  } catch {
    throw new Error("Zadaj platný TikTok odkaz.");
  }

  if (current.protocol !== "https:" || !isTikTokHost(current.hostname)) {
    throw new Error("Podporované sú iba HTTPS odkazy z TikToku.");
  }

  for (let i = 0; i < 6; i++) {
    let response;

    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9,sk;q=0.8",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "upgrade-insecure-requests": "1"
        },
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      throw new Error("TikTok stránka sa nedá načítať z Cloudflare Worker. Skús to neskôr. Technická chyba: " + (e?.name || "network"));
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw new Error("TikTok vrátil presmerovanie bez cieľovej adresy.");
      }

      const next = new URL(location, current);

      if (next.protocol !== "https:" || !isTikTokHost(next.hostname)) {
        throw new Error("TikTok presmeroval odkaz mimo domény TikToku; požiadavka bola zablokovaná.");
      }

      current = next;
      continue;
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error(`TikTok odmietol požiadavku (HTTP ${response.status}). Ide pravdepodobne o ochranu proti automatickému načítaniu alebo rate limit.`);
      }

      if (response.status === 404) {
        throw new Error("TikTok video neexistuje alebo už nie je verejne dostupné (HTTP 404).");
      }

      throw new Error(`TikTok stránka vrátila HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    const html = await response.text();

    if (html.length > 10000000) {
      throw new Error("TikTok stránka je príliš veľká na spracovanie.");
    }

    if (!/html/i.test(contentType) && !html.includes("<html") && !html.includes("__UNIVERSAL_DATA")) {
      throw new Error(`TikTok nevrátil HTML stránku (Content-Type: ${contentType || "neznámy"}).`);
    }

    const data = parseTikTokHtml(html);

    if (!data.candidates.length) {
      const lower = html.toLowerCase();

      if (lower.includes("captcha") || lower.includes("verify to continue") || lower.includes("verify your identity")) {
        throw new Error("TikTok zobrazil CAPTCHA/overenie. Cloudflare Worker nemá prístup k video dátam.");
      }

      if (lower.includes("login-modal") || lower.includes("login to tiktok") || lower.includes("sign up for tiktok")) {
        throw new Error("TikTok vrátil prihlasovaciu alebo obmedzenú stránku namiesto verejných dát videa.");
      }

      throw new Error("TikTok stránka sa načítala, ale neobsahuje rozpoznateľnú adresu videa. TikTok pravdepodobne zmenil štruktúru dát alebo neposkytol video URL.");
    }

    return { ...data, videoUrl: data.candidates[0].url };
  }

  throw new Error("TikTok presmeroval odkaz príliš veľakrát.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/resolve" && request.method === "POST") {
      try {
        const body = await request.json();

        if (typeof body.url !== "string" || body.url.length > 2048) {
          return json({ error: "Neplatný odkaz." }, 400);
        }

        const result = await resolveTikTok(body.url.trim());

        return json({
          title: result.title,
          thumbnail: result.thumbnail,
          downloadUrl: "/api/download?src=" + encodeURIComponent(result.videoUrl)
        });
      } catch (error) {
        console.error("TikDrop resolve error:", error?.message || error);
        return json({ error: error?.message || "Spracovanie zlyhalo." }, 422);
      }
    }

    if (url.pathname === "/api/download" && request.method === "GET") {
      const src = url.searchParams.get("src");

      if (!src || src.length > 8192) {
        return new Response("Missing source", { status: 400 });
      }

      let video;

      try {
        video = new URL(src);
      } catch {
        return new Response("Invalid source", { status: 400 });
      }

      if (video.protocol !== "https:" || !isAllowedVideoHost(video.hostname)) {
        return new Response("Blocked source", { status: 403 });
      }

      try {
        const upstream = await fetch(video.toString(), {
          headers: {
            "user-agent": "Mozilla/5.0",
            "referer": "https://www.tiktok.com/"
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!upstream.ok || !upstream.body) {
          return new Response(`Video source unavailable (HTTP ${upstream.status})`, { status: 502 });
        }

        const headers = new Headers({
          "content-type": upstream.headers.get("content-type") || "video/mp4",
          "content-disposition": 'attachment; filename="tiktok-video.mp4"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });

        const length = upstream.headers.get("content-length");
        if (length) headers.set("content-length", length);

        return new Response(upstream.body, { status: 200, headers });
      } catch (error) {
        console.error("TikDrop download error:", error?.message || error);
        return new Response("Download failed or timed out", { status: 502 });
      }
    }

    if (env?.ASSETS) return env.ASSETS.fetch(request);

    return new Response("Not found", { status: 404 });
  }
};
