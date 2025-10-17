const express = require('express');
const puppeteer = require('puppeteer');
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

// Browser setup for Render - FIXED VERSION
async function createBrowser() {
  console.log('Launching browser...');
  
  const options = {
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
      '--memory-pressure-off'
    ],
    timeout: 30000
  };

  // On Render, let Puppeteer use its own Chrome binary
  // Remove the executablePath entirely and let Puppeteer handle it
  if (process.env.RENDER) {
    console.log('Running on Render - using Puppeteer built-in Chrome');
    // Let Puppeteer use its own bundled Chrome
  }

  try {
    const browser = await puppeteer.launch(options);
    console.log('Browser launched successfully');
    return browser;
  } catch (error) {
    console.error('Browser launch failed:', error.message);
    throw error;
  }
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
    
    let imageUrls = [];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      console.log(`Attempt ${attempts}/${maxAttempts}`);
      
      try {
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
          waitUntil: 'networkidle0', 
          timeout: 30000 
        });
        await delay(4000);

        // Get gallery links
        const galleryLinks = await page.evaluate(() => {
          const links = [];
          // Multiple selector strategies
          const selectors = [
            'a[href*="/20"]',
            '.post-title a',
            '.entry-title a', 
            'h2 a',
            'h3 a',
            '.gallery a',
            'a[href*="/gallery/"]'
          ];
          
          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(a => {
              if (a.href && a.href.includes('ahottie.net')) {
                links.push(a.href);
              }
            });
          });
          
          return [...new Set(links)].slice(0, 15);
        });

        console.log(`Found ${galleryLinks.length} gallery links`);

        if (galleryLinks.length === 0) {
          throw new Error('No galleries found on search page');
        }

        const galleryIndex = Math.max(0, Math.min(galleryLinks.length - 1, parseInt(index) - 1));
        const galleryUrl = galleryLinks[galleryIndex];
        console.log(`Selected gallery: ${galleryUrl}`);

        // Navigate to gallery
        await page.goto(galleryUrl, { 
          waitUntil: 'networkidle0', 
          timeout: 30000 
        });
        await delay(4000);

        // Scroll to load lazy images
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 100);
          });
        });

        await delay(3000);

        // Extract images with multiple strategies
        imageUrls = await page.evaluate(() => {
          const urls = new Set();
          
          // Strategy 1: Regular img tags
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
            if (src && /\.(jpg|jpeg|png|webp|gif)/i.test(src)) {
              urls.add(src);
            }
          });
          
          // Strategy 2: Background images
          document.querySelectorAll('[style*="background-image"]').forEach(el => {
            const style = el.getAttribute('style');
            const match = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
            if (match && /\.(jpg|jpeg|png|webp|gif)/i.test(match[1])) {
              urls.add(match[1]);
            }
          });
          
          return Array.from(urls).slice(0, 20);
        });

        console.log(`Found ${imageUrls.length} images`);
        await browser.close();
        browser = null;

      } catch (error) {
        console.error(`Attempt ${attempts} failed:`, error.message);
        if (browser) {
          await browser.close();
          browser = null;
        }
        await delay(2000); // Wait before retry
      }
    }

    if (imageUrls.length === 0) {
      return res.status(404).json({ 
        error: 'No images found after multiple attempts',
        suggestion: 'Try a different model name or index'
      });
    }

    // Format response
    const images = imageUrls.map((url, i) => {
      const ext = url.split('.').pop().split('?')[0] || 'jpg';
      return {
        id: i + 1,
        name: `image_${i + 1}.${ext}`,
        url: url,
        thumb: url
      };
    });

    // Cache results
    await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));
    console.log(`Cached ${images.length} images`);

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: 'ahottie.net',
      note: 'Images scraped successfully'
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('Scraping error:', error.message);
    res.status(500).json({ 
      error: `Scraping failed: ${error.message}`,
      debug: {
        model: req.params.model,
        index: req.params.index,
        timestamp: new Date().toISOString()
      }
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
              a:hover { text-decoration: underline; }
              .btn { display: inline-block; background: #0066cc; color: white; padding: 10px 20px; border-radius: 5px; margin: 10px 5px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>📸 No Cached Images Found</h1>
              <p>No images found for <strong>${model}</strong> at index <strong>${index}</strong>.</p>
              <p>You need to scrape the images first:</p>
              <a class="btn" href="/api/album/${model}/${index}">Scrape Images Now</a>
              <a class="btn" href="/" style="background: #666;">Back to Home</a>
            </div>
          </body>
        </html>
      `);
    }

    const imageHtml = images.map(img => `
      <div style="margin: 25px 0; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
        <h4 style="margin: 0 0 10px 0; color: #333;">${img.name}</h4>
        <img src="${img.url}" 
             style="max-width: 100%; height: auto; border-radius: 5px; border: 1px solid #ddd;"
             onerror="this.style.display='none'; console.log('Failed to load: ${img.name}')"
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
            .nav { margin: 15px 0; }
            .btn { display: inline-block; background: #0066cc; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; margin: 5px; }
            .btn:hover { background: #0055aa; }
            .btn.secondary { background: #666; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${model} - Gallery ${index}</h1>
            <p>Total: ${images.length} images</p>
            <div class="nav">
              <a class="btn" href="/api/album/${model}/${index}">🔄 Rescrape</a>
              <a class="btn" href="/api/bulk-download/${model}/${index}">📥 Download Info</a>
              <a class="btn secondary" href="/">🏠 Home</a>
            </div>
          </div>
          ${imageHtml}
          <div style="text-align: center; margin: 30px 0; color: #666;">
            <p>End of gallery • <a href="#" onclick="window.scrollTo(0,0)">Back to top</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; margin: 40px;">
          <h1>Error</h1>
          <p>${error.message}</p>
          <a href="/">Go Home</a>
        </body>
      </html>
    `);
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
        error: 'No cached images found. Please scrape images first.',
        solution: `Run /api/album/${model}/${index} to scrape images`
      });
    }

    res.json({
      model,
      index,
      total_images: images.length,
      images: images.map(img => ({
        name: img.name,
        url: img.url,
        direct_link: img.url
      })),
      note: 'On Render free tier, direct download functionality is limited. Use the image URLs above.',
      view_gallery: `${getBaseUrl()}/api/nsfw/${model}/${index}`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available cached models
app.get('/api/cache', async (req, res) => {
  try {
    const cacheDir = path.join(__dirname, 'cache');
    const files = await fs.readdir(cacheDir);
    
    const cacheInfo = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const [model, index] = file.replace('.json', '').split('_');
        return {
          model,
          index,
          view_url: `${getBaseUrl()}/api/nsfw/${model}/${index}`,
          api_url: `${getBaseUrl()}/api/album/${model}/${index}`
        };
      });

    res.json({
      total_cached: cacheInfo.length,
      cached_items: cacheInfo
    });
  } catch (error) {
    res.json({ total_cached: 0, cached_items: [] });
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
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container { 
            max-width: 1200px; 
            margin: 0 auto; 
          }
          .header { 
            text-align: center; 
            margin-bottom: 40px; 
          }
          .card { 
            background: rgba(255,255,255,0.1); 
            padding: 25px; 
            margin: 20px 0; 
            border-radius: 15px; 
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
          }
          code { 
            background: rgba(0,0,0,0.3); 
            padding: 3px 8px; 
            border-radius: 4px; 
            font-family: 'Courier New', monospace;
          }
          .btn { 
            display: inline-block; 
            background: rgba(255,255,255,0.2); 
            color: white; 
            padding: 12px 24px; 
            border-radius: 8px; 
            text-decoration: none; 
            margin: 8px; 
            border: 1px solid rgba(255,255,255,0.3);
            transition: all 0.3s ease;
          }
          .btn:hover { 
            background: rgba(255,255,255,0.3); 
            transform: translateY(-2px);
          }
          .example-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 15px; 
            margin: 20px 0;
          }
          .endpoint { 
            background: rgba(255,255,255,0.05); 
            padding: 15px; 
            border-radius: 8px; 
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="font-size: 3em; margin-bottom: 10px;">🖼️</h1>
            <h1>Image Scraper API</h1>
            <p style="opacity: 0.9;">Scrape and view images from ahottie.net</p>
          </div>

          <div class="card">
            <h2>🚀 Quick Start</h2>
            <p>Try these working examples:</p>
            <div style="text-align: center;">
              <a class="btn" href="/api/album/cosplay/1">Scrape Cosplay Gallery 1</a>
              <a class="btn" href="/api/album/Mia%20Nanasawa/1">Scrape Mia Nanasawa</a>
              <a class="btn" href="/api/cache">View Cached Items</a>
            </div>
          </div>

          <div class="card">
            <h2>📚 API Endpoints</h2>
            <div class="example-grid">
              <div class="endpoint">
                <h3>Scrape Images</h3>
                <code>GET /api/album/:model/:index</code>
                <p>Scrapes images for a model at specified gallery index</p>
              </div>
              <div class="endpoint">
                <h3>View Images</h3>
                <code>GET /api/nsfw/:model/:index</code>
                <p>Displays cached images in a gallery view</p>
              </div>
              <div class="endpoint">
                <h3>Download Info</h3>
                <code>GET /api/bulk-download/:model/:index</code>
                <p>Get download information for cached images</p>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>🔧 Technical Info</h2>
            <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
            <p><strong>Search Source:</strong> <code>https://ahottie.net/search?kw=modelname</code></p>
            <p><em>⚠️ First scrape may take 15-30 seconds as browser initializes</em></p>
            ${process.env.RENDER ? '<p>✅ Optimized for Render free tier deployment</p>' : ''}
          </div>
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
    environment: process.env.RENDER ? 'Render' : 'Local'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: ${getBaseUrl()}/health`);
  console.log(`🏠 Main page: ${getBaseUrl()}`);
  if (process.env.RENDER) {
    console.log('✅ Running on Render - using Puppeteer built-in Chrome');
  }
});
