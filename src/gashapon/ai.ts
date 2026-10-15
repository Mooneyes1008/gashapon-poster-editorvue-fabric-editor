/** Future adapter boundary: no fabricated search results or credentials in the client. */
export interface MaterialRequest {
  prompt: string;
  languages: ('zh' | 'en' | 'ja')[];
}
export interface MaterialCandidate {
  id: string;
  previewUrl: string;
  sourceUrl: string;
  title: string;
  license: string;
  attribution: string;
  width: number;
  height: number;
}
export interface MaterialSearchProvider {
  expandKeywords(request: MaterialRequest): Promise<Record<'zh' | 'en' | 'ja', string[]>>;
  search(keywords: string[], signal?: AbortSignal): Promise<MaterialCandidate[]>;
  rankVisually(
    request: MaterialRequest,
    candidates: MaterialCandidate[]
  ): Promise<MaterialCandidate[]>;
}
export const materialSearchProvider: MaterialSearchProvider | null = null;
