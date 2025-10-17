const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 10000;

// Storage paths
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const CACHE_DIR = path.join(STORAGE_PATH, 'cache');

// Middleware
app.use(express.json());

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure cache directory exists
async function ensureDirectories() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log(`Created directory: ${CACHE_DIR}`);
  } catch (error) {
    console.error(`Failed to create directory ${CACHE_DIR}: ${error.message}`);
  }
}
ensureDirectories().catch(error => console.error(`Directory setup failed: ${error.message}`));

// ==================== ALBUM SCRAPER ====================
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    // Serve cache if exists
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        return res.json({ model, index, album: images, total: images.length, source: 'cache', cache_file: cacheFile });
      }
    } catch {}

    let imageUrls = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        const browserArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
          '--disable-features=IsolateOrigins,site-per-process',
          '--blink-settings=imagesEnabled=true'
        ];
        if (process.env.PROXY_SERVER) browserArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);

        browser = await puppeteer.launch({ headless: 'new', args: browserArgs, timeout: 90000 });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        const response = await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        if (response.status() === 404) throw new Error(`Search page 404: ${searchUrl}`);
        await delay(12000);

        await page.evaluate(async () => {
          await new Promise(resolve => {
            let totalHeight = 0, distance = 200, scrollCount = 0, maxScrolls = 60;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              scrollCount++;
              if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) { clearInterval(timer); resolve(); }
            }, 200);
          });
        });
        await delay(12000);

        galleryLinks = await page.evaluate(() => {
          const links = [];
          const selectors = ['a[href*="/20"]', '.post-title a', '.entry-title a', 'h2 a', 'h3 a', '.post a', '.gallery a', 'a[href*="/gallery/"]', 'a[href*="/photo/"]', '.thumb a', '.image-link', '.post-thumbnail a', '.wp-block-gallery a', 'a[href*="/tags/"]', 'a[href*="ahottie.net"]'];
          selectors.forEach(s => document.querySelectorAll(s).forEach(a => {
            if (a.href && a.href.includes('ahottie.net') && !a.href.includes('/page/') && !a.href.includes('/search') && !a.href.includes('/?s=') && !a.href.includes('#')) links.push(a.href);
          }));
          return [...new Set(links)];
        });

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({ error: `Invalid index ${index}`, debug: { search_url: searchUrl, links_found: galleryLinks.length, links: galleryLinks } });
        }

        const galleryLink = galleryLinks[indexNum - 1];
        const galleryResponse = await page.goto(galleryLink, { waitUntil: 'networkidle2', timeout: 60000 });
        if (galleryResponse.status() === 404) throw new Error(`Gallery 404: ${galleryLink}`);
        await delay(12000);

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(10000);

        imageUrls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
          const urls = [];
          imgs.forEach(el => {
            let src;
            if (el.tagName.toLowerCase() === 'img') src = el.src || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || (el.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
            else { const match = el.getAttribute('style')?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i); src = match ? match[1] : null; }
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src) && (src.includes('ahottie.net') || src.includes('imgbox.com') || src.includes('wp-content'))) urls.push(src);
          });
          return urls.slice(0, 50);
        });

        await browser.close();
        browser = null;

      } catch (err) {
        if (browser) { await browser.close(); browser = null; }
      }
    }

    if (imageUrls.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({ error: `No images found for "${model}" at index ${index}` });
    }

    const images = imageUrls.map((url, idx) => ({ id: idx+1, name: `image_${idx+1}.${url.split('.').pop().split('?')[0]}`, url, thumb: url }));
    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));
    res.json({ model, index, album: images, total: images.length, source: 'ahottie.net', search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`, gallery_url: galleryLinks[parseInt(index)-1] || 'N/A', cache_file: cacheFile });

  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message, debug: { timestamp: new Date().toISOString() } });
  }
});

// ==================== NSFW DISPLAY ====================
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(CACHE_DIR, model, `images_${index}.json`);
    const cachedData = await fs.readFile(cacheFile, 'utf8');
    const images = JSON.parse(cachedData);
    if (!images.length) throw new Error('No images in cache.');

    const html = images.map(img => `<div style="margin-bottom:20px;"><h3>${img.name}</h3><img src="${img.url}" alt="${img.name}" style="max-width:100%; max-height:600px;"></div>`).join('');
    res.send(`<html><head><title>${model} Images</title></head><body><h1>${model} (Index ${index})</h1>${html}</body></html>`);
  } catch (err) {
    res.status(404).send(`<html><body><h1>Error</h1><p>${err.message}</p></body></html>`);
  }
});

// ==================== HEALTH CHECK / ROOT ====================
app.get('/', (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.send(`<html><head><title>Image Scraper API</title></head><body>
  <h1>Image Scraper API Ready</h1>
  <p>Endpoints:</p>
  <ul>
    <li><a href="${baseUrl}/api/album/cosplay/5">${baseUrl}/api/album/cosplay/5</a></li>
    <li><a href="${baseUrl}/api/nsfw/cosplay/5">${baseUrl}/api/nsfw/cosplay/5</a></li>
  </ul>
  </body></html>`);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
