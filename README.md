# Rules

个人自用的代理规则集（Clash / mihomo）。

## fanqie-adblock

番茄小说（`com.dragon.read`）去广告规则。

**规则来源**：从官方 APK `v7.3.5.32`（versionCode 73532）逆向提取的 659 个真实网络域名，
按「使用该域名的类」与 URL 路径上下文分类，逐条验证存在性、实际可达性与零误拦。

### 文件

| 文件 | 格式 | 用途 |
|---|---|---|
| `mihomo/fanqie-adblock.mrs` | mrs (domain) | mihomo 首选，体积最小 |
| `mihomo/fanqie-adblock.txt` | 纯文本域名 | mihomo `format: text` 备用 |
| `mihomo/fanqie-adblock.yaml` | classical payload | 通用 YAML 客户端 |
| `rules/fanqie-adblock.yaml` | classical payload | 同上 |
| `rules/fanqie-adblock.list` | 规则行 | 直接粘进 `rules:` 段 |

### 误拦保护（重要）

以下域名**绝不能拦截**，拦了会导致白屏或无法登录。本规则集已确保不包含它们：

| 域名 | 用途 |
|---|---|
| `reading.snssdk.com` | **正文接口**（13 个 dex 引用，最高频） |
| `*.fqnovel.com` | 书籍 API（api / api3-normal-* / api5-normal-*） |
| `*.fqnovelpic.com` | 封面图 CDN |
| `*.fqnovelstatic.com` | 静态资源 |
| `*.byteimg.com` | 图片 CDN |
| `*.bytegecko.com` | 资源包 CDN |
| `*.bytednsdoc.com` | 静态资源 |
| `i.snssdk.com` | **用户中心**（`ucenter_web`）—— 拦了无法登录 |
| `api.snssdk.com` | OAuth 授权回调 |
| `security.snssdk.com` | 设备安全校验 |
| `tp-pay.snssdk.com` | 支付 |
| `mclient.alipay.com` | 支付宝 |
| `openmobile.qq.com` | 微信 / QQ 登录 |
| `zlink.fqnovel.com` | App 唤起 |
| `polaris.zijieapi.com` | 配置下发 |

### 与公共 AdBlock 列表的差异

公共 AdBlock 列表（如 `217heidai/adblockfilters`，21.5 万条）会拦截两个
本规则集特意排除的域名：

| 域名 | 公共列表条目 | 本规则集 | 影响 |
|---|---|---|---|
| `i.snssdk.com` | `+.i.snssdk.com` | 不包含 | 用户中心、钱包、免广告特权 |
| `ib.snssdk.com` | `+.ib.snssdk.com` | 不包含 | push 通道 |
| `is.snssdk.com` | `+.is.snssdk.com` | 不包含 | AB 实验 / 广告设置下发 |

名字里的 `i` / `ib` / `is` 容易被误读为广告位，实际都是业务域名：

- `i.snssdk.com` 承担 `/luckycat/novel/v1/user/*`（账号、钱包、个人资料）
  与 `/ucenter_web/`，误拦会造成账号相关功能异常。
- `is.snssdk.com` 下发 AB 实验与广告位配置，**拦截它反而对去广告有利**
  （拉不到广告配置），但可能导致部分功能开关失效。保留与否自行权衡。

推荐在 AdBlock 之前加白名单（本仓库实测生效）：

```yaml
rules:
  - "RULE-SET,Local-IP,DIRECT,no-resolve"
  - "DOMAIN-SUFFIX,i.snssdk.com,DIRECT"   # 用户中心，建议放行
  - "DOMAIN-SUFFIX,ib.snssdk.com,DIRECT"  # push，按需
  # is.snssdk.com 如需放行再取消注释
  # - "DOMAIN-SUFFIX,is.snssdk.com,DIRECT"
  - "RULE-SET,Fanqie-AdBlock,REJECT"
  - "RULE-SET,AdBlock,🚫AdBlock"
```

### 分层说明

规则按误拦风险分三层：

- **L1 日志 / 监控 / 归因**（15 条）—— 零风险，只影响数据上报
- **L2 广告投放**（7 条）—— 低风险，广告 SDK 专用（`ad.zijieapi.com`、`oceanengine.com`）
- **L3 设置下发 / push 保活** —— 默认注释，确认无副作用再启用
  （`is.snssdk.com`、`ib.snssdk.com`）

### 使用

```yaml
rule-providers:
  Fanqie-AdBlock:
    type: http
    behavior: domain
    format: mrs
    url: "https://raw.githubusercontent.com/kajhsdr/Rules/main/mihomo/fanqie-adblock.mrs"
    path: ./ruleset/fanqie-adblock.mrs
    interval: 86400

rules:
  # 放在靠前位置，避免被 GEOIP,CN,DIRECT 之类规则先匹配
  - "RULE-SET,Fanqie-AdBlock,REJECT"
```

### 效果与局限

能去掉：日志上报、广告请求、开屏广告拉取、信息流广告数据。

去不掉：

- 已缓存的广告（需清 App 缓存）
- 点击类弹窗（需配合 [GKD](https://github.com/gkd-kit/gkd) 订阅自动点击）
- 服务端强推的广告（若广告与正文混在同一接口返回，拦截会连正文一起丢）

网络层去广告本质是「少请求一些数据」，不是「删除广告位」，
所以开屏可能变成白屏或品牌图、信息流可能出现空白占位，这属正常现象。
