import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { ServiceError } from './config.mjs';
import { publicMediaUrl, requestJson, downloadMedia } from './network.mjs';
const licenses = new Set(['cc0', 'pdm', 'by', 'by-sa']);
export function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export function normalizeResult(record) {
  if (
    !record ||
    !/^[0-9a-f-]{36}$/i.test(record.id) ||
    !licenses.has(record.license) ||
    record.mature === true ||
    Number(record.width) * Number(record.height) > 40000000
  )
    return null;
  // Phase two starts with Wikimedia via Openverse, rather than arbitrary downloadable hosts.
  try {
    publicMediaUrl(record.url);
  } catch {
    return null;
  }
  if (!safeLink(record.foreign_landing_url) || !safeLink(record.license_url)) return null;
  return {
    token: randomUUID(),
    id: record.id,
    title: String(record.title || '未命名素材').slice(0, 300),
    creator: String(record.creator || '来源未提供作者').slice(0, 300),
    sourceUrl: safeLink(record.foreign_landing_url),
    source: String(record.source || 'Openverse'),
    license: record.license.toUpperCase(),
    licenseVersion: String(record.license_version || ''),
    licenseUrl: safeLink(record.license_url),
    attribution: `${record.title || '未命名素材'} — ${
      record.creator || '作者未提供'
    } / ${record.license.toUpperCase()} ${record.license_version || ''}`,
    originalUrl: record.url,
    thumbnail: record.thumbnail,
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    transparency: 'unchecked',
    visual: 'not-analyzed',
    reason: '真实 Openverse 关键词检索结果，尚未进行图片分析。',
  };
}
export async function searchOpenverse(
  query,
  config,
  { transparent = false, page = 1 } = {},
  requester = requestJson
) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300)
    throw new ServiceError('INVALID_QUERY', '请输入 1–300 字符的检索关键词。');
  const url = new URL('https://api.openverse.org/v1/images/');
  url.search = new URLSearchParams({
    q: query.trim(),
    source: 'wikimedia',
    page_size: '12',
    page: String(page),
    license: 'cc0,pdm,by,by-sa',
    mature: 'false',
    ...(transparent ? { extension: 'png' } : {}),
  }).toString();
  const data = await requester(url, { proxy: config.proxy });
  if (!Array.isArray(data.results))
    throw new ServiceError('OPENVERSE_FORMAT', 'Openverse 返回格式异常，未生成替代结果。', 502);
  return {
    candidates: data.results.map(normalizeResult).filter(Boolean),
    page,
    hasMore: !!data.next,
    resultCount: Number(data.result_count) || 0,
  };
}
export function hasTransparentPixels(bytes, mime) {
  if (mime !== 'image/png') return false;
  if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16000000)
    throw new ServiceError('IMAGE_DIMENSIONS', '透明检测图片超过 1600 万像素限制。');
  try {
    const png = PNG.sync.read(bytes, { checkCRC: true });
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < 255) return true;
    return false;
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError('INVALID_PNG', '来源 PNG 无法解码，未将其当作透明素材。');
  }
}
export async function loadCandidateImage(candidate, config, thumbnail = false) {
  if (thumbnail) {
    try {
      publicMediaUrl(candidate.thumbnail);
      return await downloadMedia(candidate.thumbnail, config);
    } catch {
      /* Fall back to the known original, never to arbitrary client input. */
    }
  }
  return downloadMedia(candidate.originalUrl, config);
}
