import { expect, test } from 'vitest';
import { allowDevelopmentRequest } from '../../../../config/localDevGuard';
test('local assets and same-origin HMR work', () => {
  expect(allowDevelopmentRequest('/src/main.ts', 'localhost:3000', 'http://localhost:3000')).toBe(
    true
  );
  expect(allowDevelopmentRequest('/node_modules/.vite/deps/fabric.js', '127.0.0.1:3000')).toBe(
    true
  );
});
test.each([
  ['/src/main.ts', 'attacker.example', undefined],
  ['/', 'localhost:3000', 'https://attacker.example'],
  ['/.env?raw', 'localhost:3000', undefined],
  ['//.env.production?raw', 'localhost:3000', undefined],
  ['/%252eenv?raw', 'localhost:3000', undefined],
  ['/@fs/etc/passwd?raw', 'localhost:3000', undefined],
  ['//%40fs/etc/passwd', 'localhost:3000', undefined],
  ['/src/../.env', 'localhost:3000', undefined],
  ['/%00.env', 'localhost:3000', undefined],
  ['/.git/config', 'localhost:3000', undefined],
])('rejects cross-site and sensitive paths: %s', (url, host, origin) => {
  expect(allowDevelopmentRequest(url, host, origin)).toBe(false);
});
