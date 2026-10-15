<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import {
  materialApi,
  materialSearchProvider,
  type ImportedMaterial,
  type MaterialCandidate,
  type MaterialPlan,
  type MaterialStatus,
  type SearchResponse,
} from '../gashapon/ai';
const props = defineProps<{
  importAsset: (asset: ImportedMaterial) => Promise<void>;
  editorBusy: boolean;
}>();
const status = ref<MaterialStatus | null>(null);
const mode = ref<'ai' | 'keywords'>('ai');
const providerSource = ref<'commons' | 'openverse'>('commons');
const languages = ['zh', 'en', 'ja'] as const;
const languageLabels = { zh: '中', en: '英', ja: '日' };
const prompt = ref('');
const keyword = ref('');
const refinement = ref('');
const refinements = ref<string[]>([]);
const plan = ref<MaterialPlan | null>(null);
const response = ref<SearchResponse | null>(null);
const transparent = ref(false);
const loading = ref(false);
const importing = ref('');
const notice = ref('');
const error = ref('');
const progress = ref('');
const licenseAccepted = ref(false);
const failedPreviews = ref<string[]>([]);
let controller: AbortController | null = null;
let activePrompt = '';
let revision = 0;
async function refreshStatus() {
  try {
    status.value = await materialApi<MaterialStatus>('status');
    if (!status.value.aiConfigured && !response.value && !prompt.value) mode.value = 'keywords';
    error.value = '';
  } catch (e) {
    status.value = null;
    error.value = (e as Error).message;
  }
}
function cancel() {
  controller?.abort();
  revision++;
  loading.value = false;
  notice.value = '已取消等待。已发出的外部请求可能仍会计费，请勿连续重复提交。';
}
function clearResults() {
  cancel();
  response.value = null;
  plan.value = null;
  refinements.value = [];
  notice.value = '';
  error.value = '';
}
async function search(adjustment = '') {
  if (loading.value || importing.value) return;
  if (mode.value === 'ai' && (!status.value?.aiConfigured || !status.value.visualEnabled)) {
    error.value = 'AI 未配置或图片分析被关闭，请查看安全配置说明；也可切换为关键词直接搜索。';
    return;
  }
  const source = mode.value === 'ai' ? prompt.value.trim() : keyword.value.trim();
  if (!source) {
    error.value =
      mode.value === 'ai' ? '请先描述你需要的素材。' : '请输入关键词，例如 flower illustration。';
    return;
  }
  if (adjustment && source !== activePrompt) {
    error.value = '原始需求已更改，请先重新分析检索，再追加要求。';
    return;
  }
  if (adjustment && refinements.value.length >= 10) {
    error.value = '追加要求最多 10 条，请整理需求后重新搜索。';
    return;
  }
  const nextRefinements = adjustment ? [...refinements.value, adjustment] : [];
  loading.value = true;
  error.value = '';
  notice.value = '';
  response.value = null;
  licenseAccepted.value = false;
  failedPreviews.value = [];
  controller = new AbortController();
  const currentController = controller;
  const currentRevision = ++revision;
  const timeout = window.setTimeout(() => currentController.abort(), 180000);
  try {
    let result: SearchResponse;
    if (mode.value === 'ai') {
      progress.value = '服务端正在分析需求和中英日关键词…';
      const analyzed = await materialSearchProvider.analyze(
        source,
        nextRefinements,
        currentController.signal
      );
      if (currentRevision !== revision) return;
      plan.value = analyzed.plan;
      progress.value = '正在检索真实素材并进行服务端图片筛选（最多 6 张）…';
      result = await materialSearchProvider.search(
        { mode: 'ai', plan: analyzed.plan, source: providerSource.value },
        currentController.signal
      );
    } else {
      progress.value = '正在请求所选真实素材索引，不调用 AI…';
      result = await materialSearchProvider.search(
        {
          mode: 'keywords',
          query: source,
          transparent: transparent.value,
          source: providerSource.value,
        },
        currentController.signal
      );
      plan.value = null;
    }
    if (currentRevision !== revision) return;
    response.value = result;
    activePrompt = source;
    refinements.value = nextRefinements;
    refinement.value = '';
    notice.value = result.candidates.length
      ? `找到 ${result.candidates.length} 张真实候选。选择前请核对来源和授权。`
      : '本次没有符合条件的素材，请调整需求或关键词。';
  } catch (e) {
    if (currentRevision === revision)
      error.value = currentController.signal.aborted
        ? '请求等待超时，请检查服务或稍后重试；没有生成假结果。'
        : (e as Error).message;
  } finally {
    window.clearTimeout(timeout);
    if (currentRevision === revision) loading.value = false;
  }
}
async function importCandidate(candidate: MaterialCandidate) {
  if (!licenseAccepted.value || importing.value || props.editorBusy) return;
  importing.value = candidate.token;
  error.value = '';
  notice.value = '';
  try {
    const material = await materialSearchProvider.import(candidate.token, true);
    await props.importAsset(material);
    notice.value = '已加入共享素材库，来源与署名已随项目保留。点击缩略图即可放入画布。';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    importing.value = '';
  }
}
onMounted(refreshStatus);
onBeforeUnmount(() => {
  controller?.abort();
  revision++;
});
</script>

<template>
  <div class="material-search-panel">
    <div class="search-intro">
      <span class="provider-badge">Wikimedia · 真实素材</span>
      <h2>让灵感，找到出处。</h2>
      <p>真实素材检索，来源与授权随项目保留。</p>
    </div>
    <details class="configuration">
      <summary>安全配置与费用</summary>
      <p>
        AI 文字分析和图片分析均在本机服务端调用 OpenAI
        API，按用量计费；每次最多一次文字分析和一次包含 6 张图的图片分析。ChatGPT 订阅不包含 API
        费用。
      </p>
      <p>在项目终端运行：</p>
      <code>pnpm ai:configure</code>
      <p>
        如果 Mac 找不到 pnpm，请使用：
        <code>"$HOME/.local/bin/pnpm" ai:configure</code>
      </p>
      <p>
        密钥不回显，保存为被 Git 忽略的
        <code>server/.env.local</code>
        （仅当前用户可读写）。网页不接收或显示密钥。保存后重启开发服务。
      </p>
      <p>密钥名：POSTER_AI_KEY；模型名：POSTER_AI_MODEL。无需在聊天或 GitHub 中填写。</p>
      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
        前往 OpenAI 创建 API 密钥 ↗
      </a>
      <button @click="refreshStatus">刷新配置状态</button>
    </details>
    <p class="configuration-state" role="status">
      {{
        status
          ? status.aiConfigured
            ? `AI 已配置 · ${status.model}`
            : 'AI 尚未配置；可尝试真实关键词搜索'
          : '本地素材服务未连接'
      }}
    </p>
    <label>
      真实素材入口
      <select
        v-model="providerSource"
        aria-label="真实素材入口"
        :disabled="loading || !!importing"
        @change="clearResults"
      >
        <option value="commons">Wikimedia 官方直连</option>
        <option value="openverse">Openverse（可能受访问限制）</option>
      </select>
    </label>
    <div class="search-modes">
      <button
        :class="{ active: mode === 'ai' }"
        :disabled="loading || !!importing"
        @click="
          mode = 'ai';
          clearResults();
        "
      >
        自然语言 + AI
      </button>
      <button
        :class="{ active: mode === 'keywords' }"
        :disabled="loading || !!importing"
        @click="
          mode = 'keywords';
          clearResults();
        "
      >
        关键词直接搜索
      </button>
    </div>
    <template v-if="mode === 'ai'">
      <label>
        描述你需要的素材
        <textarea
          v-model="prompt"
          aria-label="AI 素材需求"
          maxlength="1500"
          :disabled="loading || !!importing"
          placeholder="例如：日式复古海报用的樱花装饰，奶油粉色，不要人物"
        ></textarea>
      </label>
      <p v-if="!status?.aiConfigured" class="status-note">
        尚未配置 AI 密钥，不能进行自然语言、三语关键词或图片分析。先配置，或切换到不调用 AI
        的关键词搜索。
      </p>
      <p v-else-if="!status.visualEnabled" class="status-note">
        服务端图片分析被关闭，无法完成 AI 筛选。请开启 POSTER_AI_VISUAL 后重启服务。
      </p>
    </template>
    <template v-else>
      <label>
        检索关键词
        <input
          v-model="keyword"
          aria-label="素材检索关键词"
          maxlength="300"
          :disabled="loading || !!importing"
          placeholder="例如 flower illustration"
          @keyup.enter="search()"
        />
      </label>
      <label class="check-line">
        <input v-model="transparent" type="checkbox" :disabled="loading || !!importing" />
        只要真实透明 PNG
      </label>
      <p class="status-note">
        直接请求所选真实索引，不调用 AI，不生成三语词或声称完成视觉筛选。建议先用英文短词。
      </p>
    </template>
    <button
      class="search-primary"
      :disabled="
        loading ||
        !!importing ||
        !status ||
        (mode === 'ai' && (!status.aiConfigured || !status.visualEnabled))
      "
      @click="search()"
    >
      {{
        loading
          ? '正在检索…'
          : mode === 'ai'
          ? '分析并检索（调用 AI）'
          : '搜索真实素材（不调用 AI）'
      }}
    </button>
    <button v-if="loading" class="cancel-search" @click="cancel">取消等待</button>
    <p v-if="loading" class="search-progress" role="status">{{ progress }}</p>
    <p v-if="error" class="search-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="search-notice" role="status">{{ notice }}</p>
    <section v-if="plan" class="requirements" aria-label="需求分析结果">
      <h3>需求分析</h3>
      <dl>
        <dt>风格</dt>
        <dd>{{ plan.styles.join('、') || '不限' }}</dd>
        <dt>颜色</dt>
        <dd>{{ plan.colors.join('、') || '不限' }}</dd>
        <dt>类型</dt>
        <dd>{{ plan.types.join('、') || '不限' }}</dd>
        <dt>排除</dt>
        <dd>{{ plan.exclude.join('、') || '无' }}</dd>
        <dt>透明</dt>
        <dd>{{ plan.transparent ? '必须含真实透明像素' : '不限' }}</dd>
      </dl>
      <h3>中 / 英 / 日关键词</h3>
      <p v-for="language in languages" :key="language">
        <b>{{ languageLabels[language] }}</b>
        {{ plan.keywords[language].join(' · ') }}
      </p>
    </section>
    <section v-if="response && mode === 'ai'" class="refinements">
      <h3>继续调整（会再次调用 AI）</h3>
      <div class="quick-adjust">
        <button
          v-for="item in ['更复古', '不要人物', '只要透明素材']"
          :key="item"
          :disabled="loading || !!importing"
          @click="search(item)"
        >
          {{ item }}
        </button>
      </div>
      <label>
        补充要求
        <input
          v-model="refinement"
          aria-label="补充素材要求"
          maxlength="300"
          :disabled="loading || !!importing"
          placeholder="保留原需求，补充新的偏好"
          @keyup.enter="refinement.trim() && search(refinement.trim())"
        />
      </label>
      <button
        :disabled="!refinement.trim() || loading || !!importing"
        @click="search(refinement.trim())"
      >
        调整结果
      </button>
      <p v-if="refinements.length">已追加：{{ refinements.join(' → ') }}</p>
    </section>
    <template v-if="response">
      <p class="status-note">实际入口：{{ response.provider }} · 检索词：{{ response.query }}</p>
      <div class="source-warnings">
        <p v-for="warning in response.warnings" :key="warning">{{ warning }}</p>
        <p>
          {{ response.provider }} 返回的 Wikimedia 图片；仅展示 CC0、PDM、BY、BY-SA。Openverse
          若被拒绝，请选择 Wikimedia 官方直连，结果不会冒充 Openverse。
        </p>
      </div>
      <label v-if="response.candidates.length" class="check-line license-accept">
        <input v-model="licenseAccepted" type="checkbox" aria-label="确认素材授权" />
        我已核对来源授权，并会保留必要署名和遵守改编条件。
      </label>
      <article
        v-for="candidate in response.candidates"
        :key="candidate.token"
        class="search-result"
        :data-result-id="candidate.id"
      >
        <div class="preview checker">
          <img
            v-if="!failedPreviews.includes(candidate.token)"
            :src="candidate.previewUrl"
            :alt="candidate.title"
            @error="failedPreviews.push(candidate.token)"
          />
          <span v-else>预览加载失败，请查看来源</span>
        </div>
        <h3>{{ candidate.title }}</h3>
        <p class="creator">{{ candidate.creator }}</p>
        <div class="result-tags">
          <span>{{ candidate.license }} {{ candidate.licenseVersion }}</span>
          <span>{{ candidate.visual === 'analyzed' ? 'AI 已分析图片' : '未进行图片分析' }}</span>
          <span v-if="candidate.transparency === 'verified'">已验证透明</span>
        </div>
        <p class="recommendation">{{ candidate.reason }}</p>
        <div class="source-links">
          <a :href="candidate.sourceUrl" target="_blank" rel="noopener noreferrer">来源页面 ↗</a>
          <a :href="candidate.licenseUrl" target="_blank" rel="noopener noreferrer">授权条款 ↗</a>
        </div>
        <details>
          <summary>署名信息</summary>
          <p>{{ candidate.attribution }}</p>
        </details>
        <button
          :disabled="!licenseAccepted || !!importing || editorBusy"
          @click="importCandidate(candidate)"
        >
          {{ importing === candidate.token ? '正在导入…' : '加入共享素材库' }}
        </button>
      </article>
      <p v-if="response.hasMore" class="status-note">
        还有其他索引结果。当前先展示一批候选；可缩短关键词或继续调整需求重新检索。
      </p>
    </template>
  </div>
</template>

<style scoped>
.material-search-panel {
  font-size: 11px;
  color: #375e4d;
  padding-bottom: 24px;
}
.search-intro {
  padding: 24px 0 12px;
}
.search-intro h2 {
  font-size: 19px;
  margin: 12px 0 8px;
}
.search-intro p,
.status-note,
.source-warnings,
.creator {
  font-size: 10px;
  line-height: 1.8;
  color: #7b8179;
}
.provider-badge {
  background: #eaf0e3;
  border-radius: 4px;
  padding: 4px 7px;
  font-size: 9px;
}
button,
input,
textarea,
select {
  font: inherit;
  box-sizing: border-box;
}
button {
  cursor: pointer;
  border: 1px solid #d8dfcf;
  border-radius: 5px;
  background: #fffef9;
  color: #375e4d;
  padding: 7px 9px;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
input,
textarea,
select {
  width: 100%;
  border: 1px solid #dedfd5;
  border-radius: 5px;
  padding: 9px;
  background: #fff;
  color: #283c32;
  display: block;
  margin-top: 7px;
}
textarea {
  min-height: 104px;
  resize: vertical;
  line-height: 1.7;
}
.search-modes {
  display: flex;
  gap: 6px;
  margin: 16px 0;
}
.search-modes button {
  flex: 1;
  font-size: 10px;
  padding: 8px 3px;
}
.search-modes .active {
  background: #eaf0e3;
  border-color: #375e4d;
}
.configuration {
  background: #f1f3e8;
  padding: 11px;
  border-radius: 6px;
  font-size: 10px;
  line-height: 1.8;
}
.configuration summary {
  cursor: pointer;
  font-weight: 600;
}
.configuration code {
  overflow-wrap: anywhere;
  font-size: 10px;
}
.configuration a {
  display: block;
  margin-bottom: 8px;
}
.configuration button {
  width: 100%;
}
.configuration-state {
  font-size: 9px;
  line-height: 1.7;
  color: #7b8179;
}
.check-line {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  line-height: 1.8;
  margin: 13px 0;
}
.check-line input {
  display: inline;
  width: 13px;
  height: 13px;
  margin: 3px 0;
  flex-shrink: 0;
}
.search-primary {
  width: 100%;
  background: #375e4d;
  color: #fff;
  margin-top: 9px;
}
.cancel-search {
  width: 100%;
  margin-top: 7px;
}
.search-progress,
.search-notice {
  background: #edf2e4;
  padding: 10px;
  border-radius: 5px;
  line-height: 1.8;
  font-size: 10px;
}
.search-error {
  background: #fff0df;
  color: #9b3e2d;
  padding: 10px;
  border-radius: 5px;
  line-height: 1.8;
  font-size: 10px;
}
.requirements {
  padding: 12px;
  background: #f4f5ed;
  border-radius: 6px;
  margin-top: 16px;
}
.requirements h3,
.refinements h3 {
  font-size: 11px;
  margin: 0 0 9px;
}
.requirements dl {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 6px;
  margin: 0 0 14px;
}
.requirements dt {
  color: #87917a;
}
.requirements dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.requirements p {
  font-size: 10px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.requirements p b {
  display: inline-block;
  width: 20px;
}
.refinements {
  padding: 16px 0;
  border-bottom: 1px solid #e6e6dc;
}
.quick-adjust {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}
.quick-adjust button {
  font-size: 10px;
  padding: 5px;
}
.refinements > button {
  width: 100%;
  margin-top: 7px;
}
.source-warnings {
  margin: 14px 0;
}
.license-accept {
  padding: 9px;
  background: #f4f1e4;
  font-size: 10px;
}
.search-result {
  border: 1px solid #e1e5d7;
  padding: 10px;
  border-radius: 8px;
  margin-top: 14px;
  background: #fffefb;
}
.preview {
  height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 5px;
  background-color: #f3f3ee;
}
.preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.preview span {
  color: #9b3e2d;
  font-size: 10px;
}
.checker {
  background-image: linear-gradient(45deg, #e9e9e2 25%, transparent 25%),
    linear-gradient(-45deg, #e9e9e2 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e9e9e2 75%),
    linear-gradient(-45deg, transparent 75%, #e9e9e2 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}
.search-result h3 {
  font-size: 12px;
  line-height: 1.7;
  margin: 10px 0 4px;
  overflow-wrap: anywhere;
}
.creator {
  margin: 0 0 9px;
}
.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.result-tags span {
  font-size: 8px;
  background: #edf2e6;
  border-radius: 3px;
  padding: 3px 5px;
}
.recommendation {
  font-size: 10px;
  line-height: 1.8;
  color: #697a5d;
}
.source-links {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
}
.search-result details {
  margin-top: 10px;
  font-size: 9px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.search-result details summary {
  cursor: pointer;
}
.search-result > button {
  width: 100%;
  margin-top: 11px;
}
.search-result p {
  overflow-wrap: anywhere;
}
</style>
