/*
 * 京东 Wskey → 青龙：一次性配置写入
 *
 * 用法（Quantumult X 里已引用 jd-wskey-capture.conf 的前提下）：
 * 用 Safari 访问下面这个地址，把尖括号内容换成你的实际值：
 *
 *   http://www.jd.com/?__jd_wskey_setup&host=<青龙地址>&id=<client_id>&secret=<client_secret>
 *
 * 可选参数：auth=openapi|password（默认 openapi）、env=JD_WSCK（默认 JD_WSCK）
 *
 * 例：
 *   http://www.jd.com/?__jd_wskey_setup&host=https://ql.example.com&id=abc123&secret=def456
 *
 * 看到「配置完成」通知即写入成功。配置存在本机 QX 持久化存储，不上网。
 * 事后可以清掉 Safari 浏览历史里的这条 URL。
 */

const CONFIG_KEY = 'jd_wskey_config';

(function () {
    const q = parseQuery($request.url);
    if (!q.host || !q.id || !q.secret) {
        notify('❌ 京东 Wskey 配置失败', 'URL 缺少 host / id / secret 参数');
        $done({});
        return;
    }

    const cfg = {
        ql_host: q.host,
        ql_auth: q.auth || 'openapi',
        ql_id: q.id,
        ql_secret: q.secret,
        env_name: q.env || 'JD_WSCK'
    };

    try {
        if (typeof $prefs !== 'undefined') $prefs.setValueForKey(JSON.stringify(cfg), CONFIG_KEY);
        else if (typeof $persistentStore !== 'undefined') $persistentStore.write(JSON.stringify(cfg), CONFIG_KEY);
    } catch (e) {
        notify('❌ 京东 Wskey 配置失败', '写入持久化存储出错: ' + e);
        $done({});
        return;
    }

    console.log('[JD-Wskey] 配置已写入 ' + CONFIG_KEY + ' → ' + cfg.ql_host);
    notify('✅ 京东 Wskey 配置完成', cfg.ql_host,
        '鉴权 ' + cfg.ql_auth + ' · 变量 ' + cfg.env_name);
})();

function parseQuery(url) {
    const out = {};
    const idx = String(url).indexOf('?');
    if (idx < 0) return out;
    String(url).slice(idx + 1).split('&').forEach(function (kv) {
        const i = kv.indexOf('=');
        if (i <= 0) return;
        const k = kv.slice(0, i);
        const v = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        if (k && k !== '__jd_wskey_setup') out[k] = v;
    });
    return out;
}

function notify(title, subtitle, body) {
    try {
        if (typeof $notify !== 'undefined') $notify(title, subtitle || '', body || '');
        else if (typeof $notification !== 'undefined') $notification.post(title, subtitle || '', body || '');
    } catch (e) { /* 忽略 */ }
}
