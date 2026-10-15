import type { Plugin } from 'vite';

/** Defense in depth for the inherited Vite 4 server; this is a local editor, not a public server. */
export function allowDevelopmentRequest(rawUrl: string, host = '', origin?: string) {
  try {
    const parsedHost = new URL(`http://${host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedHost.hostname)) return false;
    if (origin && new URL(origin).host !== parsedHost.host) return false;
    let pathname = rawUrl.split('?')[0];
    for (let i = 0; i < 4; i++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    pathname = pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (
      pathname.includes('\0') ||
      /(^|\/)\.\.(\/|$)/.test(pathname) ||
      /(^|\/)@fs(\/|$)/i.test(pathname)
    )
      return false;
    if (/(^|\/)\.(env[^/]*|git|cloud-tools|npm-cache|pnpm-store)(\/|$)/i.test(pathname))
      return false;
    return true;
  } catch {
    return false;
  }
}
export default function localDevGuard(): Plugin {
  return {
    name: 'local-poster-development-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!allowDevelopmentRequest(req.url || '/', req.headers.host, req.headers.origin)) {
          res.statusCode = 403;
          res.end('Local development requests only.');
          return;
        }
        next();
      });
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (!allowDevelopmentRequest(req.url || '/', req.headers.host, req.headers.origin))
          socket.destroy();
      });
    },
  };
}
