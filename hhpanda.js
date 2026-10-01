const { chromium } = require("playwright");

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function buildHHPandaUrl(episodeUrl) {
  const u = new URL(episodeUrl);
  const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const tap = parts.find((p) => /^tap-\d+\.html$/i.test(p));
  if (!tap) return null;

  const m = tap.match(/^tap-(\d+)\.html$/i);
  const episode = m && m[1];
  const showSlug = parts[parts.length - 2];
  if (!episode || !showSlug) return null;

  return "https://hhpanda.st/watch-" + showSlug + "/tap-" + episode + "-sv1.html";
}

async function getHHPandaStreams(episodeUrl) {
  const hhpandaUrl = buildHHPandaUrl(episodeUrl);
  if (!hhpandaUrl) return [];

  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "vi-VN"
    });

    const page = await context.newPage();
    const media = new Map();

    const capture = (url) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (/\.m3u8(?:\?|$)/i.test(url) || /\.mp4(?:\?|$)/i.test(url) || /\/hls\/[^/]+\.(?:ts|m4s)(?:\?|$)/i.test(url)) {
        media.set(url, true);
      }
    };

    page.on("request", (request) => capture(request.url()));
    page.on("response", (response) => capture(response.url()));

    await page.goto(hhpandaUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1500);

    const buttons = await page.locator("#halim-ajax-list-server .play-listsv[data-type]").evaluateAll((els) =>
      els.map((el) => ({
        type: el.getAttribute("data-type") || "",
        label: (el.textContent || "").replace(/\s+/g, " ").trim()
      }))
    );

    // Try server buttons in page order, stopping once a direct media URL appears.
    for (const button of buttons.slice(0, 4)) {
      try {
        const locator = page.locator('#halim-ajax-list-server .play-listsv[data-type="' + button.type.replace(/"/g, '\"') + '"]').first();
        await locator.click({ timeout: 5000 });
        await page.waitForTimeout(1800);

        const iframeSrc = await page.locator("#halim-player-wrapper iframe").getAttribute("src").catch(() => null);
        capture(iframeSrc);

        if (media.size >= 1) {
          const urls = Array.from(media.keys()).filter((x) => /\.(?:m3u8|mp4)(?:\?|$)/i.test(x));
          if (urls.length) break;
        }
      } catch {}
    }

    // One more pass catches URLs created shortly after the player is initialized.
    await page.waitForTimeout(1200);

    const urls = Array.from(media.keys()).filter((x) => /\.(?:m3u8|mp4)(?:\?|$)/i.test(x));
    const result = urls.map((url, index) => ({
      name: "HHPANDA • " + (index === 0 ? "1080P / 4K" : "Source " + (index + 1)),
      title: "HHPANDA",
      url,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Referer": hhpandaUrl,
            "Origin": "https://hhpanda.st"
          }
        }
      }
    }));

    return result;
  } catch (e) {
    console.error("[HHPANDA] resolver error", e);
    return [];
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

module.exports = { getHHPandaStreams };
