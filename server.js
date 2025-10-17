const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || "jehad4";

app.use(express.json());
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

async function scrapeImages(keyword) {
  const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(keyword)}`;
  console.log(`Scraping: ${searchUrl}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ],
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "/usr/bin/google-chrome-stable"
  });

  const page = await browser.newPage();

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for thumbnails
    await page.waitForSelector("img", { timeout: 15000 });

    const imageUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      return imgs
        .map((img) => img.src)
        .filter((src) => src && src.startsWith("http"));
    });

    await browser.close();

    const uniqueUrls = [...new Set(imageUrls)];
    console.log(`Found ${uniqueUrls.length} images for ${keyword}`);
    return uniqueUrls.slice(0, 10); // Limit results
  } catch (err) {
    console.error("Puppeteer scraping error:", err);
    await browser.close();
    throw err;
  }
}

app.get("/", (req, res) => {
  res.send(`
    <h2>🔥 NSFW Image Scraper API</h2>
    <p>Usage: <code>/api/pies?name=japan&apikey=jehad4</code></p>
  `);
});

app.get("/api/pies", async (req, res) => {
  const name = req.query.name;
  const apikey = req.query.apikey;

  if (!name) return res.status(400).json({ error: "Missing 'name' parameter." });
  if (apikey !== API_KEY) return res.status(403).json({ error: "Invalid API key." });

  const cacheDir = path.join(__dirname, "downloads", name);
  await fs.mkdir(cacheDir, { recursive: true });

  const cacheFiles = await fs.readdir(cacheDir);
  if (cacheFiles.length > 0) {
    console.log(`Serving cached images for ${name}`);
    return res.json({
      source: "cache",
      count: cacheFiles.length,
      images: cacheFiles.map((f) => `/downloads/${name}/${f}`)
    });
  }

  try {
    const urls = await scrapeImages(name);

    if (urls.length === 0) {
      return res.json({
        error: `No NSFW images found for "${name}".`,
        suggestion: `Try another keyword on https://ahottie.net/?s=${encodeURIComponent(name)}`
      });
    }

    let count = 0;
    for (const url of urls) {
      try {
        const response = await fetch(url);
        const buffer = await response.buffer();
        const fileName = `nsfw_${name}_${++count}.jpg`;
        await fs.writeFile(path.join(cacheDir, fileName), buffer);
        console.log(`Saved: ${fileName}`);
      } catch (err) {
        console.error(`Failed to save ${url}:`, err.message);
      }
    }

    res.json({
      source: "scraped",
      count,
      images: (await fs.readdir(cacheDir)).map((f) => `/downloads/${name}/${f}`)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to scrape images" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌍 Open: http://localhost:${PORT}`);
});
