const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.YANHH3D_BASE_URL || "https://yanhh3d.ee").replace(/\/$/, "");
const CACHE_MS = Number(process.env.CACHE_MS || 300000);

const manifest = {
  id: "com.nouistk.yanhh3d",
  version: "1.0.0",
  name: "YanHH3D",
  description: "YanHH3D donghua catalog and streams for Stremio.",
  resources: [
    { name: "catalog", types: ["series"], idPrefixes: ["yanhh:"] },
    { name: "meta", types: ["series"], idPrefixes: ["yanhh:"] },
    { name: "stream", types: ["series"], idPrefixes: ["yanhh:"] }
  ],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "yanhh3d",
      name: "YanHH3D",
      extra: [{ name: "search", isRequired: false }]
    }
  ],
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

function idFor(slug) {
  return "yanhh:" + slug.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "").replace(/\/$/, "");
}

function slugFromId(id) {
  return String(id || "").replace(/^yanhh:/, "").replace(/\/$/, "");
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

function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    if (!href || !href.startsWith(BASE_URL)) return;

    const path = new URL(href).pathname;
    if (!path || /tập-|tap-|episode|\/page\//i.test(path)) return;

    const title = clean($(el).find("h2,h3,h4,.title,.name").first().text() || $(el).attr("title") || $(el).text());
    const img = $(el).find("img").first();
    const poster = img.attr("data-src") || img.attr("data-lazy-src") || img.attr("src");

    if (!title || title.length < 2 || title.length > 180) return;
    if (!/(tu-tien|phim|hoat-hinh|donghua|series|anime)/i.test(path)) return;

    const id = idFor(path);
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, type: "series", name: title, poster: absoluteUrl(poster) });
  });

  return items.slice(0, 100);
}

async function catalog(search) {
  let url = BASE_URL + "/";
  if (search) {
    const q = encodeURIComponent(search);
    const candidates = [
      BASE_URL + "/?s=" + q,
      BASE_URL + "/tim-kiem/?s=" + q,
      BASE_URL + "/?search=" + q
    ];
    for (const candidate of candidates) {
      try {
        const html = await getHtml(candidate);
        const results = parseCards(html);
        if (results.length) return results;
      } catch {}
    }
  }
  return parseCards(await getHtml(url));
}

async function parseSeries(url, slug) {
  const html = await getHtml(url);
  const $ = cheerio.load(html);

  const title = clean($("h1").first().text()) || clean($("title").text()).replace(/\s*[-|].*$/, "");
  const description = clean($("meta[name='description']").attr("content") || $(".description,.desc,.summary").first().text());
  const poster = absoluteUrl(
    $("meta[property='og:image']").attr("content") ||
    $(".poster img").first().attr("src") ||
    $("img").first().attr("src")
  );

  const videos = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    if (!href || !href.startsWith(BASE_URL)) return;
    const text = clean($(el).text());
    const path = new URL(href).pathname;
    const m = (text + " " + path).match(/(?:tập|tap|episode)[\s._-]*(\d+)/i);
    if (!m) return;

    const ep = Number(m[1]);
    if (!Number.isFinite(ep) || seen.has(ep)) return;
    seen.add(ep);
    videos.push({
      id: slug + ":ep-" + ep,
      title: "Tập " + ep,
      season: 1,
      episode: ep,
      released: new Date().toISOString(),
      overview: title,
      _yanhhUrl: href
    });
  });

  videos.sort((a, b) => a.episode - b.episode);
  return {
    id: idFor(slug),
    type: "series",
    name: title || slug,
    poster,
    description,
    videos: videos.map(({ _yanhhUrl, ...v }) => v),
    _episodeUrls: Object.fromEntries(videos.map(v => [v.episode, v._yanhhUrl]))
  };
}

function extractStreams(html, episodeUrl) {
  const $ = cheerio.load(html);
  const streams = [];
  const seen = new Set();

  const add = (url, name, quality) => {
    if (!url) return;
    const absolute = absoluteUrl(url);
    if (!absolute || seen.has(absolute)) return;
    if (!/^https?:\/\//i.test(absolute)) return;
    seen.add(absolute);
    streams.push({
      name: "YanHH3D" + (name ? " • " + name : "") + (quality ? " • " + quality : ""),
      title: name || "YanHH3D",
      url: absolute
    });
  };

  $("video source[src], video[src], source[src], iframe[src], iframe[data-src]").each((_, el) => {
    const url = $(el).attr("src") || $(el).attr("data-src");
    const tag = el.name.toLowerCase();
    if (tag === "iframe") {
      const u = absoluteUrl(url);
      if (u) add(u, "Player");
    } else {
      add(url, "Direct");
    }
  });

  $("a[href]").each((_, el) => {
    const text = clean($(el).text());
    const href = $(el).attr("href");
    if (/4k|1080|vietsub|thuyết minh|play|xem phim/i.test(text)) {
      add(href, text);
    }
  });

  // Some YanHH3D player pages expose URLs inside inline JavaScript.
  const scripts = $("script").map((_, el) => $(el).html() || "").get().join("\n");
  const patterns = [
    /https?:\\/\\/[^"'\\s]+\.(?:m3u8|mp4)(?:\?[^"'\\s]+)?/gi,
    /https?:\/\/[^"'\\s]+\.(?:m3u8|mp4)(?:\?[^"'\\s]+)?/gi
  ];
  for (const re of patterns) {
    for (const match of scripts.matchAll(re)) add(match[0].replace(/\\\//g, "/"), "Direct");
  }

  // If only an embedded player is exposed, return it as an external URL.
  if (!streams.length) {
    const iframe = $("iframe[src], iframe[data-src]").first();
    const u = absoluteUrl(iframe.attr("src") || iframe.attr("data-src"));
    if (u) {
      streams.push({
        name: "YanHH3D Player",
        externalUrl: u
      });
    }
  }

  return streams;
}

app.get("/manifest.json", (_, res) => res.json(manifest));

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
    const meta = await parseSeries(BASE_URL + "/" + slug.replace(/^\//, ""), slug);
    const cleanMeta = { ...meta };
    delete cleanMeta._episodeUrls;
    res.set("Cache-Control", "public, max-age=300");
    res.json({ meta: cleanMeta });
  } catch (e) {
    console.error(e);
    res.status(404).json({ meta: { id: req.params.id, type: "series", name: req.params.id } });
  }
});

app.get("/stream/series/:id.json", async (req, res) => {
  try {
    const raw = String(req.params.id);
    const parts = raw.split(":ep-");
    const slug = parts[0];
    const episode = Number(parts[1]);
    if (!slug || !Number.isFinite(episode)) return res.json({ streams: [] });

    const meta = await parseSeries(BASE_URL + "/" + slug.replace(/^\//, ""), slug);
    const episodeUrl = meta._episodeUrls?.[episode];
    if (!episodeUrl) return res.json({ streams: [] });

    const html = await getHtml(episodeUrl);
    const streams = extractStreams(html, episodeUrl);

    res.set("Cache-Control", "public, max-age=120");
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

app.listen(PORT, () => {
  console.log("YanHH3D Stremio addon listening on port " + PORT);
});
