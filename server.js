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
      console.log(`Created directory: ${dir}`);
    } catch (error) {
      console.error(`Failed to create directory ${dir}: ${error.message}`);
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
  if (process.env.RENDER_INTERNAL_URL) {
    return process.env.RENDER_INTERNAL_URL;
  }
  return `http://localhost:${PORT}`;
}

// Configure Puppeteer for Render
async function launchBrowser() {
  const options = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--blink-settings=imagesEnabled=true',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
    ],
    timeout: 120000
  };

  // On Render, use the built-in Chrome
  if (process.env.RENDER) {
    options.executablePath = process.env.CHROME_PATH || '/usr/bin/chromium-browser';
  } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  if (process.env.PROXY_SERVER) {
    options.args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
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
    const maxAttempts = 2; // Reduced for Render memory limits

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model} at index ${index}...`);
        
        browser = await launchBrowser();
        const page = await browser.newPage();
        
        // Set longer timeouts for Render
        await page.setDefaultNavigationTimeout(120000);
        await page.setDefaultTimeout(60000);
        
        await page.setViewport({ width: 1280, height: 720 });
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        // Block unnecessary resources to save memory
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        
        let response;
        try {
          response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        } catch (navError) {
          console.error(`Navigation to ${searchUrl} failed: ${navError.message}`);
          throw navError;
        }

        if (response.status() === 404) {
          throw new Error(`Search page returned 404: ${searchUrl}`);
        }

        await delay(8000); // Reduced delay for Render

        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 200;
            const maxScrolls = 30; // Reduced for Render
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

        await delay(8000); // Reduced delay for Render

        // Re-enable requests for images now that we need them
        await page.setRequestInterception(false);

        galleryLinks = await page.evaluate(() => {
          const links = [];
          const selectors = [
            'a[href*="/20"]',
            '.post-title a', '.entry-title a', 'h2 a', 'h3 a', '.post a',
            '.gallery a', 'a[href*="/gallery/"]', 'a[href*="/photo/"]',
            '.thumb a', '.image-link', '.post-thumbnail a', '.wp-block-gallery a',
            'a[href*="/tags/"]',
            'a[href*="ahottie.net"]'
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

        console.log(`Found ${galleryLinks.length} links for ${model}`);

        const indexNum = parseInt(index, 10);
        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({
            error: `Invalid index ${index}. Must be between 1 and ${galleryLinks.length}.`,
            debug: {
              search_url: searchUrl,
              links_found: galleryLinks.length,
              links: galleryLinks.slice(0, 10) // Only return first 10 for brevity
            }
          });
        }

        const galleryLink = galleryLinks[indexNum - 1];
        console.log(`Navigating to: ${galleryLink}`);
        try {
          response = await page.goto(galleryLink, { waitUntil: 'domcontentloaded', timeout: 120000 });
        } catch (galleryError) {
          console.error(`Failed to navigate to ${galleryLink}: ${galleryError.message}`);
          throw galleryError;
        }

        if (response.status() === 404) {
          throw new Error(`Page returned 404: ${galleryLink}`);
        }
        
        await delay(8000);
        
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        
        await delay(6000);
        
        imageUrls = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll('img'));
          const urls = [];
          
          images.forEach(element => {
            let src = element.src || 
                     element.getAttribute('data-src') || 
                     element.getAttribute('data-lazy-src') || 
                     element.getAttribute('data-original') || 
                     (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
            
            if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
              const isRelevant = src.includes('ahottie.net') || 
                               src.includes('imgbox.com') || 
                               src.includes('wp-content');
              if (isRelevant) {
                urls.push(src);
              }
            }
          });
          
          return urls.slice(0, 30); // Reduced limit for Render
        });

        console.log(`Found ${imageUrls.length} images in ${galleryLink}`);

        // Fallback to search page if no images
        if (imageUrls.length === 0) {
          console.log(`No images in gallery, falling back to search page...`);
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
          await delay(8000);
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await delay(6000);
          
          imageUrls = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            const urls = [];
            
            images.forEach(element => {
              let src = element.src || 
                       element.getAttribute('data-src') || 
                       element.getAttribute('data-lazy-src') || 
                       element.getAttribute('data-original') || 
                       (element.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]);
              
              if (src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) {
                const isRelevant = src.includes('ahottie.net') || 
                                 src.includes('imgbox.com') || 
                                 src.includes('wp-content');
                if (isRelevant) {
                  urls.push(src);
                }
              }
            });
            
            return urls.slice(0, 30); // Reduced limit for Render
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
          links_found: galleryLinks.length
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
      downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`
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
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);
    const downloadDir = path.join(__dirname, 'downloads', model);

    await fs.mkdir(downloadDir, { recursive: true });

    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
      if (images.length === 0) {
        console.log(`Empty cache for ${model} at index ${index}`);
        return res.status(404).json({
          error: `No images found in cache for ${model} at index ${index}. Run /api/album/${model}/${index} first.`
        });
      }
    } catch (e) {
      console.log(`No cache file found for ${model} at index ${index}`);
      return res.status(404).json({
        error: `No cached images for ${model} at index ${index}. Run /api/album/${model}/${index} first.`
      });
    }

    let downloadedCount = 0;
    const failedDownloads = [];

    // Download only first 10 images on Render to avoid memory issues
    const imagesToDownload = process.env.RENDER ? images.slice(0, 10) : images;

    for (const image of imagesToDownload) {
      const filePath = path.join(downloadDir, image.name);
      try {
        await fs.access(filePath);
        console.log(`File already exists: ${image.name}`);
        downloadedCount++;
      } catch {
        try {
          const response = await fetch(image.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
            },
            timeout: 30000
          });
          
          if (response.ok) {
            const buffer = await response.buffer();
            await fs.writeFile(filePath, buffer);
            console.log(`Downloaded ${image.name} to ${filePath}`);
            downloadedCount++;
          } else {
            console.error(`Failed to download ${image.url}: HTTP ${response.status}`);
            failedDownloads.push({ name: image.name, url: image.url, status: response.status });
          }
          await delay(1000);
        } catch (downloadError) {
          console.error(`Error downloading ${image.name}: ${downloadError.message}`);
          failedDownloads.push({ name: image.name, url: image.url, error: downloadError.message });
        }
      }
    }

    res.json({
      model,
      index,
      message: `${downloadedCount}/${imagesToDownload.length} images downloaded to downloads/${model}/`,
      downloaded: downloadedCount,
      total: imagesToDownload.length,
      failed: failedDownloads.length,
      failed_list: failedDownloads,
      download_path: `/downloads/${model}/`,
      downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`,
      note: process.env.RENDER ? 'Limited to 10 images on Render free tier' : undefined
    });
  } catch (error) {
    console.error(`Bulk download error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).json({
      error: `Bulk download error: ${error.message}`,
      debug: {
        timestamp: new Date().toISOString()
      }
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
        error: `No downloads found for ${model}. Run /api/bulk-download/${model}/<index> first.`
      });
    }

    const files = await fs.readdir(downloadDir);
    const imageFiles = files
      .filter(file => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file))
      .map(file => ({
        name: file,
        url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/${encodeURIComponent(file)}`
      }));

    res.json({
      model,
      files: imageFiles,
      total: imageFiles.length,
      downloads_url: `${getBaseUrl(req)}/downloads/${encodeURIComponent(model)}/`
    });
  } catch (error) {
    console.error(`Error listing downloads for ${req.params.model}: ${error.message}`);
    res.status(500).json({
      error: `Error listing downloads: ${error.message}`
    });
  }
});

// New API endpoint: GET /api/nsfw/:model/:index
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
        console.log(`Empty cache for ${model} at index ${index}`);
        return res.status(404).send(`
          <html>
            <head><title>Error</title></head>
            <body>
              <h1>Error</h1>
              <p>No images found in cache for ${model} at index ${index}.</p>
              <p>Run <a href="/api/album/${encodeURIComponent(model)}/${index}">/api/album/${encodeURIComponent(model)}/${index}</a> first.</p>
            </body>
          </html>
        `);
      }
    } catch (e) {
      console.log(`No cache file found for ${model} at index ${index}`);
      return res.status(404).send(`
        <html>
          <head><title>Error</title></head>
          <body>
            <h1>Error</h1>
            <p>No cached images for ${model} at index ${index}.</p>
            <p>Run <a href="/api/album/${encodeURIComponent(model)}/${index}">/api/album/${encodeURIComponent(model)}/${index}</a> first.</p>
          </body>
        </html>
      `);
    }

    // Limit to 20 images for display on Render
    const displayImages = process.env.RENDER ? images.slice(0, 20) : images;

    const imageHtml = displayImages.map(img => `
      <div style="margin-bottom: 20px;">
        <h3>${img.name}</h3>
        <img src="${img.url}" alt="${img.name}" style="max-width: 100%; height: auto; max-height: 400px;">
      </div>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>Images for ${model} (Index ${index})</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            h1 { color: #333; }
            h3 { margin: 10px 0 5px; }
            img { display: block; border: 1px solid #ddd; border-radius: 4px; padding: 5px; }
            a { color: #0066cc; text-decoration: none; }
            a:hover { text-decoration: underline; }
            .note { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <h1>Images for ${model} (Index ${index})</h1>
          <p>Total images: ${images.length} ${process.env.RENDER ? '(displaying first 20)' : ''}</p>
          ${process.env.RENDER ? '<div class="note">Note: Display limited to 20 images on Render free tier</div>' : ''}
          <p><a href="/downloads/${encodeURIComponent(model)}">View downloaded files</a></p>
          <p><a href="/api/bulk-download/${encodeURIComponent(model)}/${index}">Download all images</a></p>
          ${imageHtml}
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`NSFW endpoint error for ${req.params.model} at index ${req.params.index}: ${error.message}`);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error</h1>
          <p>Server error: ${error.message}</p>
        </body>
      </html>
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
          .note { background: #e7f3ff; border-left: 4px solid #0066cc; padding: 10px 15px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <h1>Image Scraper API Ready</h1>
        <p>Using search URL: <code>https://ahottie.net/search?kw=modelname</code></p>
        
        ${process.env.RENDER ? `
        <div class="note">
          <strong>Running on Render:</strong> Some limitations apply on free tier:<br>
          - Maximum 2 scraping attempts<br>
          - Limited to 30 images per scrape<br>
          - Display limited to 20 images<br>
          - Downloads limited to 10 images
        </div>
        ` : ''}
        
        <p>Endpoints:</p>
        <ul>
          <li><code>/api/album/cosplay/5</code> - Scrape images from 5th gallery for a search term</li>
          <li><code>/api/nsfw/cosplay/5</code> - Display all images from cache/cosplay/images_5.json</li>
          <li><code>/api/bulk-download/cosplay/5</code> - Download all images from cache/cosplay/images_5.json</li>
          <li><code>/downloads/cosplay</code> - List downloaded images for cosplay</li>
        </ul>
        
        <p>Example Searches:</p>
        <ul>
          <li><a href="/api/album/cosplay/5" target="_blank">/api/album/cosplay/5</a></li>
          <li><a href="/api/nsfw/cosplay/5" target="_blank">/api/nsfw/cosplay/5</a></li>
          <li><a href="/api/bulk-download/cosplay/5" target="_blank">/api/bulk-download/cosplay/5</a></li>
          <li><a href="/downloads/cosplay" target="_blank">/downloads/cosplay</a></li>
          <li><a href="/api/album/Mia%20Nanasawa/1" target="_blank">/api/album/Mia Nanasawa/1</a></li>
        </ul>
        
        <p>Base URL: <code>${baseUrl}</code></p>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using search URL: https://ahottie.net/search?kw=modelname`);
  console.log(`Health check: ${getBaseUrl({})}`);
  if (process.env.RENDER) {
    console.log('Running on Render - applying resource limitations');
  }
});
