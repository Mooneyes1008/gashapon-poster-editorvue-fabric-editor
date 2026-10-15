import { ServiceError } from './config.mjs';
import { searchCommons } from './commons.mjs';
import { searchOpenverse, loadCandidateImage, hasTransparentPixels } from './openverse.mjs';
import { analyzeRequirements, analyzeImages, validatePlan } from './ai.mjs';

export class MaterialService {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.cache = new Map();
    this.images = new Map();
    this.imageBytes = 0;
    this.searchProvider = dependencies.searchProvider;
    this.loadImage = dependencies.loadImage || loadCandidateImage;
    this.analyzeText = dependencies.analyzeText || analyzeRequirements;
    this.analyzeVisual = dependencies.analyzeVisual || analyzeImages;
  }
  status() {
    return {
      provider: 'Wikimedia Commons / Openverse',
      aiConfigured: !!this.config.aiKey,
      model: this.config.model,
      visualEnabled: this.config.visual,
      configurationCommand: 'pnpm ai:configure',
      cost: 'Openverse 匿名限流；AI 按实际 token 与图片用量计费，每次最多 1 次文字分析及 1 次含 6 张图的视觉分析。',
    };
  }
  async analyze(input) {
    return this.analyzeText(input.prompt, input.refinements || [], this.config);
  }
  remember(candidate) {
    for (const [token, entry] of this.cache)
      if (Date.now() - entry.created > 30 * 60 * 1000) this.cache.delete(token);
    while (this.cache.size >= 120) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(candidate.token, { candidate, created: Date.now() });
  }
  get(token) {
    const entry = this.cache.get(token);
    if (!entry || Date.now() - entry.created > 30 * 60 * 1000)
      throw new ServiceError('RESULT_EXPIRED', '结果已过期或服务已重启，请重新搜索。', 410);
    return entry.candidate;
  }
  async image(candidate, thumbnail = false) {
    const key = `${candidate.token}:${thumbnail}`;
    if (this.images.has(key)) return this.images.get(key);
    const image = await this.loadImage(candidate, this.config, thumbnail);
    while (this.imageBytes + image.bytes.length > 32 * 1024 * 1024 && this.images.size) {
      const oldKey = this.images.keys().next().value;
      this.imageBytes -= this.images.get(oldKey).bytes.length;
      this.images.delete(oldKey);
    }
    this.images.set(key, image);
    this.imageBytes += image.bytes.length;
    return image;
  }
  async search(input) {
    const ai = input.mode === 'ai';
    const plan = ai ? validatePlan(input.plan) : null;
    if (ai && !this.config.aiKey)
      throw new ServiceError(
        'AI_NOT_CONFIGURED',
        'AI 尚未配置，请先配置，或明确切换为关键词直接搜索。',
        503
      );
    if (ai && !this.config.visual)
      throw new ServiceError(
        'VISUAL_DISABLED',
        'AI 素材搜索需要服务端图片分析，请开启 POSTER_AI_VISUAL。',
        503
      );
    const transparent = ai ? plan.transparent : input.transparent === true;
    const query = ai ? plan.keywords.en.slice(0, 2).join(' ') : input.query;
    const source = input.source === 'openverse' ? 'openverse' : 'commons';
    const provider =
      this.searchProvider || (source === 'openverse' ? searchOpenverse : searchCommons);
    const result = await provider(query, this.config, { transparent });
    const warnings = [
      '授权信息来自索引记录，使用前请核对来源页面；BY/BY-SA 素材需署名，BY-SA 改编须遵循相同方式共享。',
    ];
    let candidates = result.candidates;
    if (!candidates.length)
      warnings.push('没有找到符合关键词和授权条件的可导入图片，请缩短关键词或调整要求。');
    if (transparent) {
      const checked = await Promise.all(
        candidates.slice(0, 12).map(async (candidate) => {
          try {
            const image = await this.image(candidate);
            if (!hasTransparentPixels(image.bytes, image.mime)) return null;
            return { ...candidate, transparency: 'verified' };
          } catch {
            warnings.push('部分候选无法下载或不满足透明 PNG 校验，已排除。');
            return null;
          }
        })
      );
      candidates = checked.filter(Boolean);
      if (!candidates.length)
        warnings.push(
          '未找到已验证含透明像素的 PNG；不会把白底图或仅有 PNG 后缀的图片冒充透明素材。'
        );
    }
    if (ai && candidates.length) {
      const visualInputs = [];
      for (const candidate of candidates.slice(0, 6)) {
        try {
          const image = await this.image(candidate, true);
          if (image.bytes.length > 1024 * 1024) {
            warnings.push('部分预览超过图片分析大小限制，未发送给 AI。');
            continue;
          }
          visualInputs.push({
            ...candidate,
            imageData: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
          });
        } catch {
          warnings.push('部分预览无法加载，未假定其符合需求。');
        }
      }
      if (!visualInputs.length)
        throw new ServiceError(
          'NO_ANALYZABLE_IMAGES',
          '真实候选图片无法下载，不能完成视觉筛选；请检查网络或调整关键词。',
          502
        );
      const rankings = await this.analyzeVisual(plan, visualInputs, this.config);
      candidates = visualInputs
        .map((candidate) => {
          const ranking = rankings.find((item) => item.token === candidate.token);
          if (!ranking?.match) return null;
          const { imageData, ...item } = candidate;
          return { ...item, reason: ranking.reason, score: ranking.score, visual: 'analyzed' };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    }
    for (const candidate of candidates) this.remember(candidate);
    return {
      provider: source === 'openverse' ? 'Openverse' : 'Wikimedia Commons',
      query,
      plan,
      mode: ai ? 'ai' : 'keywords',
      candidates: candidates.map(({ originalUrl, thumbnail, ...item }) => ({
        ...item,
        previewUrl: `/api/material-search/preview?token=${item.token}`,
      })),
      warnings: [...new Set(warnings)],
      hasMore: result.hasMore,
    };
  }
  async preview(token) {
    return this.image(this.get(token), true);
  }
  async import(token, acceptLicense) {
    if (acceptLicense !== true)
      throw new ServiceError('LICENSE_ACK', '请先核对来源授权并确认保留署名信息。');
    const candidate = this.get(token),
      image = await this.image(candidate);
    // Recheck at import time; the original may differ from a cached thumbnail.
    if (candidate.transparency === 'verified' && !hasTransparentPixels(image.bytes, image.mime))
      throw new ServiceError('TRANSPARENCY_CHANGED', '来源图片已变化，不再满足透明素材要求。');
    return {
      name: `${candidate.title.slice(0, 80)}.${image.mime.split('/')[1]}`,
      data: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
      provenance: {
        provider: candidate.id.startsWith('commons-') ? 'wikimedia' : 'openverse',
        sourceUrl: candidate.sourceUrl,
        originalUrl: candidate.originalUrl,
        title: candidate.title,
        creator: candidate.creator,
        license: candidate.license,
        licenseVersion: candidate.licenseVersion,
        licenseUrl: candidate.licenseUrl,
        attribution: candidate.attribution,
        importedAt: new Date().toISOString(),
        reason: candidate.reason,
      },
    };
  }
}
