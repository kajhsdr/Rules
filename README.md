# Rules

个人自用的代理规则集（Clash / mihomo）与 Quantumult X 脚本。

| 目录 | 内容 |
|---|---|
| `mihomo/` `rules/` | 番茄小说去广告规则 |
| `quantumultx/` | Quantumult X 脚本 |

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

## jd-wskey-capture

自动提取京东 App 所有已登录账号的 `wskey` 与 `pt_pin`，写入青龙面板的
`JD_WSCK` 环境变量。Quantumult X 专用。

### 文件

| 文件 | 用途 |
|---|---|
| `quantumultx/jd-wskey-capture.conf` | Quantumult X 重写配置 |
| `quantumultx/scripts/jd-wskey-capture.js` | 抓取脚本 |

### 抓取原理

京东 App 启动时会请求 `POST https://sso.jd.com/appJdst/update`，响应体一次性返回
**当前所有已登录账号**：

```json
{"result":[
  {"pin":"jd_abc123def456","sessionTicket":"AAJxxxxxxxxxxxx...","jdst":"...","jdgsToken":"..."},
  {"pin":"jd_xyz789uvw012","sessionTicket":"AAJyyyyyyyyyyyy...","jdst":"...","jdgsToken":"..."}
],"code":1,"success":true}
```

`sessionTicket` 就是 `wskey` —— 与 App 实际带到 `im-x.jd.com` 请求 Cookie 里的
`wskey` 逐字节相同（已实测比对）。pin 与 wskey 同源，直接配对，不需要猜。

脚本挂四个位置：

| 位置 | 挂钩 | 作用 |
|---|---|---|
| `sso.jd.com/appJdst/update` | 响应 | 主路径，一次拿全部账号的 `pin` + `sessionTicket`(=wskey) |
| `sh.jd.com/d` | 请求 Cookie | 补充路径，Cookie 里直接带 `wskey` |
| `api.m.jd.com` / `sso.jd.com` | 请求 Cookie | **只**缓存 `pt_pin` ↔ `pin_hash` 映射，给上一条反查账号用 |
| `im-x.jd.com` | 请求 Cookie | 兜底，按时间窗口配对 `wskey` 与 `pt_pin` |

`sh.jd.com/d` 的 Cookie 通常只有 `wskey` 和 `pin_hash`，没有 `pt_pin`，
所以要靠 `api.m.jd.com` 攒下的映射反查是哪个账号。

### 实测数据（383 条请求的抓包）

| 值 | 出现次数 | 位置 |
|---|---|---|
| `pt_key` | 138 | 几乎所有请求 |
| `pt_pin` | 138 | 几乎所有请求 |
| `wskey` | **1** | 仅 `im-x.jd.com` 广告请求 |
| `sessionTicket` | 2 个账号 | `sso.jd.com/appJdst/update` 响应 |

京东 App 的请求 Cookie 里几乎不带 `wskey`，所以主路径是 SSO 接口。
`wskey` 与 `pt_pin` 也从不出现在同一条 Cookie 里，兜底路径需要按时间窗口配对。

> `sh.jd.com/d` 这条来自社区实现 [jdzjy/Surge](https://github.com/jdzjy/Surge)，
> 本仓库尚未实抓验证。接入后第一次触发要看 QX 日志确认 Cookie 里真的带 `wskey`。

### 安装

1. 重写 → 引用 → 添加：

```
https://raw.githubusercontent.com/kajhsdr/Rules/main/quantumultx/jd-wskey-capture.conf
```

2. 青龙配置已内置，直接下一步
3. 打开 MITM、信任证书（iOS「关于本机 → 证书信任设置」）
4. 打开京东 App

### 青龙配置

已内置在脚本里，开箱即用：

| 项 | 值 |
|---|---|
| 青龙地址 | `http://192.168.1.2:5700` |
| 鉴权方式 | `openapi` |
| client_id | `h6p4roq-Ba3N` |
| 环境变量名 | `JD_WSCK` |

要换青龙、或改用用户名密码鉴权，两种方式（后者优先）：

1. 改脚本顶部的 `CONFIG`
2. 写进持久化存储，key = `jd_wskey_config`，value 为 JSON：

   ```json
   {"ql_host":"https://ql.example.com","ql_auth":"password","ql_id":"用户名","ql_secret":"密码","env_name":"JD_WSCK"}
   ```

> ⚠️ 青龙地址与 client_secret 写在本仓库里是公开的。`192.168.1.2` 是内网地址，
> 外网连不上，所以暂时没有实际风险；**如果哪天青龙暴露到公网，务必先换掉这个
> client_secret**。

手机需要和 `192.168.1.2` 在同一局域网。同时确认 QX 的「绕过」设置包含内网段，
否则访问青龙的请求会被代理绕走。

### 排除指定账号

不想让某个账号写进青龙，把它加到排除列表：

改脚本 `CONFIG.exclude_pins`，或写在 `jd_wskey_config` 的 `exclude_pins` 字段。

写法：多个用逗号、中文逗号、空格或换行分隔都行，也支持数组。pin 写编码形式
（`%E5%BC%A0%E4%B8%89`）或解码形式都能匹配。

行为：

- 被排除的账号不会被写进青龙，也不会被更新
- **已经在青龙里的变量不会被自动删除** —— 要清掉得手动删
- 通知里会显示跳过了几个：`新增 2: jd_a, jd_c | 跳过 1: jd_b`
- 全部被排除时不会去请求青龙，直接发通知

### 工作流程

1. 打开京东 App（重新登录或切换账号后同样有效），或进「我的 → 消息」
2. 打开 App 走 SSO 接口，一次拿到全部账号；「我的 → 消息」走 `sh.jd.com/d`，
   补抓单个账号的最新 `wskey`。两个来源都会写 `JD_WSCK`
3. 变量值为 `pin=xxx;wskey=yyy;`，备注为 `JD_Wskey <pin>`
4. 青龙里已有该 `pt_pin` → 更新；没有 → 新增；值没变 → 不写青龙；在排除列表里 → 跳过
5. 每次抓取都会弹 QX 通知，内容形如 `新增 2: jd_a, jd_b` 或 `无变化 2`

写入后青龙环境变量列表长这样：

| 名称 | 值 | 备注 |
|---|---|---|
| `JD_WSCK` | `pin=jd_abc123def456;wskey=AAJxxxxxxxxxxxx...;` | `JD_Wskey jd_abc123def456` |
| `JD_WSCK` | `pin=jd_xyz789uvw012;wskey=AAJyyyyyyyyyyyy...;` | `JD_Wskey jd_xyz789uvw012` |

旧的 `pt_pin=xxx;wskey=yyy;` 写法也能被识别（不会写成重复变量），
下次上传时自动改成 `pin=` 格式。

### 多账号

一次 SSO 调用拿到全部账号，无需逐个登录。

### 注意

- MITM 范围为 `*.jd.com`、`*.jd.hk`，会解密全部京东流量。
- 全部走 `raw.githubusercontent.com`，推送后立即生效，没有 CDN 缓存延迟。
  如果你的网络打不开 raw，把地址换成 jsDelivr：
  `https://cdn.jsdelivr.net/gh/kajhsdr/Rules@main/<文件路径>`（有缓存，最长需等一会儿）。
- `wskey` 是长期凭证，等价于账号密码。**抓包文件（.har）不要提交到公开仓库**，
  本仓库已通过 `.gitignore` 屏蔽 `*.har`。
