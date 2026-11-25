# geo-audit

**检查一个网站准备好被 AI 搜索引擎引用了吗。**

一条命令，五项检测，输出一份带证据的体检报告：`llms.txt`、AI 爬虫准入、sitemap、结构化数据、页面元信息。

```bash
npx geo-audit example.com
```

零依赖，Node 20+。

---

## 为什么需要它

AI 搜索（ChatGPT、Perplexity、豆包、Kimi…）回答问题时，会去抓取网页。网站如果没为这一步做准备，就进不了 AI 的答案——而这件事在传统 SEO 工具里看不到。

这个工具检查的就是那五件具体的事。

## 输出长什么样

```
  https://medradar.cn
  AI-search readiness

  ✗ llms.txt                   no /llms.txt served
  ✓ AI crawler access          no robots.txt; all 12 AI crawlers allowed by default
  ✗ Sitemap                    HTTP 404
  ✗ JSON-LD structured data    no application/ld+json on the home page
  ✗ Head metadata              1/3 present · no description · no canonical

  Score     30/100  (D)
  Coverage  100% of checks could be judged
  1 present · 4 absent · 0 unknown
```

## 三条设计原则

### 1. 三态，不是布尔

每一项检查只返回三种结果之一：

| 状态 | 含义 |
| --- | --- |
| `present` | 直接观测到了（文件抓到了） |
| `absent` | 直接观测到它确实不在（明确 404） |
| `unknown` | **没查成**（网络错误、超时、5xx） |

`unknown` **绝不并入** `absent`。打不开的网站不等于没有 `llms.txt`，把两者混为一谈的报告，拿到手的人没法用。

### 2. 不信任 HTTP 200

很多单页应用（SPA）对任何路径都返回同一份 HTML 外壳，状态码还是 200。如果只看状态码，任何 SPA 的 `/llms.txt` 都会显示「已配置」。

所以内容还要过一道检查：是不是 HTML 文档。是的话如实写「返回的是 HTML 页面（catch-all 路由），不是文本文件」。

这个坑是实测踩出来的——`geohub.tech/llms.txt` 返回 200、1337 字节，内容是 React 应用的 `<!DOCTYPE html>`。

### 3. 分数只算能判定的项

`Score` 的分母是**能判定**的检查项，不是全部五项。同时单独报告 `Coverage`（能判定几项）。

这样一个只查通了两项的站，不会因为「分数 100」被误读成体检合格。

## 安装

```bash
# 直接跑，不安装
npx geo-audit example.com

# 或者全局装
npm i -g geo-audit
geo-audit example.com
```

## 用法

```
geo-audit <域名|URL> [--json] [--ua <字符串>] [--timeout <毫秒>]

  --json            输出完整 JSON 报告
  --ua <字符串>     自定义 User-Agent
  --timeout <毫秒>  单次请求超时（默认 15000）
  -h, --help        帮助
```

```bash
geo-audit medradar.cn
geo-audit https://geohub.tech --json
geo-audit example.com --timeout 8000
```

**退出码**：`0` 体检完成（无论多少分）；`1` 参数错误或站点完全打不开。

## 五项检查

| 检查 | 权重 | 看什么 |
| --- | --- | --- |
| `llms.txt` | 20 | `/llms.txt` 是否存在且是文本文件 |
| AI 爬虫准入 | 30 | `robots.txt` 是否封禁了 12 个 AI 爬虫 |
| Sitemap | 20 | `robots.txt` 声明的或默认的 sitemap，含多少条 URL |
| 结构化数据 | 15 | 首页有多少 `application/ld+json`、用到哪些 `@type` |
| 元信息 | 15 | `<title>` / description / canonical 齐不齐 |

被跟踪的 12 个爬虫：`GPTBot`、`OAI-SearchBot`、`ChatGPT-User`、`ClaudeBot`、`Claude-User`、`PerplexityBot`、`Perplexity-User`、`Google-Extended`、`Applebot-Extended`、`meta-externalagent`、`Bytespider`、`Baiduspider`。

## 已知边界

- **robots.txt 只看根路径**。判断的是「这个爬虫能不能读首页」，不是完整的 robots 匹配。够用，但不是规范实现。
- **只查首页和站点级文件**，不爬全站，也不执行 JavaScript。SPA 的真实内容它看不到。
- **不做 AI 答案实测**。这个工具查的是「准备度」，不是「你有没有被引用」——后者要真的去问各个 AI 模型。

## 开发

```bash
git clone https://github.com/lyh905/geo-audit
cd geo-audit
node --test        # 11 项测试
node src/cli.mjs deepseek.com
```

## License

MIT
