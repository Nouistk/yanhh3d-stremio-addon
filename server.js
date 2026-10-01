const express = require("express");
const cheerio = require("cheerio");
const { getPlayerFrames } = require("./player");
const { getHHPandaStreams } = require("./hhpanda");

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
  version: "1.6.0",
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

  let links = $w("a[href]");
  if (preferredPaneIds.length) {
    const collected = [];
    for (const id of preferredPaneIds) {
      $w("#" + id + " a[href]").each((_, el) => collected.push(el));
    }
    if (collected.length) links = cheerio.load("<div></div>")([]); // replaced below
    if (collected.length) {
      const seenEls = new Set();
      links = { each: (fn) => collected.forEach((el, i) => {
        const key = el;
        if (!seenEls.has(key)) { seenEls.add(key); fn(i, el); }
      }) };
    }
  } else if (container.length) {
    links = container.find("a[href]");
  }

  links.each((_, el) => {
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

  const direct = String(sourceUrl).trim().replace(/&amp;/g, "&").replace(/\\\//g, "/");
  if (/\.(?:m3u8|mp4)(?:\?|$)/i.test(direct) === false) return null;

  try {
    // YanHH3D's data-src often ends in .m3u8 but returns an HTML player page.
    const body = await getHtmlWithReferer(direct, episodeUrl);
    if (body.trimStart().startsWith("#EXTM3U")) {
      return {
        url: direct,
        name: label || "Direct",
        quality: inferQuality(label, direct)
      };
    }

    const $ = cheerio.load(body);
    const obf = $("#player[data-obf]").attr("data-obf") || $("[data-obf]").first().attr("data-obf");
    if (obf) {
      const config = decodePlayerConfig(obf);
      const match = config.match(/"pU"\s*:\s*"([^"]+)"/i);
      if (match && match[1]) {
        const playlist = absoluteUrl(match[1].replace(/\\\//g, "/"));
        if (playlist) {
          return {
            url: playlist,
            name: label || "Direct",
            quality: inferQuality(label, playlist)
          };
        }
      }
    }

    const mp4 = body.match(/https?:\/\/[^"'\\s<>]+\.mp4(?:\?[^"'\\s<>]*)?/i);
    if (mp4) {
      return {
        url: mp4[0],
        name: label || "Direct",
        quality: inferQuality(label, mp4[0])
      };
    }
  } catch (e) {
    console.error("resolveYanSource", e);
  }

  return null;
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
        notWebReady: true,
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

function decodeWidgetUrl(encoded) {
  try {
    return Buffer.from(String(encoded || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function isAllowedWidgetUrl(value) {
  try {
    const u = new URL(value);
    const base = new URL(BASE_URL);
    if (u.protocol !== "https:") return false;

    // Primary: embed the original YanHH3D episode page so its own
    // JavaScript loads StreamFree with the correct YanHH3D referrer.
    if (u.hostname === base.hostname) return true;

    // Legacy fallback for previously-issued StreamFree widget URLs.
    return u.hostname === "streamfree.vip" && u.pathname.startsWith("/embed/");
  } catch {
    return false;
  }
}

app.get("/manifest.json", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.type("application/json").send(JSON.stringify(manifest));
});

app.get("/widget/:encoded.html", (req, res) => {
  const frameUrl = decodeWidgetUrl(req.params.encoded);
  if (!isAllowedWidgetUrl(frameUrl)) {
    return res.status(400).type("text/plain").send("Invalid widget URL");
  }

  const src = JSON.stringify(frameUrl).replace(/</g, "\\u003c");
  res.set("Cache-Control", "public, max-age=60");
  res.type("html").send(
    "<!doctype html>" +
    "<html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
    "<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style>" +
    "</head><body>" +
    "<iframe src=" + src +
    " allow='autoplay; fullscreen; picture-in-picture; encrypted-media' allowfullscreen " +
    "referrerpolicy='strict-origin-when-cross-origin'></iframe>" +
    "</body></html>"
  );
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

    // Prefer direct media discovered from HHPanda itself.
    const hhpandaStreams = await getHHPandaStreams(episodeUrl);
    if (hhpandaStreams.length) {
      console.log("[STREAM] HHPanda direct sources:", hhpandaStreams.length);
      res.set("Cache-Control", "public, max-age=30");
      return res.json({ streams: hhpandaStreams });
    }

    // Keep YanHH3D resolver as fallback for source discovery.
    const streams = await getPlayerFrames(episodeUrl, BASE_URL);
    console.log("[STREAM] PlayerFrame fallback sources:", streams.length);

    res.set("Cache-Control", "public, max-age=30");
    res.json({ streams });
  } catch (e) {
    console.error("stream error", e);
    res.status(502).json({ streams: [] });
  }
});

app.get("/", (_, res) => {
  res.type("html").send(
    "<h1>YanHH3D Stremio Add-on</h1><p><a href='/manifest.json'>Install manifest</a></p>"
  );
});



async function runHHPandaSelfTest() {
  if (process.env.HHPANDA_SELF_TEST !== "1") return;
  try {
    const streams = await getHHPandaStreams("https://yanhh3d.ee/tu-tien/muc-than-ky/tap-1.html");
    console.log("[HHP-SELFTEST] count=" + streams.length);
    console.log("[HHP-SELFTEST] streams=" + JSON.stringify(streams));
  } catch (e) {
    console.error("[HHP-SELFTEST] error", e);
  }
}
runHHPandaSelfTest();

app.listen(PORT, "0.0.0.0", () => {
  console.log("YanHH3D Stremio addon listening on port " + PORT);
});
