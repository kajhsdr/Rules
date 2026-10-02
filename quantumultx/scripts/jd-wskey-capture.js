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
 * 兜底路径（请求脚本）：
 *   若 SSO 接口未触发，则从 *.jd.com 请求 Cookie 里分别捕获 wskey 与 pt_pin
 *   （实测二者从不出现在同一条 Cookie 中），按捕获时间邻近配对。
 *
 * 青龙侧写入格式：变量名 JD_WSCK，值 pin=xxx;wskey=yyy;
 *
 * 配置：已内置在下方 CONFIG。如果要用持久化存储覆盖（key = jd_wskey_config），
 * value 为同结构的 JSON，优先级高于 CONFIG。
 */

const CONFIG = {
    ql_host: 'http://192.168.1.2:5700',
    ql_auth: 'openapi',
    ql_id: 'h6p4roq-Ba3N',
    ql_secret: 'DyHOL84HVWa7HD-MFAjMqMo2',
    env_name: 'JD_WSCK'
};

const CONFIG_KEY = 'jd_wskey_config';

const STORE = {
    pin: 'jd_wskey_cap_pin',
    pinTs: 'jd_wskey_cap_pin_ts',
    wskey: 'jd_wskey_cap_wskey',
    wskeyTs: 'jd_wskey_cap_wskey_ts',
    token: 'jd_wskey_ql_token',
    tokenExp: 'jd_wskey_ql_token_exp',
    traceTs: 'jd_wskey_cap_trace_ts'
};

/* 兜底路径：pin 与 wskey 的捕获时间差超过该值则不配对，避免多账号串号 */
const PAIR_WINDOW_MS = 30 * 60 * 1000;

const cfg = loadConfig();

(async function main() {
    try {
        trace();
        if (typeof $response !== 'undefined' && $response && typeof $response.body !== 'undefined') {
            await fromSsoResponse();
        } else {
            await fromRequestCookie();
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
    const json = parse($response.body);
    if (!json || !Array.isArray(json.result)) {
        console.log('[JD-Wskey] SSO 响应无法解析，body 长度 ' + String($response.body || '').length);
        return;
    }

    const pairs = json.result
        .filter(function (it) { return it && isValidPin(it.pin) && isValidWskey(it.sessionTicket); })
        .map(function (it) { return { pin: it.pin, wskey: it.sessionTicket }; });

    if (!pairs.length) return;
    console.log('[JD-Wskey] SSO 返回 ' + pairs.length + ' 个账号');
    await sync(pairs);
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
    }
    if (isValidPin(pin) && pin !== read(STORE.pin)) {
        write(STORE.pin, pin);
        write(STORE.pinTs, Date.now());
        changed = true;
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

    for (const pair of pairs) {
        const old = findEnv(list, pair.pin);

        if (old && String(old.value || '').indexOf(pair.wskey) !== -1) {
            kept.push(pair.pin);
            continue;
        }

        const value = 'pin=' + pair.pin + ';wskey=' + pair.wskey + ';';
        const remarks = 'JD_Wskey ' + decodeSafe(pair.pin);

        const body = old
            ? [{ id: old.id, _id: old._id, name: envName, value: value, remarks: remarks }]
            : [{ name: envName, value: value, remarks: remarks }];
        const res = parse((await http(old ? 'PUT' : 'POST', host + api, headers,
            JSON.stringify(body))).body);

        if (!res || res.code !== 200) {
            throw new Error((old ? '更新' : '新增') + ' ' + decodeSafe(pair.pin) +
                ' 失败: ' + errText(res));
        }

        if (old) updated.push(pair.pin);
        else {
            created.push(pair.pin);
            list.push({ value: value });
        }
    }

    const summary = formatSummary(created, updated, kept);
    console.log('[JD-Wskey] ' + summary);
    notify('京东 Wskey → 青龙', summary,
        '共 ' + (created.length + updated.length + kept.length) + ' 个账号');
}

function formatSummary(created, updated, kept) {
    const parts = [];
    if (created.length) parts.push('新增 ' + created.length + ': ' + created.map(decodeSafe).join(', '));
    if (updated.length) parts.push('更新 ' + updated.length + ': ' + updated.map(decodeSafe).join(', '));
    if (kept.length) parts.push('无变化 ' + kept.length);
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

function decodeSafe(v) {
    try {
        return decodeURIComponent(v);
    } catch (e) {
        return v;
    }
}
