/*
 * 京东 App：wskey / pt_pin 捕获 → 上传青龙面板（Quantumult X）
 *
 * 主路径（响应脚本）：
 *   京东 App 启动时会请求 POST https://sso.jd.com/appJdst/update，
 *   响应体一次性返回当前所有已登录账号：
 *     {"result":[{"pin":"jd_xxx","sessionTicket":"AAJ...","jdst":"...","jdgsToken":"..."}],"code":1,"success":true}
 *   其中 sessionTicket 就是 wskey（与 App 请求 Cookie 里的 wskey 完全一致）。
 *   → pin 与 wskey 天然配对，一次拿到全部账号。
 *
 * 补充路径（请求脚本）：
 *   新版 sh.jd.com/d 的请求 Cookie 直接带 wskey，但通常没有 pt_pin，只有 pin_hash。
 *   所以另挂 api.m.jd.com / sso.jd.com，只做一件事：缓存 pt_pin ↔ pin_hash 映射，
 *   给 sh.jd.com/d 反查账号用。
 *   触发时机：打开 App，以及「我的 → 消息」。
 *
 * 兜底路径（请求脚本）：
 *   从 im-x.jd.com 请求 Cookie 里分别捕获 wskey 与 pt_pin
 *   （实测二者从不出现在同一条 Cookie 中），按捕获时间邻近配对。
 *
 * 青龙侧写入格式：变量名 JD_WSCK，值 pin=xxx;wskey=yyy;
 *
 * 配置：已内置在下方 CONFIG，开箱即用。需要覆盖就写持久化存储，
 * key = jd_wskey_config，value 为同结构 JSON，优先级高于 CONFIG。
 */

const CONFIG = {
    ql_host: 'http://192.168.1.2:5700',
    ql_auth: 'openapi',
    ql_id: 'h6p4roq-Ba3N',
    ql_secret: 'DyHOL84HVWa7HD-MFAjMqMo2',
    env_name: 'JD_WSCK',
    /* 不写进青龙的账号（pin），多个用逗号或换行分隔，留空则全部上传 */
    exclude_pins: ''
};

const CONFIG_KEY = 'jd_wskey_config';

const STORE = {
    pin: 'jd_wskey_cap_pin',
    pinTs: 'jd_wskey_cap_pin_ts',
    wskey: 'jd_wskey_cap_wskey',
    wskeyTs: 'jd_wskey_cap_wskey_ts',
    token: 'jd_wskey_ql_token',
    tokenExp: 'jd_wskey_ql_token_exp',
    traceTs: 'jd_wskey_cap_trace_ts',
    pinMap: 'jd_wskey_cap_pinmap',
    last: 'jd_wskey_cap_last'
};

/* 兜底路径：pin 与 wskey 的捕获时间差超过该值则不配对，避免多账号串号 */
const PAIR_WINDOW_MS = 30 * 60 * 1000;

const cfg = loadConfig();
const REQ_URL = (typeof $request !== 'undefined' && $request && $request.url) || '';

(async function main() {
    try {
        trace();
        if (typeof $response !== 'undefined' && $response && typeof $response.body !== 'undefined') {
            await fromSsoResponse();
        } else if (/^https?:\/\/sh\.jd\.com\/d(?:[\/?#]|$)/i.test(REQ_URL)) {
            await fromShRequest();
        } else if (/^https?:\/\/im-x\.jd\.com\//i.test(REQ_URL)) {
            await fromRequestCookie();
        } else {
            await cachePinMap();
        }
    } catch (e) {
        const msg = (e && e.message) || String(e);
        console.log('[JD-Wskey] 失败: ' + msg);
        notify('❌ 京东 Wskey 失败', msg);
    } finally {
        $done({});
    }
})();

/* ---------- 主路径：SSO 响应 ---------- */

async function fromSsoResponse() {
    const raw = $response.body || '';
    const json = parse(raw);
    if (!json || !Array.isArray(json.result)) {
        console.log('[JD-Wskey] SSO 响应无法解析，body 长度 ' + String(raw).length);
        notify('⚠️ 京东 Wskey 未解析', 'SSO 响应不是预期结构',
            'body 长度 ' + String(raw).length);
        return;
    }

    const pairs = json.result
        .filter(function (it) { return it && isValidPin(it.pin) && isValidWskey(it.sessionTicket); })
        .map(function (it) { return { pin: it.pin, wskey: it.sessionTicket }; });

    if (!pairs.length) {
        const sample = json.result[0] || {};
        console.log('[JD-Wskey] SSO 返回 ' + json.result.length + ' 条，无一条通过校验；样本 pin=' +
            (sample.pin || '(无)') + ' sessionTicket=' + mask(sample.sessionTicket));
        notify('⚠️ 京东 Wskey 未捕获', 'SSO 返回 ' + json.result.length + ' 条但无有效账号',
            'pin 或 sessionTicket 格式可能已变');
        return;
    }

    console.log('[JD-Wskey] SSO 返回 ' + pairs.length + ' 个账号: ' + describeAll(pairs));
    await sync(pairs);
    // 记下来，sh.jd.com/d 那边值没变就不必再去青龙跑一趟
    pairs.forEach(function (p) { writeLast(p.pin, p.wskey); });
}

/* ---------- 补充路径：sh.jd.com/d ---------- */

/* sh.jd.com/d 的请求 Cookie 直接带 wskey，但通常没有 pt_pin，只有 pin_hash，
   用 api.m.jd.com / sso.jd.com 攒下的映射反查账号。 */
async function fromShRequest() {
    const cookie = header($request.headers, 'cookie');
    if (!cookie) return;

    const wskey = matchCookie(cookie, 'wskey');
    if (!isValidWskey(wskey)) return;

    const hash = matchCookie(cookie, 'pin_hash');
    const pin = matchCookie(cookie, 'pt_pin') || matchCookie(cookie, 'pin') || lookupPin(hash);
    if (!isValidPin(pin)) {
        console.log('[JD-Wskey] sh.jd.com 拿到 wskey，但认不出账号' +
            (hash ? '（pin_hash=' + mask(hash) + ' 无缓存，先打开一次京东 App 首页攒映射）'
                  : '（无 pin_hash）'));
        return;
    }

    // 同一个 pin 的 wskey 没变就不去青龙白跑一趟（点消息会反复触发这条规则）
    if (readLast(pin) === wskey) return;

    console.log('[JD-Wskey] sh.jd.com 捕获 ' + decodeSafe(pin) + ' ' + mask(wskey));
    await sync([{ pin: pin, wskey: wskey }]);
    writeLast(pin, wskey);
}

/* 只为攒 pt_pin ↔ pin_hash 映射，不触发上传 */
async function cachePinMap() {
    const cookie = header($request.headers, 'cookie');
    if (!cookie) return;

    const pin = matchCookie(cookie, 'pt_pin') || matchCookie(cookie, 'pin');
    const hash = matchCookie(cookie, 'pin_hash');
    if (!isValidPin(pin) || !hash) return;

    const map = parse(read(STORE.pinMap)) || {};
    if (map[hash] === pin) return;

    map[hash] = pin;
    const keys = Object.keys(map);
    if (keys.length > 50) delete map[keys[0]];
    write(STORE.pinMap, JSON.stringify(map));
    console.log('[JD-Wskey] 缓存 pin_hash → ' + decodeSafe(pin));
}

function lookupPin(hash) {
    if (!hash) return '';
    const map = parse(read(STORE.pinMap));
    return (map && map[hash]) || '';
}

function readLast(pin) {
    const last = parse(read(STORE.last));
    return (last && last[pin]) || '';
}

function writeLast(pin, wskey) {
    const last = parse(read(STORE.last)) || {};
    last[pin] = wskey;
    const keys = Object.keys(last);
    if (keys.length > 50) delete last[keys[0]];
    write(STORE.last, JSON.stringify(last));
}

/* ---------- 兜底路径：请求 Cookie ---------- */

async function fromRequestCookie() {
    const cookie = header($request.headers, 'cookie');
    if (!cookie) return;

    const wskey = matchCookie(cookie, 'wskey');
    const pin = matchCookie(cookie, 'pt_pin');

    let changed = false;
    if (isValidWskey(wskey) && wskey !== read(STORE.wskey)) {
        write(STORE.wskey, wskey);
        write(STORE.wskeyTs, Date.now());
        changed = true;
        console.log('[JD-Wskey] im-x 捕获 wskey ' + mask(wskey));
    }
    if (isValidPin(pin) && pin !== read(STORE.pin)) {
        write(STORE.pin, pin);
        write(STORE.pinTs, Date.now());
        changed = true;
        console.log('[JD-Wskey] im-x 捕获 pt_pin ' + decodeSafe(pin));
    }
    if (!changed) return;

    const p = read(STORE.pin);
    const w = read(STORE.wskey);
    const pts = Number(read(STORE.pinTs)) || 0;
    const wts = Number(read(STORE.wskeyTs)) || 0;
    if (!p || !w) return;

    if (!pts || !wts || Math.abs(pts - wts) > PAIR_WINDOW_MS) {
        console.log('[JD-Wskey] 已捕获其中一个值，等待另一个（时间差超 ' +
            (PAIR_WINDOW_MS / 60000) + ' 分钟）');
        return;
    }

    await sync([{ pin: p, wskey: w }]);

    // 标记该 wskey 已消费：避免切账号时用旧 wskey 配对新 pt_pin
    write(STORE.wskeyTs, 0);
}

/* ---------- 青龙同步 ---------- */

async function sync(pairs) {
    const excluded = parseList(cfg.exclude_pins);
    const targets = [];
    const skipped = [];

    for (const pair of pairs) {
        if (isExcluded(pair.pin, excluded)) skipped.push(pair.pin);
        else targets.push(pair);
    }

    if (skipped.length) {
        console.log('[JD-Wskey] 按 exclude_pins 跳过 ' + skipped.length + ' 个账号: ' +
            skipped.map(decodeSafe).join(', '));
    }

    // 全被排除就不用去青龙白跑一趟
    if (!targets.length) {
        const summary = formatSummary([], [], [], skipped);
        console.log('[JD-Wskey] ' + summary);
        notify('京东 Wskey → 青龙', summary, '全部已跳过');
        return;
    }

    const host = String(cfg.ql_host || '').trim().replace(/\/+$/, '');
    if (!host) throw new Error('未配置青龙地址（CONFIG.ql_host 或持久化存储 ' + CONFIG_KEY + '）');
    if (!cfg.ql_id || !cfg.ql_secret) throw new Error('未配置青龙鉴权信息');

    const token = await getToken(host);
    const api = String(cfg.ql_auth).toLowerCase() === 'password' ? '/api/envs' : '/open/envs';
    const envName = cfg.env_name || 'JD_WSCK';
    const headers = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    const list = await listEnvs(host + api, headers, envName);
    const created = [];
    const updated = [];
    const kept = [];

    for (const pair of targets) {
        const old = findEnv(list, pair.pin);

        if (old && String(old.value || '').indexOf(pair.wskey) !== -1) {
            kept.push(pair.pin);
            console.log('[JD-Wskey] 无变化 ' + decodeSafe(pair.pin));
            continue;
        }

        const value = 'pin=' + pair.pin + ';wskey=' + pair.wskey + ';';
        const remarks = 'JD_Wskey ' + decodeSafe(pair.pin);

        // 青龙 2.22.0 起 open API 的 PUT 只收单个对象，POST 仍收数组
        const body = old
            ? { id: old.id, name: envName, value: value, remarks: remarks }
            : [{ name: envName, value: value, remarks: remarks }];
        const res = parse((await http(old ? 'PUT' : 'POST', host + api, headers,
            JSON.stringify(body))).body);

        if (!res || res.code !== 200) {
            throw new Error((old ? '更新' : '新增') + ' ' + decodeSafe(pair.pin) +
                ' 失败: ' + errText(res));
        }

        if (old) {
            updated.push(pair.pin);
            console.log('[JD-Wskey] 更新 ' + decodeSafe(pair.pin) + ' ' +
                mask(matchCookie(String(old.value || ''), 'wskey')) + ' → ' + mask(pair.wskey));
        } else {
            created.push(pair.pin);
            console.log('[JD-Wskey] 新增 ' + decodeSafe(pair.pin) + ' ' + mask(pair.wskey));
            list.push({ value: value });
        }
    }

    const summary = formatSummary(created, updated, kept, skipped);
    console.log('[JD-Wskey] ' + summary);
    notify('京东 Wskey → 青龙', summary,
        '共 ' + (created.length + updated.length + kept.length) + ' 个账号' +
        (skipped.length ? '，跳过 ' + skipped.length + ' 个' : ''));
}

function formatSummary(created, updated, kept, skipped) {
    const parts = [];
    if (created.length) parts.push('新增 ' + created.length + ': ' + created.map(decodeSafe).join(', '));
    if (updated.length) parts.push('更新 ' + updated.length + ': ' + updated.map(decodeSafe).join(', '));
    if (kept.length) parts.push('无变化 ' + kept.length);
    if (skipped && skipped.length) parts.push('跳过 ' + skipped.length + ': ' + skipped.map(decodeSafe).join(', '));
    return parts.join(' | ') || '无变化';
}

async function getToken(host) {
    const cached = read(STORE.token);
    const exp = Number(read(STORE.tokenExp)) || 0;
    if (cached && exp > Date.now() + 60000) return cached;

    let res;
    if (String(cfg.ql_auth).toLowerCase() === 'password') {
        res = await http('POST', host + '/api/user/login',
            { 'Content-Type': 'application/json' },
            JSON.stringify({ username: cfg.ql_id, password: cfg.ql_secret }));
    } else {
        res = await http('GET', host + '/open/auth/token?client_id=' +
            encodeURIComponent(cfg.ql_id) + '&client_secret=' + encodeURIComponent(cfg.ql_secret));
    }

    const data = parse(res.body);
    if (!data || data.code !== 200 || !data.data || !data.data.token) {
        throw new Error('青龙鉴权失败: ' + errText(data, res.status));
    }

    let expiration = Number(data.data.expiration) || 0;
    if (expiration && expiration < 1e12) expiration *= 1000;
    if (!expiration) expiration = Date.now() + 20 * 60 * 1000;

    write(STORE.token, data.data.token);
    write(STORE.tokenExp, expiration);
    return data.data.token;
}

async function listEnvs(url, headers, envName) {
    const res = parse((await http('GET', url + '?searchValue=' + encodeURIComponent(envName),
        headers)).body);
    if (!res || res.code !== 200) throw new Error('读取变量失败: ' + errText(res));
    let arr = res.data;
    if (arr && !Array.isArray(arr)) arr = arr.data || arr.records || [];
    return Array.isArray(arr) ? arr : [];
}

function findEnv(list, pin) {
    const target = decodeSafe(pin);
    for (const item of list) {
        if (!item || !item.value) continue;
        // 兼容 pin= 与 pt_pin= 两种已有写法
        const m = /(?:^|;\s*)(?:pt_)?pin=([^;]*)/i.exec(item.value);
        if (m && decodeSafe(m[1].trim()) === target) return item;
    }
    return null;
}

/* ---------- 平台适配 ---------- */

/* QX 用 $notify / $prefs / $task.fetch，参见 https://github.com/crossutility/Quantumult-X */

function trace() {
    const now = Date.now();
    if (now - (Number(read(STORE.traceTs)) || 0) < 3000) return;
    write(STORE.traceTs, now);
    const phase = (typeof $response !== 'undefined' && $response) ? '响应' : '请求';
    console.log('[JD-Wskey] 脚本已触发 [' + phase + '] ' + $request.url);
}

function loadConfig() {
    const out = Object.assign({}, CONFIG);

    // 持久化存储里的 JSON 覆盖
    const raw = read(CONFIG_KEY);
    if (raw) {
        const json = parse(raw);
        if (json && typeof json === 'object') Object.assign(out, pruneEmpty(json));
    }

    return out;
}

/* 空值不覆盖内置配置 */
function pruneEmpty(obj) {
    const out = {};
    for (const k in obj) {
        const v = obj[k];
        if (v !== '' && v !== null && v !== undefined) out[k] = v;
    }
    return out;
}

function http(method, url, headers, body) {
    const opt = { url: url, method: String(method).toUpperCase(), headers: headers || {} };
    if (body !== undefined) opt.body = body;
    return $task.fetch(opt).then(function (r) {
        const code = r.statusCode !== undefined ? r.statusCode : r.status;
        return { status: code, body: r.body || '' };
    });
}

function read(key) {
    try {
        const v = $prefs.valueForKey(key);
        return v === null || v === undefined ? '' : v;
    } catch (e) {
        return '';
    }
}

function write(key, value) {
    try {
        // 注意 QX 的参数顺序是 (value, key)
        $prefs.setValueForKey(String(value), key);
    } catch (e) { /* 忽略 */ }
}

function notify(title, subtitle, body) {
    try {
        $notify(title, subtitle || '', body || '');
    } catch (e) { /* 忽略 */ }
}

/* ---------- 工具 ---------- */

function matchCookie(cookie, name) {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)', 'i').exec(cookie);
    return m ? m[1].trim() : '';
}

/* 逗号 / 分号 / 空白分隔，也接受数组 */
function parseList(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[,，;；\s]+/);
    return arr.map(function (s) { return String(s).trim(); }).filter(Boolean);
}

/* pin 可能以 URL 编码形式出现，两种写法都算匹配 */
function isExcluded(pin, excluded) {
    if (!excluded.length) return false;
    const plain = decodeSafe(pin);
    return excluded.some(function (item) {
        return item === pin || decodeSafe(item) === plain;
    });
}

function isValidWskey(v) {
    return !!v && /^[A-Za-z0-9_\-~]{40,}$/.test(v);
}

function isValidPin(v) {
    if (!v) return false;
    const plain = v.replace(/%2a/gi, '*');
    return plain.length >= 4 && !/^\*+$/.test(plain);
}

function parse(text) {
    if (text && typeof text === 'object') return text;
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function errText(res, status) {
    if (!res) return 'HTTP ' + (status || '?') + ' / 非 JSON 响应';
    return res.message || res.error || ('code=' + res.code);
}

function header(headers, name) {
    if (!headers) return '';
    const lower = name.toLowerCase();
    const parts = [];
    for (const k in headers) {
        if (k.toLowerCase() !== lower) continue;
        const v = headers[k];
        if (Array.isArray(v)) parts.push(v.join('; '));
        else if (v) parts.push(String(v));
    }
    return parts.join('; ');
}

function describeAll(pairs) {
    return pairs.map(function (p) {
        return decodeSafe(p.pin) + '=' + mask(p.wskey);
    }).join(', ');
}

/* 日志只暴露前缀与长度，避免完整凭证落到日志里 */
function mask(v) {
    if (!v) return '(空)';
    const s = String(v);
    if (s.length <= 14) return s;
    return s.slice(0, 8) + '…' + s.slice(-4) + '(' + s.length + ')';
}

function decodeSafe(v) {
    try {
        return decodeURIComponent(v);
    } catch (e) {
        return v;
    }
}
