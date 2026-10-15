import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ServiceError } from './config.mjs';

const mediaHosts = new Set(['upload.wikimedia.org', 'live.staticflickr.com', 'api.openverse.org']);
export function publicMediaUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !mediaHosts.has(url.hostname)
    )
      throw new Error();
    return url;
  } catch {
    throw new ServiceError(
      'UNSUPPORTED_MEDIA_HOST',
      '此素材的图片地址暂不支持安全导入，请打开来源页面查看。'
    );
  }
}
export function requestBytes(
  url,
  {
    proxy = '',
    method = 'GET',
    headers = {},
    body,
    limit = 8 * 1024 * 1024,
    timeout = 25000,
    allowedHosts,
  } = {}
) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    (allowedHosts && !allowedHosts.has(target.hostname))
  )
    throw new ServiceError('UNSAFE_URL', '不支持的外部请求地址。');
  return new Promise((resolve, reject) => {
    const req = https.request(
      target,
      {
        method,
        headers: {
          'User-Agent':
            'GashaponPosterEditor/2.0 (https://github.com/Mooneyes1008/gashapon-poster-editorvue-fabric-editor)',
          ...headers,
        },
        agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      },
      (res) => {
        const chunks = [];
        let length = 0;
        if (Number(res.headers['content-length']) > limit) {
          res.destroy();
          reject(new ServiceError('MEDIA_TOO_LARGE', '外部文件超过大小限制。'));
          return;
        }
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > limit) {
            res.destroy();
            reject(new ServiceError('MEDIA_TOO_LARGE', '外部文件超过大小限制。'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) })
        );
        res.on('error', () =>
          reject(new ServiceError('UPSTREAM_NETWORK', '外部文件传输中断，请重试。', 502))
        );
      }
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () =>
      reject(
        new ServiceError('UPSTREAM_NETWORK', '外部服务连接失败，请检查网络权限或代理设置。', 502)
      )
    );
    if (body) req.write(body);
    req.end();
  });
}
export async function requestJson(url, options = {}) {
  const response = await requestBytes(url, { ...options, limit: 2 * 1024 * 1024 });
  if (response.status === 429)
    throw new ServiceError('RATE_LIMITED', '外部服务调用频率或额度已达限制，请稍后重试。', 429);
  if (response.status === 403 && response.headers['cf-mitigated'] === 'challenge')
    throw new ServiceError(
      'UPSTREAM_CHALLENGE',
      '素材接口要求网页验证，服务端未取得真实 API 数据。可尝试 Wikimedia 官方直连入口。',
      502
    );
  if (response.status === 401)
    throw new ServiceError('AI_AUTH', 'AI 密钥无效或不可用，请在本机重新配置。', 502);
  if (response.status < 200 || response.status >= 300)
    throw new ServiceError(
      'UPSTREAM_HTTP',
      `外部服务返回 HTTP ${response.status}，未取得有效结果。`,
      502
    );
  try {
    return JSON.parse(response.bytes.toString('utf8'));
  } catch {
    throw new ServiceError(
      'UPSTREAM_FORMAT',
      '外部服务未返回有效 JSON；没有可用的真实搜索结果。',
      502
    );
  }
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  throw new ServiceError('UNSUPPORTED_IMAGE', '来源文件不是有效 PNG、JPEG 或 WebP，未导入。');
}
export async function downloadMedia(value, config, requester = requestBytes) {
  let url = publicMediaUrl(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await requester(url, { proxy: config.proxy, allowedHosts: mediaHosts });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = publicMediaUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (response.status !== 200)
      throw new ServiceError(
        'MEDIA_UNAVAILABLE',
        `来源图片返回 HTTP ${response.status}；请检查网络或打开来源页面。`,
        502
      );
    const mime = imageMime(response.bytes);
    if (
      mime === 'image/png' &&
      (response.bytes.length < 24 ||
        response.bytes.readUInt32BE(16) * response.bytes.readUInt32BE(20) > 40000000)
    )
      throw new ServiceError('IMAGE_DIMENSIONS', '来源图片超过 4000 万像素限制，未导入。');
    return { bytes: response.bytes, mime };
  }
  throw new ServiceError('MEDIA_REDIRECT', '来源图片重定向过多，已停止导入。', 502);
}
