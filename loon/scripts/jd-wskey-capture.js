/*
 * 京东 App：wskey / pt_pin 捕获 → 上传青龙面板
 *
 * 主路径（http-response）：
 *   京东 App 启动时会调用 https://sso.jd.com/appJdst/update，
 *   响应体一次性返回当前所有已登录账号：
 *     {"result":[{"pin":"jd_xxx","sessionTicket":"AAJ...","jdst":"...","jdgsToken":"..."}],"code":1,"success":true}
 *   其中 sessionTicket 就是 wskey（与 App 请求 Cookie 里的 wskey 完全一致）。
 *   → pin 与 wskey 天然配对，一次拿到全部账号。
 *
 * 兜底路径（http-request）：
 *   若 SSO 接口未触发，则从 *.jd.com 请求 Cookie 里分别捕获 wskey 与 pt_pin
 *   （实测二者从不出现在同一条 Cookie 中），按捕获时间邻近配对。
 *
 * 青龙侧写入格式：
 *   变量名 JD_WSCK，值 pin=xxx;wskey=yyy;
 *
 * 使用：见同目录 jd-wskey-capture.plugin
 */

const STORE = {
    pin: 'jd_wskey_cap_pin',
    pinTs: 'jd_wskey_cap_pin_ts',
    wskey: 'jd_wskey_cap_wskey',
    wskeyTs: 'jd_wskey_cap_wskey_ts',
    token: 'jd_wskey_ql_token',
    tokenExp: 'jd_wskey_ql_token_exp',
    traceTs: 'jd_wskey_cap_trace_ts'
};

/* 兜底配置：Loon Build 733 以下不支持 [Argument]，可直接改这里 */
const DEFAULTS = {
    ql_host: '',
    ql_auth: 'openapi',
    ql_id: '',
    ql_secret: '',
    env_name: 'JD_WSCK'
};

/* 兜底路径：pin 与 wskey 的捕获时间差超过该值则不配对，避免多账号串号 */
const PAIR_WINDOW_MS = 30 * 60 * 1000;

const cfg = Object.assign({}, DEFAULTS, readArgument());

(async function main() {
    try {
        trace();
        if (typeof $response !== 'undefined') await fromSsoResponse();
        else await fromRequestCookie();
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
    if (!host) throw new Error('未配置青龙地址');
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
        const res = parse((await req(old ? 'PUT' : 'POST', host + api, headers,
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
    notify('京东 Wskey → 青龙', summary, '共 ' + (created.length + updated.length + kept.length) + ' 个账号');
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
        res = await req('POST', host + '/api/user/login',
            { 'Content-Type': 'application/json' },
            JSON.stringify({ username: cfg.ql_id, password: cfg.ql_secret }));
    } else {
        res = await req('GET', host + '/open/auth/token?client_id=' +
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
    const res = parse((await req('GET', url + '?searchValue=' + encodeURIComponent(envName),
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

/* ---------- 基础设施 ---------- */

/* 诊断：确认脚本确实被 Loon 调用（3 秒节流，避免刷屏） */
function trace() {
    const now = Date.now();
    if (now - (Number(read(STORE.traceTs)) || 0) < 3000) return;
    write(STORE.traceTs, now);
    const phase = typeof $response === 'undefined' ? '请求' : '响应';
    console.log('[JD-Wskey] 脚本已触发 [' + phase + '] ' + $request.url);
}

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

function req(method, url, headers, body) {
    return new Promise(function (resolve, reject) {
        const fn = $httpClient[method.toLowerCase()];
        if (typeof fn !== 'function') {
            reject(new Error('当前 Loon 不支持 ' + method + ' 请求，请升级 Loon'));
            return;
        }
        const opt = { url: url, headers: headers || {} };
        if (body !== undefined) opt.body = body;

        fn.call($httpClient, opt, function (err, resp, data) {
            if (err) {
                reject(new Error(err + ''));
                return;
            }
            resolve({ status: resp ? resp.status : 0, body: data || '' });
        });
    });
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

function readArgument() {
    try {
        if ($argument && typeof $argument === 'object' && !Array.isArray($argument)) return $argument;
        if (typeof $argument === 'string' && $argument) {
            const out = {};
            $argument.split('&').forEach(function (kv) {
                const i = kv.indexOf('=');
                if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
            });
            return out;
        }
    } catch (e) { /* 忽略 */ }
    return {};
}

function decodeSafe(v) {
    try {
        return decodeURIComponent(v);
    } catch (e) {
        return v;
    }
}

function read(key) {
    const v = $persistentStore.read(key);
    return v === null || v === undefined ? '' : v;
}

function write(key, value) {
    $persistentStore.write(String(value), key);
}

function notify(title, subtitle, body) {
    $notification.post(title, subtitle || '', body || '');
}
