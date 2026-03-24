import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { WebBridge } from './web-bridge';

export class WebServer {
  private bridge: WebBridge;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WS>();

  constructor(bridge: WebBridge) {
    this.bridge = bridge;
  }

  start(port: number, publicDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const app = express();
      app.use(express.json());
      app.use(express.static(publicDir));

      // ── REST: full markdown for a report ──────────────────────────────────
      app.get('/api/reports/:filename', (req, res) => {
        const filename = req.params.filename;
        // Reject path traversal attempts
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
          res.status(400).json({ error: 'Invalid filename' });
          return;
        }
        const filePath = this.bridge.resolveReportPath(filename);
        if (!filePath) {
          res.status(404).json({ error: 'Report not found' });
          return;
        }
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          res.json({ content });
        } catch {
          res.status(500).json({ error: 'Could not read report' });
        }
      });

      // ── REST: link preview metadata ────────────────────────────────────────
      app.get('/api/preview', async (req, res) => {
        const rawUrl = req.query.url as string;
        if (!rawUrl) {
          res.status(400).json({ error: 'Missing url param' });
          return;
        }

        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          res.status(400).json({ error: 'Invalid URL' });
          return;
        }

        // Only allow requests to localhost / 127.0.0.1 or known allowed origins
        const allowedHosts = ['localhost', '127.0.0.1', ...this.bridge.allowedPreviewOrigins];
        const isAllowed = allowedHosts.some((h) => {
          try {
            return new URL(h.includes('://') ? h : `http://${h}`).hostname === parsed.hostname;
          } catch {
            return parsed.hostname === h;
          }
        });

        if (!isAllowed) {
          res.status(403).json({ error: 'URL not in allowed origins' });
          return;
        }

        try {
          const response = await fetch(rawUrl, {
            signal: AbortSignal.timeout(5_000),
            headers: { 'User-Agent': 'silly-testers-preview/1.0' },
          });
          const html = await response.text();

          const title = extractMeta(html, 'og:title') ?? extractTag(html, 'title') ?? '';
          const description = extractMeta(html, 'og:description') ?? extractMeta(html, 'description') ?? '';
          const image = extractMeta(html, 'og:image') ?? '';

          res.json({ url: rawUrl, title, description, image });
        } catch {
          res.status(502).json({ error: 'Could not fetch preview' });
        }
      });

      // ── HTTP + WebSocket server ────────────────────────────────────────────
      this.server = http.createServer(app);
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws: WS) => {
        this.clients.add(ws);

        // Send full state snapshot on connect
        const initPayload = JSON.stringify({ type: 'init', ...this.bridge.getInitState() });
        ws.send(initPayload);

        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
      });

      // Bridge events → broadcast to all WebSocket clients
      this.bridge.on('event', (event) => {
        const payload = JSON.stringify(event);
        for (const client of this.clients) {
          if (client.readyState === WS.OPEN) {
            client.send(payload);
          }
        }
      });

      this.server.on('error', reject);
      this.server.listen(port, () => {
        const url = `http://localhost:${port}`;
        resolve(url);
      });
    });
  }

  stop(): void {
    this.wss?.close();
    this.server?.close();
    this.clients.clear();
  }
}

// ── HTML meta extraction helpers ────────────────────────────────────────────

function extractTag(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function extractMeta(html: string, name: string): string | null {
  // Match both name= and property= variants
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']|` +
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
    'i'
  );
  const m = html.match(pattern);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}
