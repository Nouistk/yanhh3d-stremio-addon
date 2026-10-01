const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.YANHH3D_BASE_URL || "https://yanhh3d.ee").replace(/\/$/, "");
const CACHE_MS = Number(process.env.CACHE_MS || 300000);

const manifest = {
  id: "com.nouistk.yanhh3d",
  version: "1.1.4",
  name: "YanHH3D",
  description: "YanHH3D donghua catalog and streams for Stremio.",
  resources: [
    { name: "catalog", types: ["series"], idPrefixes: ["yanhh:"] },
    { name: "meta", types: ["series"], idPrefixes: ["yanhh:"] },
    { name: "stream", types: ["series"], idPrefixes: ["yanhh:"] }
  ],
  types: ["series"],
  catalogs: [{
    type: "series",
    id: "yanhh3d",
    name: "YanHH3D",
    extra: [{ name: "search", isRequired: false }]
  }],
  behaviorHints: { adult: false, configurable: false }
};

const cache = new Map();

function absoluteUrl(href) {
  if (!href) return null;
  try { return new URL(href, BASE_URL).href; } catch { return null; }
}

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// Encode source paths so Stremio route parameters never contain raw slashes.
function idFor(slug) {
  const path = String(slug)
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  return "yanhh:" + Buffer.from(path, "utf8").toString("base64url");
}

function slugFromId(id) {
  const encoded = String(id || "").replace(/^yanhh:/, "");
  try { return Buffer.from(encoded, "base64url").toString("utf8"); }
  catch { return ""; }
}

async function getHtml(url) {
  const key = "html:" + url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.value;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 YanHH3D-Stremio-Addon/1.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error("YanHH3D HTTP " + response.status);

  const html = await response.text();
  cache.set(key, { time: Date.now(), value: html });
  return html;
}

async function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  const posterFrom = (img) => {
    if (!img || !img.length) return null;
    const srcset = img.attr("data-srcset") || img.attr("srcset") || "";
    const srcsetFirst = srcset.split(",")[0].trim().split(/\s+/)[0];
    const value =
      img.attr("data-src") ||
      img.attr("src") ||
      img.attr("data-original") ||
      img.attr("data-lazy-src") ||
      srcsetFirst;
    return absoluteUrl(value);
  };

  // YanHH3D uses .flw-item cards and lazy-loaded data-src posters.
  $(".flw-item").each((_, item) => {
    const el = $(item);
    const a = el.find("a[href]").first();
    const href = absoluteUrl(a.attr("href"));
    if (!href || !href.startsWith(BASE_URL)) return;

    const path = new URL(href).pathname;
    if (!path || /\/tap-|\/episode|\/page\//i.test(path)) return;

    const title = clean(
      a.attr("title") ||
      el.find("h4,h3,h2,.film-name,.name,.title").first().text() ||
      a.text()
    );
    const poster = posterFrom(el.find("img").first());

    if (!title || title.length < 2 || title.length > 180) return;
    const id = idFor(path);
    if (seen.has(id)) return;
    seen.add(id);

    items.push({
      id,
      type: "series",
      name: title,
      ...(poster ? { poster } : {})
    });
  });

  // Fallback for markup changes.
  if (!items.length) {
    $("a[href]").each((_, el) => {
      const href = absoluteUrl($(el).attr("href"));
      if (!href || !href.startsWith(BASE_URL)) return;
      const path = new URL(href).pathname;
      if (!path || /\/tap-|\/episode|\/page\//i.test(path)) return;
      if (!/(tu-tien|trung-sinh|phim|hoat-hinh|donghua|anime)/i.test(path)) return;

      const title = clean($(el).attr("title") || $(el).find("h2,h3,h4").first().text() || $(el).text());
      const img = $(el).find("img").first();
      const poster = absoluteUrl(
        img.attr("data-src") || img.attr("src") ||
        img.attr("data-original") || img.attr("data-lazy-src")
      );
      if (!title || title.length < 2 || title.length > 180) return;
      const id = idFor(path);
      if (seen.has(id)) return;
      seen.add(id);
      items.push({ id, type: "series", name: title, ...(poster ? { poster } : {}) });
    });
  }

  return items.slice(0, 100);
}

async function catalog(search) {
  if (search) {
    const q = encodeURIComponent(search);
    const candidates = [
      BASE_URL + "/search?keysearch=" + q,
      BASE_URL + "/search?keyword=" + q,
      BASE_URL + "/?s=" + q
    ];

    for (const candidate of candidates) {
      try {
        const results = await parseCards(await getHtml(candidate));
        if (results.length) return results;
      } catch {}
    }
  }

  return parseCards(await getHtml(BASE_URL + "/"));
}

async function parseSeries(url, slug) {
  const html = await getHtml(url);
  const $ = cheerio.load(html);

  const title =
    clean($('meta[property="og:title"]').attr("content")) ||
    clean($("h1").first().text()) ||
    clean($("title").text()).replace(/\s*[-|].*$/, "");

  const description = clean(
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    $(".description,.desc,.summary").first().text()
  );

  const poster = absoluteUrl(
    $('meta[property="og:image"]').attr("content") ||
    $(".anisc-poster img").first().attr("data-src") ||
    $(".anisc-poster img").first().attr("src") ||
    $(".film-poster img").first().attr("data-src") ||
    $(".film-poster img").first().attr("src")
  );

  // The detail page links to a watch page through the film buttons.
  const playButtons = $(".film-buttons a[href]");
  let watchUrl = null;
  const preferred = playButtons.filter((_, el) => /vietsub/i.test(clean($(el).text())));
  const chosen = preferred.first().attr("href") || playButtons.first().attr("href");
  if (chosen) watchUrl = absoluteUrl(chosen);

  // Some URLs are already watch/episode pages.
  const watchHtml = watchUrl ? await getHtml(watchUrl) : html;
  const $w = cheerio.load(watchHtml);
  const videos = [];
  const seen = new Set();

  let container = $w(".detail-infor-content").first();
  if (!container.length) container = $w("body");

  // Prefer the Vietsub tab, otherwise use whatever episode list is available.
  const tabs = container.find('a[href^="#"]');
  const preferredPaneIds = [];
  tabs.each((_, el) => {
    if (/vietsub/i.test(clean($(el).text()))) {
      const id = ($(el).attr("href") || "").replace(/^#/, "");
      if (id) preferredPaneIds.push(id);
    }
  });

  let linkEls = $w("a[href]").toArray();
  if (preferredPaneIds.length) {
    const collected = [];
    for (const id of preferredPaneIds) {
      collected.push(...$w("#" + id + " a[href]").toArray());
    }
    if (collected.length) linkEls = collected;
  } else if (container.length) {
    linkEls = container.find("a[href]").toArray();
  }

  linkEls.forEach((el) => {
    const href = absoluteUrl($(el).attr("href"));
    if (!href || !href.startsWith(BASE_URL)) return;
    const text = clean(
      $(el).find(".ssli-order").first().text() ||
      $(el).attr("title") ||
      $(el).text()
    );
    const m = text.match(/(?:tập|tap|episode)?\s*([0-9]+)/i) || new URL(href).pathname.match(/(?:tap-|episode[-_])([0-9]+)/i);
    if (!m) return;

    const ep = Number(m[1]);
    if (!Number.isFinite(ep) || seen.has(href)) return;
    seen.add(href);

    videos.push({
      id: idFor(new URL(href).pathname),
      title: "Tập " + ep,
      season: 1,
      episode: ep,
      overview: title
    });
  });

  videos.sort((a, b) => a.episode - b.episode);

  return {
    id: idFor(slug),
    type: "series",
    name: title || slug,
    ...(poster ? { poster } : {}),
    ...(description ? { description } : {}),
    videos
  };
}

function decodePlayerConfig(value) {
  try {
    const normalized = String(value || "").trim();
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return decoded
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\\\//g, "/");
  } catch {
    return "";
  }
}

async function resolveYanSource(sourceUrl, episodeUrl, label) {
  if (!sourceUrl) return null;

  const direct = String(sourceUrl)
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/");

  const isMedia = /\.(?:m3u8|mp4)(?:\?|$)/i.test(direct);
  if (!isMedia) return null;

  try {
    const body = await getHtmlWithReferer(direct, episodeUrl);
    const trimmed = body.replace(/^\\uFEFF/, "").trimStart();

    if (trimmed.startsWith("#EXTM3U")) {
      return { url: direct, name: label || "Direct", quality: inferQuality(label, direct) };
    }

    const $ = cheerio.load(body);
    const obf = $("#player[data-obf]").attr("data-obf") || $("[data-obf]").first().attr("data-obf");

    if (obf) {
      const candidates = [decodePlayerConfig(obf)];
      try { candidates.push(Buffer.from(obf, "base64url").toString("utf8")); } catch {}

      for (const config of candidates) {
        const match = String(config || "").match(/"pU"\s*:\s*"([^"]+)"/i);
        if (match && match[1]) {
          const playlist = String(match[1]).replace(/\\\//g, "/").replace(/&amp;/g, "&");
          if (/^https?:\/\//i.test(playlist)) {
            return { url: playlist, name: label || "Direct", quality: inferQuality(label, playlist) };
          }
        }
      }
    }

    const mp4 = body.match(/https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/i);
    if (mp4) {
      return { url: mp4[0], name: label || "Direct", quality: inferQuality(label, mp4[0]) };
    }
  } catch (e) {
    console.error("resolveYanSource", e);
  }

  return {
    url: direct,
    name: (label || "Direct") + " • Direct",
    quality: inferQuality(label, direct)
  };
}

function inferQuality(label, url) {
  const text = String(label || "") + " " + String(url || "");
  if (/4k|2160/i.test(text)) return 2160;
  if (/1080/i.test(text)) return 1080;
  if (/720/i.test(text)) return 720;
  if (/480/i.test(text)) return 480;
  return 0;
}

async function getHtmlWithReferer(url, referer) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error("YanHH3D source HTTP " + response.status);
  return response.text();
}

async function extractStreams(html, episodeUrl) {
  const $ = cheerio.load(html);
  const sources = [];
  const seen = new Set();

  $("div[class*=list-severs] a[data-src]").each((_, el) => {
    const label = clean($(el).text()) || "1080";
    const raw = $(el).attr("data-src");
    if (!raw) return;
    const url = absoluteUrl(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, label });
  });

  const rawRe = /data-src\s*=\s*["'](https?:\/\/[^"'<> ]+\.(?:m3u8|mp4)(?:\?[^"'<> ]*)?)["']/gi;
  for (const match of html.matchAll(rawRe)) {
    const url = absoluteUrl(match[1].replace(/&amp;/g, "&"));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, label: /4k|2160/i.test(match[1]) ? "4K" : "1080" });
  }

  // Fallbacks when YanHH3D changes the player wrapper.
  if (!sources.length) {
    $("[data-src]").each((_, el) => {
      const raw = $(el).attr("data-src");
      if (!raw || !/\.m3u8(?:\?|$)|\.mp4(?:\?|$)/i.test(raw)) return;
      const url = absoluteUrl(raw);
      if (!url || seen.has(url)) return;
      seen.add(url);
      sources.push({ url, label: clean($(el).text()) || "Direct" });
    });
  }

  const resolved = [];
  for (const source of sources) {
    const playback = await resolveYanSource(source.url, episodeUrl, source.label);
    if (!playback) continue;

    resolved.push({
      name: "YanHH3D • " + source.label + (playback.quality ? " • " + playback.quality + "p" : ""),
      title: source.label,
      url: playback.url,
      behaviorHints: {
        proxyHeaders: {
          request: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Referer": episodeUrl,
            "Origin": BASE_URL
          }
        }
      }
    });
  }

  return resolved.sort((a, b) => {
    const qa = inferQuality(a.title, a.url);
    const qb = inferQuality(b.title, b.url);
    return qb - qa;
  });
}

app.get("/manifest.json", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.type("application/json").send(JSON.stringify(manifest));
});

app.get("/catalog/series/yanhh3d.json", async (req, res) => {
  try {
    const metas = await catalog(req.query.search);
    res.set("Cache-Control", "public, max-age=300");
    res.json({ metas });
  } catch (e) {
    console.error(e);
    res.status(502).json({ metas: [] });
  }
});

app.get("/meta/series/:id.json", async (req, res) => {
  try {
    const slug = slugFromId(req.params.id);
    if (!slug) return res.status(400).json({ meta: null });

    const meta = await parseSeries(BASE_URL + "/" + slug, slug);
    res.set("Cache-Control", "public, max-age=120");
    res.json({ meta });
  } catch (e) {
    console.error(e);
    res.status(404).json({ meta: null });
  }
});

app.get("/stream/series/:id.json", async (req, res) => {
  try {
    const slug = slugFromId(req.params.id);
    if (!slug) return res.json({ streams: [] });

    const episodeUrl = absoluteUrl(slug);
    if (!episodeUrl) return res.json({ streams: [] });

    console.log("[STREAM] request id=" + req.params.id);
    console.log("[STREAM] episodeUrl=" + episodeUrl);

    const html = await getHtmlWithReferer(episodeUrl, BASE_URL);
    console.log("[STREAM] episode html length=" + html.length);
    console.log("[STREAM] has list-severs=" + /list-severs/i.test(html));
    console.log("[STREAM] data-src count=" + (html.match(/data-src\\s*=/gi) || []).length);
    const classMatches = [...html.matchAll(/class=["'][^"']*list-severs[^"']*["']/gi)];
    const signalPatterns = [
      /sv_LINK\\d+/gi,
      /data-obf/gi,
      /\\.m3u8/gi,
      /fbcdn/gi,
      /player/gi,
      /data-src/gi
    ];
    console.log("[STREAM] real list-severs class count=" + classMatches.length);
    console.log("[STREAM] signal counts=" + signalPatterns.map(re => (html.match(re) || []).length).join(","));
    if (classMatches.length) {
      const marker = classMatches[0].index;
      console.log("[STREAM] REAL SERVER SNIPPET=" + html.slice(Math.max(0, marker - 500), marker + 12000));
    }

    const streams = await extractStreams(html, episodeUrl);
    console.log("[STREAM] resolved streams=" + streams.length);
    if (streams.length) console.log("[STREAM] first=" + streams[0].url);

    // Never return externalUrl: every returned source must be an actual media URL
    // that Stremio can play in its own player.
    res.set("Cache-Control", "public, max-age=60");
    res.json({ streams });
  } catch (e) {
    console.error(e);
    res.status(502).json({ streams: [] });
  }
});

app.get("/", (_, res) => {
  res.type("html").send(
    "<h1>YanHH3D Stremio Add-on</h1><p><a href='/manifest.json'>Install manifest</a></p>"
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("YanHH3D Stremio addon listening on port " + PORT);
});
