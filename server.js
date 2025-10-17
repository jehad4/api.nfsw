const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
const CACHE_DIR = path.join(__dirname, 'storage', 'cache');

// Ensure cache directory exists
(async () => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log('Created directory:', CACHE_DIR);
  } catch (err) {
    console.error('Failed to create cache directory:', err);
  }
})();

// Helper: sanitize filenames
const sanitize = (str) => str.replace(/[<>:"/\\|?*]+/g, '_');

// Helper: sleep
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scrape images from ahottie.net
async function scrapeImages(query, index = 1) {
  const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(query)}`;
  console.log(`Scraping: ${searchUrl}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const page = await browser.newPage();
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });

    const links = await page.$$eval('.thumb a', (as) =>
      as.map((a) => a.href).filter((x) => x.includes('/gallery/'))
    );

    if (!links.length) throw new Error('No gallery links found');

    const target = links[index - 1] || links[0];
    console.log(`Navigating to gallery: ${target}`);

    await page.goto(target, { waitUntil: 'networkidle2', timeout: 90000 });

    const imageLinks = await page.$$eval('.gallery-item img', (imgs) =>
      imgs.map((img) => img.getAttribute('src') || img.getAttribute('data-src'))
    );

    return imageLinks.filter(Boolean);
  } catch (err) {
    console.error('Puppeteer error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Download image to cache
async function downloadImage(url, folder, filename) {
  const filePath = path.join(folder, filename);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.buffer();
    await fs.writeFile(filePath, buffer);
    console.log(`Downloaded ${filename}`);
    return filePath;
  } catch (err) {
    console.error(`Failed to download ${url}:`, err.message);
    return null;
  }
}

// Route: health check
app.get('/', (req, res) => {
  res.send('✅ NSFW Image API is running on Render');
});

// Route: fetch and cache images
app.get('/api/nsfw/:model/:index?', async (req, res) => {
  const { model } = req.params;
  const index = parseInt(req.params.index) || 1;
  const modelFolder = path.join(CACHE_DIR, sanitize(model));
  await fs.mkdir(modelFolder, { recursive: true });

  const cachedFiles = await fs.readdir(modelFolder);
  if (cachedFiles.length > 0) {
    const random = cachedFiles[Math.floor(Math.random() * cachedFiles.length)];
    return res.sendFile(path.join(modelFolder, random));
  }

  console.log(`No cache for ${model}, scraping...`);
  const images = await scrapeImages(model, index);

  if (!images.length) {
    return res.status(404).json({
      error: `No images found for "${model}"`,
      suggestion: `Try "Mia Nanasawa" or "LinXingLan"`,
      debug: { search_url: `https://ahottie.net/search?kw=${model}`, links: images }
    });
  }

  const firstImage = images[0];
  const fileName = `nsfw_${sanitize(model)}_${index}.jpg`;
  const filePath = await downloadImage(firstImage, modelFolder, fileName);

  if (!filePath) {
    return res.status(500).json({ error: 'Failed to download image' });
  }

  res.sendFile(filePath);
});

// Route: get JSON of image URLs
app.get('/api/album/:model/:index?', async (req, res) => {
  const { model } = req.params;
  const index = parseInt(req.params.index) || 1;
  const images = await scrapeImages(model, index);

  if (!images.length) {
    return res.status(404).json({
      error: `No images found for "${model}"`,
      suggestion: `Try "Mia Nanasawa" or "LinXingLan"`,
      debug: { search_url: `https://ahottie.net/search?kw=${model}`, links: images }
    });
  }

  res.json({ model, index, count: images.length, images });
});

// Static downloads folder
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: https://api-nfsw.onrender.com`);
});
