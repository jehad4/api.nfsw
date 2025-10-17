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

// Polyfill for waitForTimeout
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directories exist
async function ensureDirectories() {
  const directories = [
    path.join(__dirname, 'cache'),
    path.join(__dirname, 'downloads')
  ];
  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Directory ready: ${dir}`);
    } catch (error) {
      console.error(`Directory error ${dir}: ${error.message}`);
    }
  }
}

// Run on startup
ensureDirectories().catch(error => console.error(`Directory setup failed: ${error.message}`));

// Get base URL for Render environment
function getBaseUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  return `http://localhost:${PORT}`;
}

// Configure Puppeteer for Render
async function launchBrowser() {
  const options = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
    ],
    timeout: 60000
  };

  // On Render, use the built-in Chrome
  if (process.env.RENDER) {
    options.executablePath = '/usr/bin/chromium-browser';
  }

  return await puppeteer.launch(options);
}

// API endpoint: GET /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

    // Check cache first
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        console.log(`Serving ${images.length} cached images for ${model} at index ${index}`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`
        });
      }
    } catch (e) {
      console.log(`No cache for ${model} at index ${index}, scraping...`);
    }

    let imageUrls = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        
        browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(30000);
        await page.setViewport({ width: 1280, height: 720 });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        
        await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 60000 });
        await delay(5000);

        // Scroll to load content
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let scrollCount = 0;
            const timer = setInterval(() => {
              window.scrollBy(0, 200);
              scrollCount++;
              if (scrollCount >= 20) {
                clearInterval(timer);
                resolve();
              }
            }, 200);
          });
        });

        await delay(5000);

        // Get gallery links
        galleryLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="ahottie.net"]').forEach(a => {
            if (a.href && 
                !a.href.includes('/page/') && 
                !a.href.includes('/search') &&
                !a.href.includes('/?s=')) {
              links.push(a.href);
            }
          });
          return [...new Set(links)].filter(link => link.includes('/20') || link.includes('/gallery/'));
        });

        console.log(`Found ${galleryLinks.length} gallery links`);

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          return res.status(400).json({
            error: `Invalid index ${index}. Must be between 1 and ${galleryLinks.length}.`,
            links_found: galleryLinks.length
          });
        }

        const galleryLink = galleryLinks[indexNum - 1];
        console.log(`Navigating to gallery: ${galleryLink}`);
        
        await page.goto(galleryLink, { waitUntil: 'networkidle0', timeout: 60000 });
        await delay(5000);

        // Scroll gallery
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(3000);

        // Extract images
        imageUrls = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll('img'));
          const urls = [];
          
          images.forEach(img => {
            let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
              if (src.includes('ahottie.net') || src.includes('imgbox.com') || src.includes('wp-content')) {
                urls.push(src);
              }
            }
          });
          
          return urls.slice(0, 20);
        });

        console.log(`Found ${imageUrls.length} images`);
        await browser.close();
        browser = null;

      } catch (error) {
        console.error(`Attempt ${attempts} failed: ${error.message}`);
        if (browser) {
          await browser.close();
          browser = null;
        }
      }
    }

    if (imageUrls.length === 0) {
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No images found for "${model}" at index ${index}.`,
        suggestion: 'Try different model names like "Mia Nanasawa" or "LinXingLan"'
      });
    }

    const images = imageUrls.map((url, idx) => {
      const fileExt = url.split('.').pop().split('?')[0] || 'jpg';
      return {
        id: idx + 1,
        name: `image_${idx + 1}.${fileExt}`,
        url,
        thumb: url
      };
    });

    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: 'ahottie.net',
      downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error(`Error: ${error.message}`);
    res.status(500).json({
      error: `Server error: ${error.message}`
    });
  }
});

// API endpoint: GET /api/bulk-download/:model/:index
app.get('/api/bulk-download/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);
    const downloadDir = path.join(__dirname, 'downloads', model);

    await fs.mkdir(downloadDir, { recursive: true });

    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
      if (images.length === 0) {
        return res.status(404).json({
          error: `No cached images for ${model} at index ${index}. Run /api/album/${model}/${index} first.`
        });
      }
    } catch (e) {
      return res.status(404).json({
        error: `No cache found for ${model} at index ${index}. Run /api/album/${model}/${index} first.`
      });
    }

    let downloadedCount = 0;
    const failedDownloads = [];

    // Limit downloads on Render
    const imagesToDownload = process.env.RENDER ? images.slice(0, 10) : images;

    for (const image of imagesToDownload) {
      const filePath = path.join(downloadDir, image.name);
      try {
        // Skip if already exists
        await fs.access(filePath);
        downloadedCount++;
      } catch {
        try {
          const response = await fetch(image.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
          });
          
          if (response.ok) {
            const buffer = await response.buffer();
            await fs.writeFile(filePath, buffer);
            downloadedCount++;
          } else {
            failedDownloads.push({ name: image.name, url: image.url, status: response.status });
          }
          await delay(500);
        } catch (error) {
          failedDownloads.push({ name: image.name, url: image.url, error: error.message });
        }
      }
    }

    res.json({
      model,
      index,
      message: `${downloadedCount}/${imagesToDownload.length} images downloaded`,
      downloaded: downloadedCount,
      total: imagesToDownload.length,
      failed: failedDownloads.length,
      downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`,
      note: process.env.RENDER ? 'Limited to 10 images on Render' : undefined
    });

  } catch (error) {
    console.error(`Download error: ${error.message}`);
    res.status(500).json({
      error: `Download error: ${error.message}`
    });
  }
});

// API endpoint: GET /downloads/:model
app.get('/downloads/:model', async (req, res) => {
  try {
    const { model } = req.params;
    const downloadDir = path.join(__dirname, 'downloads', model);
    
    try {
      await fs.access(downloadDir);
    } catch {
      return res.status(404).json({
        error: `No downloads for ${model}. Run bulk-download first.`
      });
    }

    const files = await fs.readdir(downloadDir);
    const imageFiles = files
      .filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file))
      .map(file => ({
        name: file,
        url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/${encodeURIComponent(file)}`
      }));

    res.json({
      model,
      files: imageFiles,
      total: imageFiles.length
    });
  } catch (error) {
    res.status(500).json({
      error: `Error: ${error.message}`
    });
  }
});

// API endpoint: GET /api/nsfw/:model/:index
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
      if (images.length === 0) {
        return res.status(404).send(`
          <html><body>
            <h1>Error</h1>
            <p>No cached images for ${model} at index ${index}.</p>
            <p><a href="/api/album/${model}/${index}">Scrape images first</a></p>
          </body></html>
        `);
      }
    } catch (e) {
      return res.status(404).send(`
        <html><body>
          <h1>Error</h1>
          <p>No cache found for ${model} at index ${index}.</p>
          <p><a href="/api/album/${model}/${index}">Scrape images first</a></p>
        </body></html>
      `);
    }

    const displayImages = process.env.RENDER ? images.slice(0, 15) : images;
    
    const imageHtml = displayImages.map(img => `
      <div style="margin: 20px 0; padding: 10px; border: 1px solid #ddd;">
        <h4>${img.name}</h4>
        <img src="${img.url}" style="max-width: 100%; height: auto; max-height: 500px;" 
             onerror="this.style.display='none'" />
      </div>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>${model} - Images</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            img { border-radius: 5px; }
            .info { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>Images for ${model} (Index ${index})</h1>
          <div class="info">
            <p>Total: ${images.length} images ${process.env.RENDER ? '(showing 15)' : ''}</p>
            <p><a href="/api/bulk-download/${model}/${index}">Download Images</a> | 
               <a href="/downloads/${model}">View Downloads</a> | 
               <a href="/">Home</a></p>
          </div>
          ${imageHtml}
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <html><body>
        <h1>Error</h1>
        <p>${error.message}</p>
      </body></html>
    `);
  }
});

// Health check
app.get('/', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.send(`
    <html>
      <head>
        <title>Image Scraper API</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
          li { margin: 10px 0; }
          .note { background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <h1>🚀 Image Scraper API</h1>
        <p><strong>Search Source:</strong> <code>https://ahottie.net/search?kw=modelname</code></p>
        
        ${process.env.RENDER ? `
        <div class="note">
          <strong>Render Free Tier Notes:</strong>
          <ul>
            <li>Limited to 20 images per scrape</li>
            <li>Limited to 10 image downloads</li>
            <li>Display shows 15 images max</li>
            <li>512MB RAM limit</li>
          </ul>
        </div>
        ` : ''}
        
        <h2>API Endpoints:</h2>
        <ul>
          <li><code><a href="/api/album/cosplay/1">/api/album/:model/:index</a></code> - Scrape images</li>
          <li><code><a href="/api/nsfw/cosplay/1">/api/nsfw/:model/:index</a></code> - View cached images</li>
          <li><code><a href="/api/bulk-download/cosplay/1">/api/bulk-download/:model/:index</a></code> - Download images</li>
          <li><code><a href="/downloads/cosplay">/downloads/:model</a></code> - List downloads</li>
        </ul>

        <h2>Examples:</h2>
        <ul>
          <li><a href="/api/album/Mia%20Nanasawa/1">Mia Nanasawa Gallery 1</a></li>
          <li><a href="/api/album/LinXingLan/1">Lin XingLan Gallery 1</a></li>
          <li><a href="/api/album/cosplay/1">Cosplay Gallery 1</a></li>
        </ul>

        <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
        <p><em>First scrape may take 20-30 seconds as browser loads</em></p>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔍 Using source: https://ahottie.net/search?kw=modelname`);
  console.log(`🏠 Health check: ${getBaseUrl({})}`);
  if (process.env.RENDER) {
    console.log('🚀 Running on Render - optimized for free tier');
  }
});
