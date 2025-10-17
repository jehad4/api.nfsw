const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ensure directories exist
async function ensureDirectories() {
  const dirs = [path.join(__dirname, 'cache'), path.join(__dirname, 'downloads')];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (e) {
      console.error(`Failed to create directory ${dir}: ${e.message}`);
    }
  }
}
ensureDirectories().catch(console.error);

// ==================== ALBUM SCRAPER ====================
app.get('/api/album/:model/:index', async (req, res) => {
  let browser;
  try {
    const { model, index } = req.params;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, `images_${index}.json`);
    await fs.mkdir(cacheDir, { recursive: true });

    // Serve cached
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cached);
      if (images.length > 0) {
        return res.json({ model, index, album: images, total: images.length, source: 'cache', downloads_url: `${HOST}/downloads/${encodeURIComponent(model)}/` });
      }
    } catch {}

    // Puppeteer scrape
    let imageUrls = [], galleryLinks = [];
    const maxAttempts = 3, indexNum = parseInt(index, 10);

    for (let attempt = 1; attempt <= maxAttempts && imageUrls.length === 0; attempt++) {
      try {
        const args = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-features=IsolateOrigins,site-per-process',
          '--blink-settings=imagesEnabled=true'
        ];
        browser = await puppeteer.launch({ headless: 'new', args });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        const searchUrl = `https://ahottie.net/search?kw=${encodeURIComponent(model)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(12000);

        // Scroll
        await page.evaluate(async () => {
          await new Promise(resolve => {
            let total = 0, distance = 200, count = 0, maxScrolls = 60;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              total += distance; count++;
              if (total >= scrollHeight || count >= maxScrolls) { clearInterval(timer); resolve(); }
            }, 200);
          });
        });
        await delay(8000);

        // Get gallery links
        galleryLinks = await page.evaluate(() => {
          const selectors = ['a[href*="/20"]','.post-title a','.entry-title a','h2 a','h3 a','.post a','.gallery a','a[href*="/gallery/"]','a[href*="/photo/"]','.thumb a','.image-link','.post-thumbnail a','.wp-block-gallery a','a[href*="/tags/"]','a[href*="ahottie.net"]'];
          const links = [];
          selectors.forEach(sel => document.querySelectorAll(sel).forEach(a => {
            if(a.href && !a.href.includes('/search') && !a.href.includes('/page/') && !a.href.includes('#')) links.push(a.href);
          }));
          return [...new Set(links)];
        });

        if (isNaN(indexNum) || indexNum < 1 || indexNum > galleryLinks.length) {
          await browser.close();
          return res.status(400).json({ error: `Invalid index ${indexNum}`, links_found: galleryLinks.length });
        }

        const galleryLink = galleryLinks[indexNum-1];
        await page.goto(galleryLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(10000);

        imageUrls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img, [style*="background-image"]'));
          const urls = [];
          imgs.forEach(el => {
            let src;
            if (el.tagName.toLowerCase() === 'img') src = el.src || el.getAttribute('data-src') || el.getAttribute('data-original');
            else { const m = el.getAttribute('style')?.match(/url\(['"]?(.+?)['"]?\)/i); src = m? m[1]:null; }
            if(src && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(src)) urls.push(src);
          });
          return urls.slice(0,50);
        });

        await browser.close();
        browser = null;

      } catch (err) {
        if(browser) { await browser.close(); browser=null; }
      }
    }

    if(imageUrls.length===0){
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({ error: `No images for "${model}" index ${index}`, search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}` });
    }

    const images = imageUrls.map((url,idx)=>({ id: idx+1, name:`image_${idx+1}.${url.split('.').pop().split('?')[0]}`, url, thumb: url }));
    await fs.writeFile(cacheFile, JSON.stringify(images,null,2));
    res.json({ model, index, album: images, total: images.length, source: 'ahottie.net', search_url: `https://ahottie.net/search?kw=${encodeURIComponent(model)}`, gallery_url: galleryLinks[indexNum-1] || 'N/A', downloads_url: `${HOST}/downloads/${encodeURIComponent(model)}/` });
  } catch (err) {
    if(browser) await browser.close();
    res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
});

// ==================== NSFW DISPLAY ====================
app.get('/api/nsfw/:model/:index', async (req,res)=>{
  try {
    const {model,index} = req.params;
    const cacheFile = path.join(__dirname,'cache',model,`images_${index}.json`);
    let images = [];
    try{ images = JSON.parse(await fs.readFile(cacheFile,'utf8')); } catch { images=[]; }
    if(!images.length) return res.status(404).send(`<h1>No cached images for ${model} at index ${index}</h1>`);

    const html = images.map(img=>`<div><h3>${img.name}</h3><img src="${img.url}" style="max-width:100%;max-height:600px"></div>`).join('');
    res.send(`<html><head><title>${model} ${index}</title></head><body><h1>${model} index ${index}</h1>${html}</body></html>`);
  } catch(e){ res.status(500).send(`<h1>Error: ${e.message}</h1>`); }
});

// ==================== HEALTH CHECK / ROOT ====================
app.get('/',(req,res)=>{
  res.send(`<html><head><title>Render Image Scraper</title></head><body>
    <h1>Render Image Scraper API Ready</h1>
    <ul>
      <li><a href="${HOST}/api/album/cosplay/5">${HOST}/api/album/cosplay/5</a></li>
      <li><a href="${HOST}/api/nsfw/cosplay/5">${HOST}/api/nsfw/cosplay/5</a></li>
    </ul>
  </body></html>`);
});

// Start server
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
