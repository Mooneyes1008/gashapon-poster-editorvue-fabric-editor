import { randomUUID } from 'node:crypto';
import { ServiceError } from './config.mjs';
import { publicMediaUrl, requestJson } from './network.mjs';
import { safeLink } from './openverse.mjs';
function plain(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}
export function normalizeCommons(record) {
  const image = record.imageinfo?.[0],
    meta = image?.extmetadata;
  if (
    !image ||
    !meta ||
    image.width * image.height > 40000000 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)
  )
    return null;
  let license = plain(meta.LicenseShortName?.value),
    version = '';
  if (/^CC0\b/i.test(license)) {
    license = 'CC0';
    version = '1.0';
  } else if (/^Public domain$/i.test(license)) license = 'PDM';
  else {
    const match = license.match(/^CC (BY(?:-SA)?)\s+(\d+\.\d+)$/i);
    if (!match) return null;
    license = match[1].toUpperCase();
    version = match[2];
  }
  try {
    publicMediaUrl(image.url);
  } catch {
    return null;
  }
  const licenseUrl =
    safeLink(meta.LicenseUrl?.value) ||
    (license === 'PDM'
      ? 'https://creativecommons.org/publicdomain/mark/1.0/'
      : license === 'CC0'
      ? 'https://creativecommons.org/publicdomain/zero/1.0/'
      : '');
  if (!licenseUrl) return null;
  const sourceUrl = safeLink(image.descriptionurl);
  if (!sourceUrl) return null;
  const title = plain(record.title.replace(/^File:/, '')).slice(0, 300);
  const creator = plain(meta.Artist?.value).slice(0, 600) || '来源未提供作者';
  const extraCredit = [
    plain(meta.Credit?.value).slice(0, 600),
    plain(meta.Attribution?.value).slice(0, 600),
  ]
    .filter((value) => value && value !== creator)
    .join(' / ');
  return {
    token: randomUUID(),
    id: `commons-${record.pageid}`,
    title,
    creator,
    sourceUrl,
    source: 'wikimedia',
    license,
    licenseVersion: version,
    licenseUrl,
    attribution: `${title} — ${creator} / ${license} ${version}${
      extraCredit ? ` / ${extraCredit}` : ''
    }`,
    originalUrl: image.url,
    thumbnail: image.thumburl || image.url,
    width: image.width,
    height: image.height,
    transparency: 'unchecked',
    visual: 'not-analyzed',
    reason: 'Wikimedia Commons 官方索引的真实关键词结果，未进行图片分析。',
  };
}
export async function searchCommons(
  query,
  config,
  { transparent = false } = {},
  requester = requestJson
) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300)
    throw new ServiceError('INVALID_QUERY', '请输入 1–300 字符的检索关键词。');
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${query.trim()} filetype:bitmap${transparent ? ' filemime:image/png' : ''}`,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|Attribution',
    iiurlwidth: '400',
    format: 'json',
  }).toString();
  const data = await requester(url, { proxy: config.proxy });
  if (data.error)
    throw new ServiceError(
      'COMMONS_ERROR',
      'Wikimedia 官方检索返回错误，请调整关键词或稍后重试。',
      502
    );
  if (!data.query?.pages) {
    if (data.batchcomplete !== undefined) return { candidates: [], hasMore: false };
    throw new ServiceError('COMMONS_FORMAT', 'Wikimedia 返回格式异常，未生成替代结果。', 502);
  }
  return {
    candidates: Object.values(data.query.pages)
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map(normalizeCommons)
      .filter(Boolean),
    hasMore: !!data.continue,
  };
}
