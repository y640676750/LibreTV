import path from 'path';
import express from 'express';
import axios from 'axios';
import https from 'https';
import cors from 'cors';
import { fileURLToPath } from 'url';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 8080;

app.use(cors());
app.use(express.static('./'));

function getBaseUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split('/');
    parts.pop();
    return `${parsed.origin}${parts.join('/')}/`;
  } catch {
    const idx = urlStr.lastIndexOf('/');
    return idx > urlStr.indexOf('://') + 2 ? urlStr.substring(0, idx + 1) : urlStr + '/';
  }
}

function resolveUrl(baseUrl, relativeUrl) {
  if (!relativeUrl) return '';
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    if (relativeUrl.startsWith('/')) {
      const origin = new URL(baseUrl).origin;
      return `${origin}${relativeUrl}`;
    }
    return baseUrl.replace(/\/[^/]*$/, '/') + relativeUrl;
  }
}

function rewriteUrlToProxy(targetUrl) {
  return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function isM3u8Content(content, contentType) {
  if (contentType && (contentType.includes('mpegurl') || contentType.includes('mpegURL'))) return true;
  return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processM3u8(targetUrl, content) {
  const baseUrl = getBaseUrl(targetUrl);
  const lines = content.split('\n');
  const output = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-KEY')) {
      output.push(trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
        return `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`;
      }));
    } else if (trimmed.startsWith('#EXT-X-MAP')) {
      output.push(trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
        return `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`;
      }));
    } else if (trimmed && !trimmed.startsWith('#')) {
      output.push(rewriteUrlToProxy(resolveUrl(baseUrl, trimmed)));
    } else {
      output.push(trimmed);
    }
  }
  return output.join('\n');
}

// Extract real m3u8 URL from HTML share/player pages
function extractM3u8FromHtml(html, pageUrl) {
  // First try: look for .m3u8 URLs anywhere in the HTML
  const m3u8Patterns = [
    /["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i,
    /["'](\/[^"'\s]+\.m3u8[^"'\s]*)/i,
  ];
  for (const pattern of m3u8Patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const url = match[1];
      if (/^https?:\/\//.test(url)) return url;
      try { return new URL(url, pageUrl).toString(); } catch { /* continue */ }
    }
  }

  // Second try: look for url/source variable assignments
  const varPatterns = [
    /(?:url|source|video_url|playUrl)\s*[:=]\s*["']([^"']+)/i,
  ];
  for (const pattern of varPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const url = match[1];
      if (/^https?:\/\//.test(url)) return url;
      if (url.startsWith('/')) {
        try { return new URL(url, pageUrl).toString(); } catch { /* continue */ }
      }
    }
  }
  return null;
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('Invalid URL');
    }

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });

    const response = await axios({
      method: 'get',
      url: targetUrl,
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': new URL(targetUrl).origin + '/',
      },
      maxRedirects: 5,
      httpsAgent,
    });

    const contentType = response.headers['content-type'] || '';
    const content = Buffer.from(response.data).toString('utf-8');

    if (isM3u8Content(content, contentType)) {
      const processed = processM3u8(targetUrl, content);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(processed);
    }

    // If response is HTML, try to extract m3u8 URL from share/player pages
    if (contentType.includes('text/html') && content.includes('<')) {
      const realM3u8Url = extractM3u8FromHtml(content, targetUrl);
      if (realM3u8Url) {
        try {
          const m3u8Response = await axios({
            method: 'get',
            url: realM3u8Url,
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': new URL(realM3u8Url).origin + '/',
            },
            maxRedirects: 5,
            httpsAgent,
          });
          const m3u8Content = Buffer.from(m3u8Response.data).toString('utf-8');
          if (isM3u8Content(m3u8Content, m3u8Response.headers['content-type'] || '')) {
            const processed = processM3u8(realM3u8Url, m3u8Content);
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(processed);
          }
        } catch (e) {
          console.warn('Failed to fetch extracted m3u8:', e.message);
        }
      }
    }

    // For non-m3u8 content, forward as-is
    const headers = { ...response.headers };
    delete headers['content-security-policy'];
    delete headers['cookie'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    headers['access-control-allow-origin'] = '*';
    res.set(headers);
    res.send(response.data);

  } catch (error) {
    if (error.response) {
      res.status(error.response.status).send(error.response.data);
    } else {
      res.status(500).send(error.message);
    }
  }
});

const isValidUrl = (urlString) => {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    const blockedHostnames = ['localhost', '127.0.0.1'];
    return allowedProtocols.includes(parsed.protocol) &&
           !blockedHostnames.includes(parsed.hostname);
  } catch {
    return false;
  }
};

app.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`)
});
