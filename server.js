const express = require('express');
const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const path = require('path');
const app = express();

const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Utility functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directories exist
async function ensureDirectories() {
  const dirs = ['cache', 'downloads'];
  for (const dir of dirs) {
    try {
      await fs.mkdir(path.join(__dirname, dir), { recursive: true });
      console.log(`✓ Directory ready: ${dir}`);
    } catch (error) {
      console.log(`✓ Directory exists: ${dir}`);
    }
  }
}

// Initialize directories
ensureDirectories();

// Get base URL
function getBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
}

// Find Chrome executable on Render
function findChromePath() {
  const possiblePaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    process.env.CHROME_PATH
  ].filter(Boolean);

  for (const chromePath of possiblePaths) {
    if (fs.access(chromePath).then(() => true).catch(() => false)) {
      return chromePath;
    }
  }
  
  // Fallback to common Render paths
  return '/usr/bin/chromium-browser';
}

// Browser setup for Render - FIXED VERSION
async function createBrowser() {
  console.log('Launching browser...');
  
  let executablePath;
  
  if (process.env.RENDER) {
    // On Render, use system Chromium
    executablePath = '/usr/bin/chromium-browser';
    console.log('Using system Chromium on Render');
  } else {
    // Local development - use puppeteer's Chrome
    const chrome = require('puppeteer');
    const browserFetcher = chrome.createBrowserFetcher();
    const revisions = await browserFetcher.localRevisions();
    if (revisions.length > 0) {
      const info = await browserFetcher.revisionInfo(revisions[0]);
      executablePath = info.executablePath;
    }
  }

  if (!executablePath) {
    throw new Error('Could not find Chrome executable');
  }

  console.log(`Chrome path: ${executablePath}`);

  const options = {
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--memory-pressure-off',
      '--max-old-space-size=2048'
    ],
    timeout: 30000
  };

  try {
    const browser = await puppeteer.launch(options);
    console.log('Browser launched successfully');
    return browser;
  } catch (error) {
    console.error('Browser launch failed:', error.message);
    
    // Fallback: Try without executable path
    console.log('Trying fallback browser launch...');
    const fallbackOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    };
    
    return await puppeteer.launch(fallbackOptions);
  }
}

// Simple scraping function without browser for testing
async function simpleScrape(model, index) {
  console.log(`Using simple scrape for ${model} at index ${index}`);
  
  // Return mock data for testing
  const mockImages = [
    {
      id: 1,
      name: "sample_1.jpg",
      url: "https://picsum.photos/800/600?random=1",
      thumb: "https://picsum.photos/400/300?random=1"
    },
    {
      id: 2,
      name: "sample_2.jpg", 
      url: "https://picsum.photos/800/600?random=2",
      thumb: "https://picsum.photos/400/300?random=2"
    },
    {
      id: 3,
      name: "sample_3.jpg",
      url: "https://picsum.photos/800/600?random=3",
      thumb: "https://picsum.photos/400/300?random=3"
    }
  ];
  
  return mockImages;
}

// Main scraping endpoint
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', `${model}_${index}.json`);

    // Check cache first
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cached);
      if (images.length > 0) {
        console.log(`Serving ${images.length} cached images for ${model}`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache'
        });
      }
    } catch (e) {
      console.log(`No cache found for ${model} at index ${index}`);
    }

    console.log(`Scraping ${model} at index ${index}...`);
    
    let images = [];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && images.length === 0) {
      attempts++;
      console.log(`Attempt ${attempts}/${maxAttempts}`);
      
      try {
        // Try with browser first
        browser = await createBrowser();
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        await page.setDefaultNavigationTimeout(30000);
        await page.setDefaultTimeout(15000);

        // Search page
        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        
        await page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        await delay(3000);

        // Get gallery links
        const galleryLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll('a[href*="/20"]').forEach(a => {
            if (a.href && a.href.includes('ahottie.net')) {
              links.push(a.href);
            }
          });
          return links.slice(0, 10);
        });

        console.log(`Found ${galleryLinks.length} gallery links`);

        if (galleryLinks.length === 0) {
          throw new Error('No galleries found');
        }

        const galleryIndex = Math.max(0, Math.min(galleryLinks.length - 1, parseInt(index) - 1));
        const galleryUrl = galleryLinks[galleryIndex];

        // Navigate to gallery
        await page.goto(galleryUrl, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        await delay(3000);

        // Extract images
        const imageUrls = await page.evaluate(() => {
          const urls = [];
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || img.dataset.src;
            if (src && /\.(jpg|jpeg|png|webp)/i.test(src)) {
              urls.push(src);
            }
          });
          return urls.slice(0, 10);
        });

        console.log(`Found ${imageUrls.length} images`);
        
        // Format images
        images = imageUrls.map((url, i) => {
          const ext = url.split('.').pop().split('?')[0] || 'jpg';
          return {
            id: i + 1,
            name: `image_${i + 1}.${ext}`,
            url: url,
            thumb: url
          };
        });

        await browser.close();
        browser = null;

      } catch (error) {
        console.error(`Browser attempt ${attempts} failed:`, error.message);
        if (browser) {
          await browser.close();
          browser = null;
        }
        
        // If browser fails, use simple scrape
        if (attempts === maxAttempts) {
          console.log('Falling back to simple scrape');
          images = await simpleScrape(model, index);
        }
        
        await delay(2000);
      }
    }

    if (images.length === 0) {
      return res.status(404).json({ 
        error: 'No images found',
        note: 'Browser automation failed. Service is running but scraping is limited.'
      });
    }

    // Cache results
    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));
    console.log(`Cached ${images.length} images`);

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: images[0].url.includes('picsum.photos') ? 'demo' : 'ahottie.net',
      note: images[0].url.includes('picsum.photos') ? 'Using demo images (browser failed)' : 'Images scraped successfully'
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('Scraping error:', error.message);
    
    // Final fallback - return demo images
    const demoImages = await simpleScrape(req.params.model, req.params.index);
    
    res.json({
      model: req.params.model,
      index: req.params.index,
      album: demoImages,
      total: demoImages.length,
      source: 'demo',
      note: 'Browser automation failed. Showing demo images.',
      error: error.message
    });
  }
});

// View images endpoint
app.get('/api/nsfw/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', `${model}_${index}.json`);

    let images = [];
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cached);
    } catch (e) {
      return res.send(`
        <html>
          <head>
            <title>No Cached Images</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
              .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              a { color: #0066cc; text-decoration: none; }
              .btn { display: inline-block; background: #0066cc; color: white; padding: 10px 20px; border-radius: 5px; margin: 10px 5px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>📸 No Cached Images</h1>
              <p>No images found for <strong>${model}</strong> at index <strong>${index}</strong>.</p>
              <a class="btn" href="/api/album/${model}/${index}">Scrape Images</a>
              <a class="btn" href="/" style="background: #666;">Home</a>
            </div>
          </body>
        </html>
      `);
    }

    const imageHtml = images.map(img => `
      <div style="margin: 20px 0; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
        <h4 style="margin: 0 0 10px 0;">${img.name}</h4>
        <img src="${img.url}" 
             style="max-width: 100%; height: auto; border-radius: 5px; border: 1px solid #ddd;"
             onerror="this.style.display='none'"
             loading="lazy">
      </div>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>${model} - Gallery ${index}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
            .header { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .btn { display: inline-block; background: #0066cc; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; margin: 5px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${model} - Gallery ${index}</h1>
            <p>Total: ${images.length} images</p>
            <div>
              <a class="btn" href="/api/album/${model}/${index}">Rescrape</a>
              <a class="btn" href="/api/bulk-download/${model}/${index}">Download Info</a>
              <a class="btn" href="/" style="background: #666;">Home</a>
            </div>
          </div>
          ${imageHtml}
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Download endpoint
app.get('/api/bulk-download/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', `${model}_${index}.json`);

    let images = [];
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cached);
    } catch (e) {
      return res.status(404).json({ 
        error: 'No cached images found',
        solution: `Run /api/album/${model}/${index} first`
      });
    }

    res.json({
      model,
      index,
      total_images: images.length,
      images: images.map(img => ({
        name: img.name,
        url: img.url
      })),
      note: 'Use the image URLs above to download images'
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Home page
app.get('/', (req, res) => {
  const baseUrl = getBaseUrl();
  res.send(`
    <html>
      <head>
        <title>🖼️ Image Scraper API</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            margin: 40px; 
            background: #f5f5f5;
          }
          .container { 
            max-width: 800px; 
            margin: 0 auto; 
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          code { 
            background: #f0f0f0; 
            padding: 2px 6px; 
            border-radius: 4px; 
          }
          .btn { 
            display: inline-block; 
            background: #0066cc; 
            color: white; 
            padding: 10px 20px; 
            border-radius: 5px; 
            text-decoration: none; 
            margin: 10px 5px; 
          }
          .note {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🖼️ Image Scraper API</h1>
          
          <div class="note">
            <strong>Status:</strong> Service is running! 
            ${process.env.RENDER ? 'Using puppeteer-core with system Chromium on Render.' : 'Running locally.'}
          </div>
          
          <h2>Quick Start</h2>
          <p>Try these examples:</p>
          <a class="btn" href="/api/album/cosplay/1">Scrape Cosplay</a>
          <a class="btn" href="/api/album/Mia%20Nanasawa/1">Scrape Mia Nanasawa</a>
          
          <h2>API Endpoints</h2>
          <ul>
            <li><code>GET /api/album/:model/:index</code> - Scrape images</li>
            <li><code>GET /api/nsfw/:model/:index</code> - View cached images</li>
            <li><code>GET /api/bulk-download/:model/:index</code> - Download info</li>
          </ul>
          
          <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
          <p><em>First request may take a few seconds to initialize</em></p>
        </div>
      </body>
    </html>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Image Scraper API',
    timestamp: new Date().toISOString(),
    environment: process.env.RENDER ? 'Render' : 'Local',
    chrome: 'Using puppeteer-core with system Chromium'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: ${getBaseUrl()}/health`);
  console.log(`🏠 Main page: ${getBaseUrl()}`);
  if (process.env.RENDER) {
    console.log('✅ Running on Render with puppeteer-core');
  }
});
