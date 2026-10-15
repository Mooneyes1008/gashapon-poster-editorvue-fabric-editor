const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const destination = path.resolve(__dirname, '../server/.env.local');
async function main() {
  if (!process.stdin.isTTY)
    throw new Error('请在你自己的交互式终端运行此命令，不要把密钥写入命令行参数。');
  console.log(
    'OpenAI API 按实际用量计费。密钥只写入本机 server/.env.local（不提交 Git），不会发送到编辑器前端。'
  );
  console.log('配置文件已存在时，本次配置将替换它；已有环境变量优先于此文件。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const model =
    (
      await new Promise((resolve) => rl.question('模型名称（回车使用 gpt-4.1-mini）：', resolve))
    ).trim() || 'gpt-4.1-mini';
  rl.close();
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new Error('模型名称格式无效。');
  process.stdout.write('输入 OpenAI API 密钥（输入不回显，回车保存；空输入取消）：');
  const key = await new Promise((resolve) => {
    let text = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          process.stdin.setRawMode(false);
          process.exit(1);
        }
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          return resolve(text);
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ' && text.length < 4096) text += ch;
      }
    }
    process.stdin.on('data', onData);
  });
  if (!key) {
    console.log('已取消，未更改原配置。');
    return;
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink())
    throw new Error('拒绝写入符号链接配置文件。');
  const temporary = destination + '.tmp-' + require('node:crypto').randomUUID();
  try {
    fs.writeFileSync(
      temporary,
      `POSTER_AI_KEY=${JSON.stringify(key)}\nPOSTER_AI_MODEL=${JSON.stringify(
        model
      )}\nPOSTER_AI_VISUAL=true\n`,
      { mode: 0o600, flag: 'wx' }
    );
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log('已安全保存。请停止并重新运行 pnpm dev，让服务端读取配置。密钥未进行联网验证。');
}
main().catch(() => {
  console.error('配置未完成，请检查终端和配置文件权限；勿在聊天中发送密钥。');
  process.exitCode = 1;
});
