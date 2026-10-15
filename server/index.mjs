import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { readConfiguration, ServiceError } from './config.mjs';
import { MaterialService } from './service.mjs';
export function localRequest(req) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    const parsed = new URL(origin);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
      ['3000', '3001', '5000'].includes(parsed.port) &&
      parsed.protocol === 'http:'
    );
  } catch {
    return false;
  }
}
function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json'))
    throw new ServiceError('CONTENT_TYPE', '需要 JSON 请求。', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16000) throw new ServiceError('BODY_TOO_LARGE', '请求过大。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ServiceError('INVALID_JSON', '请求 JSON 无效。');
  }
}
export function createMaterialServer(service) {
  let inFlight = 0;
  const recent = [];
  return http.createServer(async (req, res) => {
    if (!localRequest(req))
      return json(res, 403, { code: 'LOCAL_ONLY', message: '仅允许本机同源访问。' });
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/api/material-search/status')
        return json(res, 200, service.status());
      if (req.method === 'GET' && path === '/api/material-search/preview') {
        const token = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
        const image = await service.preview(token);
        res.writeHead(200, {
          'Content-Type': image.mime,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        });
        return res.end(image.bytes);
      }
      if (
        req.method !== 'POST' ||
        !['/analyze', '/search', '/import'].some((p) => path === `/api/material-search${p}`)
      )
        return json(res, 404, { code: 'NOT_FOUND', message: '接口不存在。' });
      const now = Date.now();
      while (recent[0] < now - 60000) recent.shift();
      if (recent.length >= 20 || inFlight >= 2)
        throw new ServiceError('LOCAL_RATE_LIMIT', '请求较多，请等待当前操作完成。', 429);
      const data = await body(req);
      recent.push(now);
      inFlight++;
      try {
        if (path.endsWith('/analyze')) return json(res, 200, { plan: await service.analyze(data) });
        if (path.endsWith('/search')) return json(res, 200, await service.search(data));
        return json(res, 200, await service.import(data.token, data.acceptLicense));
      } finally {
        inFlight--;
      }
    } catch (error) {
      if (error instanceof ServiceError)
        return json(res, error.status, { code: error.code, message: error.message });
      return json(res, 500, {
        code: 'SERVER_ERROR',
        message: '服务端处理失败。未生成替代结果，请重试或查看本机配置。',
      });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfiguration();
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
      throw new Error('无效服务端端口');
    const server = createMaterialServer(new MaterialService(config));
    server.on('error', () => {
      console.error('素材服务无法启动，请检查端口 3001 是否被占用。');
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () =>
      console.log(
        `本地素材服务已启动（${config.aiKey ? 'AI 已配置' : 'AI 未配置，可使用真实关键词搜索'}）`
      )
    );
  } catch {
    console.error('素材服务配置无效，请运行 pnpm ai:configure 重新配置。');
    process.exitCode = 1;
  }
}
