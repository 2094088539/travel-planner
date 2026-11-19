/**
 * 运行时配置（会提交到仓库，请留空）
 *
 * 真实的 Key 写在同一目录的 config.local.js（已在 .gitignore 里，不会上传）。
 * config.local.js 覆盖这里的默认值。
 */
window.APP_CONFIG = Object.assign({
  /* 腾讯位置服务 WebService API Key —— 路线规划 / 地点搜索 */
  tmapKey: '',
  /* DeepSeek API Key —— 分天排序、攻略、热门路线 */
  deepseekKey: '',
  /* 高德 Web端(JS API) Key + 安全密钥 —— 补营业时间/评分/人均/照片 */
  amapKey: '',
  amapSecurity: '',
}, window.APP_CONFIG || {});
