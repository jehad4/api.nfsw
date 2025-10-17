const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const puppeteerBrowsers = require('@puppeteer/browsers');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 10000;

// Define storage paths for Render's persistent disk
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, 'storage');
const CACHE_DIR = path.join(STORAGE_PATH, 'cache');
const DOWNLOADS_DIR = path.join(STORAGE_PATH, 'downloads');

// Middleware
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Polyfill for waitForTimeout
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directories exist
async function ensureDirectories() {
  const directories = [CACHE_DIR, DOWNLOADS_DIR];
  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (error) {
      console.error(`Failed to create directory ${dir}: ${error.message}`);
    }
  }
}

// Install Chromium if needed (runs once on startup)
async function installChromiumIfNeeded() {
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
    const exists = await fs.access(executablePath).then(() => true).catch(() => false);
    if (!exists) {
      console.log('Chromium not found. Installing via @puppeteer/browsers...');
      await puppeteerBrowsers.install('chrome', { cacheDir: '/tmp/puppeteer' });
      console.log('Chromium installed successfully.');
    } else {
      console.log(`Using existing Chromium at: ${executablePath}`);
    }
  } catch (error) {
    console.error(`Failed to install Chromium: ${error.message}`);
    console.log('Falling back to default Puppeteer behavior.');
  }
}

// Run on startup
async function startup() {
  await ensureDirectories();
  await installChromiumIfNeeded();
}
startup().catch(error => console.error(`Startup failed: ${error.message}`));

// API endpoint: GET /api/album/:model/:index
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);

    await fs.mkdir(cacheDir, { recursive: true });

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
          downloads_url: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/downloads/${encodeURIComponent(model)}/`
        });
      } else {
        console.log(`Empty cache for ${model} at index ${index}, forcing scrape...`);
        await fs.unlink(cacheFile).catch(() => {});
      }
    } catch (e) {
      console.log(`No valid cache for ${model} at index ${index}, scraping...`);
    }

    let imageUrls = [];
    let galleryLinks = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        const browserArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
          '--disable-features=IsolateOrigins,site-per-process',
          '--blink-settings=imagesEnabled=true'
        ];
        if (process.env.PROXY_SERVER) {
          browserArgs.push(`--proxy-server=${process.env.PROXY_SERVER}`);
        }
        browser = await puppeteer.launch({
          headless: 'new',
          args: browserArgs,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
          timeout: 90000
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        
        let response;
        try {
          response = await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        } catch (navError) {
          console.error(`Navigation to ${searchUrl} failed: ${navError.message}`);
          throw navError;
        }

        if (response.status() === 404) {
          throw new Error(`Search page returned 404: ${searchUrl}`);
        }

        await delay(12000);

        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 200;
            const maxScrolls = 60;
            let scrollCount = 0;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              scrollCount++;
              if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) {
                clearInterval(timer);
                resolve();
              }
            }, 200);
          });
        });

        await delay(12000);

        galleryLinks = await page.evaluate(() => {
          const links = [];
          const selectors = [
            'a[href*="/20"]',              // Date-based galleries
            '.post-title a', '.entry-title a', 'h2 a', 'h3 a', '.post a',
            '.gallery a', 'a[href*="/gallery/"]', 'a[href*="/photo/"]',
            '.thumb a', '.image-link', '.post-thumbnail a', '.wp-block-gallery a',
            'a[href*="/tags/"]',           // Tag links (key for cosplay)
            'a[href*="ahottie.net"]'       // Broad catch-all
          ];
          
          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(a => {
              if (a.href && a.href.includes('ahottie.net') && 
                  !a.href.includes('/page/') && 
                  !a.href.includes('/search') &&
                  !a.href.includes('/?s=') && 
                  !a.href.includes('#')) {
                links.push(a.href);
              }
            });
          });
          
          return [...new Set(links)];
        });

        console.log(`Found ${galleryLinks.length} links for ${model}: ${galleryLinks.join(', ')}`);

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({
            error: `Invalid index ${index}. Must be between 1 and ${galleryLinks.length}.`,
            debug: {
              search_url: searchUrl,
              links_found: galleryLinks.length,
              links: galleryLinks
            }
          });
        }

        const galleryLink = galleryLinks[indexNum - 1];
        console.log(`Navigating to: ${galleryLink}`);
        try {
          response = await page.goto(galleryLink, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch (galleryError) {
          console.error(`Failed to navigate to ${galleryLink}: ${galleryError.message}`);
          throw galleryError;
        }

        if (response.status() === 404) {
          throw new Error(`Page returned 404: ${galleryLink}`);
        }
        
        await delay(12000);
        
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        
        await delay(10000);
        
        imageUrls = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
          const urls = [];
          
          images.forEach(element => {
            let src;
            if (element.tagName.toLowerCase() === 'img') {
              src = element.src || 
                    element.getAttribute('data-src') || 
                    element.getAttribute('data-lazy-src') || 
                    element.getAttribute('data-original') || 
                    (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
            } else {
              const style = element.getAttribute('style');
              const match = style?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i);
              src = match ? match[1] : null;
            }
            
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
              const isRelevant = src.includes('ahottie.net') || 
                               src.includes('imgbox.com') || 
                               src.includes('wp-content');
              if (isRelevant) {
                urls.push(src);
              }
            }
          });
          
          return urls.slice(0, 50);
        });

        console.log(`Found ${imageUrls.length} images in ${galleryLink}`);

        // Fallback to search page if no images
        if (imageUrls.length === 0) {
          console.log(`No images in gallery, falling back to search page...`);
          await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
          await delay(12000);
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await delay(10000);
          
          imageUrls = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
            const urls = [];
            
            images.forEach(element => {
              let src;
              if (element.tagName.toLowerCase() === 'img') {
                src = element.src || 
                      element.getAttribute('data-src') || 
                      element.getAttribute('data-lazy-src') || 
                      element.getAttribute('data-original') || 
                      (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
              } else {
                const style = element.getAttribute('style');
                const match = style?.match(/background-image:\s?url\(['"]?(.+?)['"]?\)/i);
                src = match ? match[1] : null;
              }
              
              if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
                const isRelevant = src.includes('ahottie.net') || 
                                 src.includes('imgbox.com') || 
                                 src.includes('wp-content');
                if (isRelevant) {
                  urls.push(src);
                }
              }
            });
            
            return urls.slice(0, 50);
          });
          
          console.log(`Found ${imageUrls.length} images from fallback search page`);
        }
        
        await browser.close();
        browser = null;

      } catch (puppeteerError) {
        console.error(`Puppeteer attempt ${attempts} failed for ${model} at index ${index}: ${puppeteerError.message}`);
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
        suggestion: `Try "Mia Nanasawa" or "LinXingLan". Visit https://ahottie.net/search?kw=${encodeURIComponent(model)} to confirm.`,
        debug: {
          search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`,
          gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
          attempts_made: attempts,
          links_found: galleryLinks.length,
          links: galleryLinks
        }
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
      search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`,
      gallery_url: galleryLinks[parseInt(index) - 1] || 'N/A',
      downloads_url: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/downloads/${encodeURIComponent(model)}/`
    });
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    console.error(`Error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).json({
      error: `Server error: ${error.message}`,
      debug: {
        search_url: `https://ahottie.net/search?kw=${encodeURIComponent(req.params.model)}`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// API endpoint: GET /api/bulk-download/:model/:index
app.get('/api/bulk-download/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(CACHE_DIR, model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);
    const downloadDir = path.join(DOWNLOADS_DIR, model);

    await fs.mkdir(downloadDir, { recursive: true });

    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
      if (images.length === 0) {
        console.log(`Empty cache for ${model}
