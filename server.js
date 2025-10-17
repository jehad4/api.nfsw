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

ensureDirectories();

// Get base URL
function getBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
}

// Browser setup for Render - SIMPLIFIED AND WORKING
async function createBrowser() {
  console.log('🔧 Launching browser for Render...');
  
  const options = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    timeout: 30000
  };

  console.log('Using executable path:', options.executablePath);
  
  try {
    const browser = await puppeteer.launch(options);
    console.log('✅ Browser launched successfully');
    return browser;
  } catch (error) {
    console.error('❌ Browser launch failed:', error.message);
    
    // Try alternative approach
    console.log('🔄 Trying alternative browser configuration...');
    const fallbackOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: '/usr/bin/chromium-browser'
    };
    
    return await puppeteer.launch(fallbackOptions);
  }
}

// Working scraper function
async function scrapeImages(model, index) {
  let browser;
  try {
    console.log(`🎯 Starting scrape for ${model} at index ${index}`);
    
    browser = await createBrowser();
    const page = await browser.newPage();
    
    // Configure page
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });
    await page.setDefaultNavigationTimeout(45000);
    await page.setDefaultTimeout(30000);

    // Step 1: Go to search page
    const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
    console.log(`🔍 Navigating to search: ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: 'networkidle2',
      timeout: 45000 
    });
    
    console.log('✅ Search page loaded');
    await delay(4000);

    // Step 2: Find gallery links
    const galleryLinks = await page.evaluate(() => {
      const links = [];
      // Multiple strategies to find gallery links
      const anchors = document.querySelectorAll('a[href*="/20"], a[href*="/gallery/"], .post-title a, .entry-title a, h2 a, h3 a');
      
      anchors.forEach(a => {
        if (a.href && 
            a.href.includes('ahottie.net') && 
            !a.href.includes('/page/') && 
            !a.href.includes('/search') &&
            !a.href.includes('/?s=')) {
          links.push(a.href);
        }
      });
      
      return [...new Set(links)].slice(0, 20);
    });

    console.log(`📚 Found ${galleryLinks.length} gallery links`);

    if (galleryLinks.length === 0) {
      throw new Error('No gallery links found on search page');
    }

    const galleryIndex = Math.max(0, Math.min(galleryLinks.length - 1, parseInt(index) - 1));
    const galleryUrl = galleryLinks[galleryIndex];
    console.log(`🎨 Selected gallery: ${galleryUrl}`);

    // Step 3: Navigate to gallery
    console.log(`🖼️ Navigating to gallery...`);
    await page.goto(galleryUrl, { 
      waitUntil: 'networkidle2',
      timeout: 45000 
    });
    
    console.log('✅ Gallery page loaded');
    await delay(4000);

    // Step 4: Scroll to load all images
    console.log('📜 Scrolling to load images...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 200;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });

    await delay(3000);

    // Step 5: Extract image URLs
    console.log('🔍 Extracting image URLs...');
    const imageUrls = await page.evaluate(() => {
      const urls = new Set();
      
      // Strategy 1: Regular img tags
      document.querySelectorAll('img').forEach(img => {
        const sources = [
          img.src,
          img.getAttribute('data-src'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-original'),
          img.getAttribute('srcset')?.split(',')[0]?.split(' ')[0]
        ];
        
        for (const src of sources) {
          if (src && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(src)) {
            if (src.includes('ahottie.net') || src.includes('imgbox.com') || src.includes('wp-content')) {
              urls.add(src);
            }
          }
        }
      });
      
      // Strategy 2: Background images
      document.querySelectorAll('[style*="background-image"]').forEach(el => {
        const style = el.getAttribute('style');
        const match = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
        if (match && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(match[1])) {
          urls.add(match[1]);
        }
      });
      
      return Array.from(urls).slice(0, 30);
    });

    console.log(`✅ Found ${imageUrls.length} images`);
    
    await browser.close();
    
    // Format the results
    const images = imageUrls.map((url, i) => {
      const urlObj = new URL(url);
      const ext = urlObj.pathname.split('.').pop() || 'jpg';
      return {
        id: i + 1,
        name: `image_${i + 1}.${ext}`,
        url: url,
        thumb: url
      };
    });

    return images;

  } catch (error) {
    if (browser) await browser.close();
    console.error('❌ Scraping failed:', error.message);
    throw error;
  }
}

// Main scraping endpoint
app.get('/api/album/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', `${model}_${index}.json`);

    // Check cache first
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cached);
      if (images.length > 0) {
        console.log(`📦 Serving ${images.length} cached images`);
        return res.json({
          model,
          index,
          album: images,
          total: images.length,
          source: 'cache',
          cached: true
        });
      }
    } catch (e) {
      console.log(`🆕 No cache found, scraping fresh...`);
    }

    console.log(`🚀 Starting fresh scrape for ${model}...`);
    
    let images = [];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && images.length === 0) {
      attempts++;
      console.log(`🔄 Attempt ${attempts}/${maxAttempts}`);
      
      try {
        images = await scrapeImages(model, index);
        console.log(`✅ Scraping successful: ${images.length} images`);
      } catch (error) {
        console.error(`❌ Attempt ${attempts} failed:`, error.message);
        
        if (attempts === maxAttempts) {
          // Final fallback - demo images
          console.log('🔄 Using fallback demo images');
          images = [
            {
              id: 1,
              name: "demo_1.jpg",
              url: "https://picsum.photos/800/600?random=1",
              thumb: "https://picsum.photos/400/300?random=1"
            },
            {
              id: 2,
              name: "demo_2.jpg",
              url: "https://picsum.photos/800/600?random=2", 
              thumb: "https://picsum.photos/400/300?random=2"
            },
            {
              id: 3,
              name: "demo_3.jpg",
              url: "https://picsum.photos/800/600?random=3",
              thumb: "https://picsum.photos/400/300?random=3"
            }
          ];
        }
        
        await delay(3000);
      }
    }

    // Cache the results
    if (images.length > 0) {
      await fs.writeFile(cacheFile, JSON.stringify(images, null, 2));
      console.log(`💾 Cached ${images.length} images`);
    }

    res.json({
      model,
      index,
      album: images,
      total: images.length,
      source: images[0].url.includes('picsum.photos') ? 'demo_fallback' : 'ahottie.net',
      attempts: attempts,
      status: images[0].url.includes('picsum.photos') ? 'fallback_used' : 'success'
    });

  } catch (error) {
    console.error('💥 Final error:', error.message);
    res.status(500).json({ 
      error: `Scraping failed: ${error.message}`,
      fallback: 'Service is running but browser automation failed',
      try_again: 'The service will retry on next request'
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
          <head><title>No Cached Images</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f0f2f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            .btn { display: inline-block; background: #0066cc; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 10px; }
            .btn:hover { background: #0055aa; }
          </style>
          </head>
          <body>
            <div class="container">
              <h1>📭 No Cached Images</h1>
              <p>No images found for <strong>${model}</strong> at index <strong>${index}</strong>.</p>
              <a class="btn" href="/api/album/${model}/${index}">Scrape Images Now</a>
              <a class="btn" href="/" style="background: #666;">Back to Home</a>
            </div>
          </body>
        </html>
      `);
    }

    const imageHtml = images.map(img => `
      <div style="margin: 25px 0; padding: 20px; background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        <h4 style="margin: 0 0 15px 0; color: #333;">${img.name}</h4>
        <img src="${img.url}" 
             style="max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e0e0e0;"
             onerror="this.style.display='none'; console.log('Failed to load image')"
             loading="lazy">
      </div>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>${model} - Gallery ${index}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f0f2f5; }
            .header { background: white; padding: 25px; border-radius: 10px; margin-bottom: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .btn { display: inline-block; background: #0066cc; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 8px; }
            .btn:hover { background: #0055aa; }
            .info { background: #e7f3ff; padding: 15px; border-radius: 6px; margin: 15px 0; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${model} - Gallery ${index}</h1>
            <p>Total: ${images.length} images</p>
            <div class="info">
              <strong>Source:</strong> ${images[0]?.url.includes('picsum.photos') ? 'Demo Images (Browser Failed)' : 'ahottie.net'}
            </div>
            <div>
              <a class="btn" href="/api/album/${model}/${index}">🔄 Rescrape</a>
              <a class="btn" href="/api/bulk-download/${model}/${index}">📥 Download Info</a>
              <a class="btn" href="/" style="background: #666;">🏠 Home</a>
            </div>
          </div>
          ${imageHtml}
          <div style="text-align: center; margin: 40px 0; color: #666;">
            <p>✨ End of gallery • <a href="#" onclick="window.scrollTo(0,0)">Back to top</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Other endpoints (keep them simple)
app.get('/api/bulk-download/:model/:index', async (req, res) => {
  try {
    const { model, index } = req.params;
    const cacheFile = path.join(__dirname, 'cache', `${model}_${index}.json`);

    let images = [];
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cached);
    } catch (e) {
      return res.status(404).json({ error: 'No cached images found' });
    }

    res.json({
      model,
      index,
      total_images: images.length,
      download_urls: images.map(img => img.url),
      view_gallery: `${getBaseUrl()}/api/nsfw/${model}/${index}`
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
        <title>🖼️ Image Scraper API - Working</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          }
          .container { 
            max-width: 1000px; 
            margin: 0 auto; 
            padding: 40px 20px;
            color: white;
          }
          .card { 
            background: rgba(255,255,255,0.1); 
            padding: 30px; 
            margin: 25px 0; 
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
            padding: 14px 28px; 
            border-radius: 8px; 
            text-decoration: none; 
            margin: 10px; 
            border: 1px solid rgba(255,255,255,0.3);
            transition: all 0.3s ease;
            font-weight: bold;
          }
          .btn:hover { 
            background: rgba(255,255,255,0.3); 
            transform: translateY(-2px);
          }
          .status { 
            background: rgba(76, 175, 80, 0.2); 
            padding: 15px; 
            border-radius: 8px; 
            border: 1px solid rgba(76, 175, 80, 0.5);
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div style="text-align: center; margin-bottom: 40px;">
            <h1 style="font-size: 3.5em; margin-bottom: 10px;">🖼️</h1>
            <h1 style="margin: 0;">Image Scraper API</h1>
            <p style="opacity: 0.9; font-size: 1.2em;">Working on Render with Real Scraping</p>
          </div>

          <div class="status">
            <h3>✅ Service Status: RUNNING</h3>
            <p>Chrome automation is configured for Render environment</p>
          </div>

          <div class="card">
            <h2>🚀 Quick Start</h2>
            <p>Test the scraper with these examples:</p>
            <div style="text-align: center;">
              <a class="btn" href="/api/album/cosplay/1">Scrape Cosplay Gallery 1</a>
              <a class="btn" href="/api/album/Mia%20Nanasawa/1">Scrape Mia Nanasawa</a>
              <a class="btn" href="/api/album/LinXingLan/1">Scrape Lin XingLan</a>
            </div>
          </div>

          <div class="card">
            <h2>📚 API Endpoints</h2>
            <ul style="line-height: 1.8;">
              <li><code>GET /api/album/:model/:index</code> - Scrape images from ahottie.net</li>
              <li><code>GET /api/nsfw/:model/:index</code> - View cached images in gallery</li>
              <li><code>GET /api/bulk-download/:model/:index</code> - Get download links</li>
            </ul>
          </div>

          <div class="card">
            <h2>🔧 Technical Info</h2>
            <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
            <p><strong>Search Source:</strong> <code>https://ahottie.net/search?kw=modelname</code></p>
            <p><strong>Environment:</strong> Render (Optimized for free tier)</p>
            <p><em>⚠️ First scrape may take 20-40 seconds as browser initializes</em></p>
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
    environment: 'Render',
    chrome: 'System Chromium',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health: ${getBaseUrl()}/health`);
  console.log(`🏠 Home: ${getBaseUrl()}`);
  console.log(`🔧 Using system Chromium on Render`);
});
