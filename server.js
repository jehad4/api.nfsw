const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directories exist
async function ensureDirectories() {
  const dirs = [
    path.join(__dirname, 'cache'),
    path.join(__dirname, 'downloads')
  ];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (e) {
      console.error(`Failed to create ${dir}: ${e.message}`);
    }
  }
}
ensureDirectories().catch(console.error);

// API: /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    // Serve from cache if exists
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cached);
      if (images.length > 0) {
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          downloads_url: `/downloads/${encodeURIComponent(model)}/`
        });
      }
    } catch {}

    // Puppeteer scrape
    let imageUrls = [];
    let galleryLinks = [];
    const maxAttempts = 3;
    let attempts = 0;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        const browserArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process'
        ];
        if (process.env.PROXY_SERVER) browserArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);

        browser = await puppeteer.launch({
          headless: 'new',
          args: browserArgs,
          timeout: 90000,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(8000);

        // Scroll to load images
        await page.evaluate(async () => {
          await new Promise(resolve => {
            let totalHeight = 0;
            const distance = 200;
            const timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= document.body.scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 200);
          });
        });
        await delay(5000);

        // Gather gallery links
        galleryLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="ahottie.net"]').forEach(a => {
            if (!a.href.includes('/page/') && !a.href.includes('/search') && !a.href.includes('#')) links.push(a.href);
          });
          return [...new Set(links)];
        });

        const idx = parseInt(index, 10);
        if (isNaN(idx) || idx < 1 || idx > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({ error: `Invalid index ${index}.` });
        }

        // Visit gallery
        const galleryLink = galleryLinks[idx - 1];
        await page.goto(galleryLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(3000);

        // Collect image URLs
        imageUrls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
          const urls = [];
          imgs.forEach(el => {
            let src;
            if (el.tagName.toLowerCase() === 'img') {
              src = el.src || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
            } else {
              const style = el.getAttribute('style');
              const match = style?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i);
              src = match ? match[1] : null;
            }
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) urls.push(src);
          });
          return urls.slice(0, 50);
        });

        await browser.close();
        browser = null;
      } catch (e) {
        if (browser) { await browser.close(); browser = null; }
      }
    }

    if (imageUrls.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: `Try "Mia Nanasawa" or "LinXingLan".`
      });
    }

    const images = imageUrls.map((url, i) => ({
      id: i + 1,
      name: `image_${i + 1}.${url.split('.').pop().split('?')[0]}`,
      url,
      thumb: url
    }));

    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: 'ahottie.net',
      search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`,
      gallery_url: galleryLinks[parseInt(index)-1] || 'N/A',
      downloads_url: `/downloads/${encodeURIComponent(model)}/`
    });

  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// API: /api/bulk-download/:model/:index
app.get('/api/bulk-download/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', model, `images_${index}.json`);
    const downloadDir = path.join(__dirname, 'downloads', model);
    await fs.mkdir(downloadDir, { recursive: true });

    const cached = await fs.readFile(cacheFile, 'utf8');
    const images = JSON.parse(cached);

    let downloaded = 0, failed = [];

    for (const img of images) {
      const filePath = path.join(downloadDir, img.name);
      try {
        await fs.access(filePath);
        downloaded++;
      } catch {
        try {
          const response = await fetch(img.url);
          const buffer = await response.buffer();
          await fs.writeFile(filePath, buffer);
          downloaded++;
        } catch (e) {
          failed.push({ name: img.name, error: e.message });
        }
      }
    }

    res.json({ model, index, downloaded, total: images.length, failed, download_path: `/downloads/${model}/` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: /downloads/:model
app.get('/downloads/:model', async (req, res) => {
  try {
    const { model } = req.params;
    const downloadDir = path.join(__dirname, 'downloads', model);
    const files = await fs.readdir(downloadDir);
    const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f))
      .map(f => ({ name: f, url: `/downloads/${encodeURIComponent(model)}/${encodeURIComponent(f)}` }));
    res.json({ model, total: images.length, files: images });
  } catch (e) {
    res.status(404).json({ error: `No downloads for ${req.params.model}` });
  }
});

// API: /api/nsfw/:model/:index
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', model, `images_${index}.json`);
    const cached = await fs.readFile(cacheFile, 'utf8');
    const images = JSON.parse(cached);

    const html = images.map(img => `<div><h3>${img.name}</h3><img src="${img.url}" style="max-width:100%;height:auto;"></div>`).join('');

    res.send(`
      <html>
        <head><title>${model} - Index ${index}</title></head>
        <body>
          <h1>${model} - Index ${index}</h1>
          ${html}
          <p><a href="/api/bulk-download/${encodeURIComponent(model)}/${index}">Download All</a></p>
        </body>
      </html>
    `);
  } catch (e) {
    res.status(404).send('No cached images found. Run /api/album/:model/:index first.');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send(`<h1>Image Scraper API is live</h1>
    <p>Use /api/album/:model/:index to scrape</p>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
