# 行程规划器 · Travel Planner

在地图上标出想去的地方，自动分天、排顺序、算通勤，生成一份能直接照着走的行程表。

面向国内城市游：搜索地点 → 标到地图 → 点「规划」→ 得到逐日时间轴（每段有地铁/公交线路、换乘、耗时、票价），
可以导出 Markdown 或 XMind，也能把整份行程存成多个「旅行」来回切换。

## 它能做什么

- **地点搜索与地图标注**：按关键词或门牌号搜，标到地图上；点标记看详情。
- **按天自动规划**：按地理位置分天、排顺序，算出每段的到达/离开时刻。
- **真实公交路线**：接入腾讯位置服务，给出地铁几号线、在哪换乘、多少站、多少钱。
- **AI 决定「怎么排」**：DeepSeek 负责哪天去、先后顺序、每个点待多久、为什么这么排；本地负责算可行时刻。
- **硬约束**：每天起止时间、节奏、午晚餐时间、营业时间、最晚到达、停留时长、必去优先级、跨城不排日程。
- **地点资料**：营业时间 / 评分 / 人均 / 电话 / 照片来自高德，取不到的再由 AI 估。
- **导出**：Markdown 和 XMind，每个地点带资料和 AI 写的游玩建议。
- **热门路线参考**：「AI规划」生成 3 条经典路线供审阅，可选其一加入当前规划继续改。

## 快速开始

### 方式一：只用单文件（不需要 Node）

```bash
node build-standalone.js      # 生成 travel-planner.html
```

双击 `travel-planner.html` 即可用。路线走腾讯的 JSONP 接口，不需要本地服务。

### 方式二：本地服务（推荐，支持更多接口）

```bash
npm install          # 没有第三方依赖，这步可跳过
npm start            # 默认 http://127.0.0.1:8787
```

```bash
node server.js --port 8787 --key <腾讯 Key>   # 指定端口和 Key
```

## 配置 Key

代码里**不含任何密钥**。复制一份本地配置，填上自己的 Key：

```bash
cp public/js/config.js public/js/config.local.js   # 然后编辑 config.local.js
```

```js
window.APP_CONFIG = {
  tmapKey: '',        // 腾讯位置服务 WebService API Key（路线、搜索）
  deepseekKey: '',    // DeepSeek API Key（分天、攻略、路线）
  amapKey: '',        // 高德 Web端(JS API) Key（营业时间/评分/人均/照片）
  amapSecurity: '',   // 高德安全密钥
};
```

`config.local.js` 和根目录的 `key.txt` 都已在 `.gitignore` 里，不会上传。

**申请地址**

- 腾讯位置服务：<https://lbs.qq.com/dev/console/application/mine>（产品类型选「WebServiceAPI」）
- DeepSeek：<https://platform.deepseek.com/>
- 高德开放平台：<https://console.amap.com/dev/key/app>（服务平台选「Web端(JS API)」，会同时给一个安全密钥）

三把 Key 都是可选的，缺哪把就少一块能力，不会崩：

| 缺什么 | 影响 |
| --- | --- |
| 腾讯 Key | 路线变成几何估算（直线距离 × 系数），没有线路名 |
| DeepSeek Key | 不调 AI，改用按地理位置聚类分天；没有攻略和热门路线 |
| 高德 Key | 没有营业时间/评分/人均/照片；营业时间约束失效 |

也可以直接在页面右上角「数据源」里填腾讯 Key，存在浏览器本地。

## 它是怎么工作的

```
地点列表 ──► AI 分天（哪天去 / 顺序 / 停留 / 理由）
              │
              ▼
        本地排程（按顺序算到达离开时刻、通勤、饭点、营业时间、超时）
              │
              ▼
        逐日时间轴（缺真实路线就分轮补齐，边补边微调）
```

分工的边界很清楚：

- **AI 只做决策，不产时刻表**。让模型直接输出「09:41 到故宫」它给不出可执行的分钟数，硬答就是编的。
- **本地排程保证可行**：按 `place.day / seq / minutes` 落位，再做超时裁剪、跨天搬点、餐饮均衡、营业时间校正。
- **DeepSeek 的对话接口不联网**，它靠自己掌握的公开知识判断（故宫周一闭馆这类没问题，新开的店不知道）。
  AI 写出的内容在界面上都标了 `AI`，可以手改；改过之后不会再被覆盖。

## 数据来源

| 用途 | 来源 |
| --- | --- |
| 底图 | 高德地图瓦片 |
| 地点搜索、公交换乘 | 腾讯位置服务 |
| 营业时间、评分、人均、照片 | 高德 PlaceSearch |
| 分天、攻略、热门路线 | DeepSeek |
| 天气 | Open-Meteo |

## 目录结构

```
server.js               本地服务：静态文件 + 腾讯接口代理 + 限流
build-standalone.js     打包成单文件 HTML
public/
  index.html
  css/  style.css home.css
  js/   config.js      配置占位（真实 Key 放 config.local.js）
        app.js         主逻辑：状态、渲染、事件、导出
        home.js        首页看板
        planner.js     排程引擎（分天、排序、时刻、约束）
        ai.js          DeepSeek：分天、资料、攻略、路线
        amap.js        高德 POI 资料补全
        mind.js        XMind 生成
        tmap-*.js      腾讯接口的响应解析与 JSONP 客户端
        util.js        工具函数
docs/DEVELOPMENT.md     开发笔记（踩过的坑、设计取舍）
_constraints-test.js    排程约束回归测试
```

## 开发

```bash
node _constraints-test.js    # 24 项排程约束回归，改动 planner 后跑一遍
node build-standalone.js     # 重新打包单文件
```

## 已知边界

- 只做国内城市游；**跨城行程不排逐日日程**（城际交通没有数据源，硬排就是假的），只按城市整理地点清单。
- 营业时间靠解析文本（取最早开门到最晚关门），像「11:00-14:30,16:30-21:00」这种中途休息的，午休时段不额外拦。
- AI 生成的营业时间/人均是**参考值**，不是官方数据，出门前自己核一下。
- 高德 POI 按名称 + 距离匹配，同名连锁店可能匹配到邻近的另一家。
- 单文件版里腾讯走 JSONP、高德走 JS SDK、DeepSeek 直连 CORS，都不需要本地服务；
  但如果浏览器或网络策略拦截了第三方请求，就只能退回服务端模式。

## License

MIT
