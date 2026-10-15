import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const configurationFile = fileURLToPath(new URL('./.env.local', import.meta.url));
export function readConfiguration(env = process.env) {
  let local = {};
  try {
    const text = readFileSync(configurationFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(POSTER_AI_KEY|POSTER_AI_MODEL|POSTER_AI_VISUAL)=(.*)$/);
      if (match)
        local[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].trim();
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('服务端配置文件无法读取，请重新运行 pnpm ai:configure。');
  }
  const value = (name) => env[name] || local[name] || '';
  return {
    aiKey: value('POSTER_AI_KEY'),
    model: value('POSTER_AI_MODEL') || 'gpt-4.1-mini',
    visual: value('POSTER_AI_VISUAL') !== 'false',
    proxy: env.HTTPS_PROXY || env.https_proxy || '',
    port: Number(env.POSTER_SERVER_PORT || 3001),
  };
}
export class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
