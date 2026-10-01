const cheerio = require("cheerio");

async function getPlayerFrames(episodeUrl, baseUrl) {
  const page = await fetch(episodeUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": baseUrl,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!page.ok) throw new Error("YanHH3D HTTP " + page.status);
  const html = await page.text();
  const $ = cheerio.load(html);

  const active = $(".ssl-item.ep-item.active").first();
  const postId = active.attr("data-post-id") || $(".ssl-item.ep-item[data-post-id]").first().attr("data-post-id");
  const chapter = active.attr("data-ep") || $(".ssl-item.ep-item[data-ep]").first().attr("data-ep");
  const sv = active.attr("data-sv") || "1";

  if (!postId || !chapter) return [];

  const buttons = $("#list_sv .btn3dsv").toArray();
  const results = [];

  for (const button of buttons) {
    const type = $(button).attr("data-type");
    const label = ($(button).text() || "").replace(/\s+/g, " ").trim() || type || "Server";
    if (!type) continue;

    const u = new URL(baseUrl + "/player/player.php");
    u.searchParams.set("action", "dox_ajax_player");
    u.searchParams.set("post_id", postId);
    u.searchParams.set("chapter_st", chapter);
    u.searchParams.set("type", type);
    u.searchParams.set("sv", sv);

    const response = await fetch(u.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Referer": episodeUrl,
        "Accept": "*/*"
      },
      redirect: "follow"
    });

    if (!response.ok) continue;
    const body = await response.text();
    const $p = cheerio.load(body);
    const frame = $p("iframe").first().attr("src");
    if (!frame) continue;

    const frameUrl = new URL(frame, u.href).href;
    if (!/^https:\/\/streamfree\.vip\/embed\//i.test(frameUrl)) continue;

    const widgetId = Buffer.from(frameUrl, "utf8").toString("base64url");
    results.push({
      name: "YanHH3D • " + label,
      title: label,
      externalUrl: frameUrl,
      widgetPlayer: baseUrl + "/widget/" + widgetId + ".html",
      widgetPlayerStates: ["replaceplayer"]
    });
  }

  return results;
}

module.exports = { getPlayerFrames };
