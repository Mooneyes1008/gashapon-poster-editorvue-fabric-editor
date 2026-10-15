import type { Asset } from './project';
export interface MaterialPlan {
  styles: string[];
  colors: string[];
  types: string[];
  exclude: string[];
  transparent: boolean;
  keywords: Record<'zh' | 'en' | 'ja', string[]>;
}
export interface MaterialCandidate {
  token: string;
  id: string;
  title: string;
  creator: string;
  source: string;
  previewUrl: string;
  sourceUrl: string;
  license: string;
  licenseVersion: string;
  licenseUrl: string;
  attribution: string;
  width: number;
  height: number;
  reason: string;
  score?: number;
  visual: 'analyzed' | 'not-analyzed';
  transparency: 'verified' | 'unchecked';
}
export interface SearchResponse {
  provider: 'Openverse' | 'Wikimedia Commons';
  query: string;
  mode: 'ai' | 'keywords';
  plan: MaterialPlan | null;
  candidates: MaterialCandidate[];
  warnings: string[];
  hasMore: boolean;
}
export interface MaterialStatus {
  provider: string;
  aiConfigured: boolean;
  model: string;
  visualEnabled: boolean;
  configurationCommand: string;
  cost: string;
}
export interface ImportedMaterial {
  name: string;
  data: string;
  provenance: NonNullable<Asset['provenance']>;
}
export interface MaterialSearchProvider {
  analyze(
    prompt: string,
    refinements: string[],
    signal?: AbortSignal
  ): Promise<{ plan: MaterialPlan }>;
  search(
    input:
      | { mode: 'ai'; plan: MaterialPlan; source: 'commons' | 'openverse' }
      | { mode: 'keywords'; query: string; transparent: boolean; source: 'commons' | 'openverse' },
    signal?: AbortSignal
  ): Promise<SearchResponse>;
  import(token: string, acceptLicense: boolean): Promise<ImportedMaterial>;
}
export async function materialApi<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/material-search/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('本次请求已取消。');
    throw new Error('本地素材服务无法连接，请停止旧服务后重新运行 pnpm dev。');
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('素材服务未返回有效数据，请检查服务是否已启动。');
  }
  if (!response.ok)
    throw new Error(typeof data.message === 'string' ? data.message : '素材请求失败，请重试。');
  return data as T;
}
export const materialSearchProvider: MaterialSearchProvider = {
  analyze: (prompt, refinements, signal) => materialApi('analyze', { prompt, refinements }, signal),
  search: (input, signal) => materialApi('search', input, signal),
  import: (token, acceptLicense) => materialApi('import', { token, acceptLicense }),
};
