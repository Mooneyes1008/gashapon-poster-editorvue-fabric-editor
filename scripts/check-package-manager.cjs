const agent = process.env.npm_config_user_agent || '';
if (!/^pnpm\/8\./.test(agent)) {
  console.error('请使用 pnpm 8.4.0 安装本项目：npm install -g pnpm@8.4.0');
  process.exit(1);
}
