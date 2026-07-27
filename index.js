/**
 * ST API Switcher · API 快切
 * 一键切换 OpenAI 兼容接口的 URL + API Key + 模型
 * https://github.com/idx425/st-api-switcher
 * License: MIT
 */
(() => {
    'use strict';

    const MODULE = 'st_api_switcher';
    const EXT_NAME = 'st-api-switcher';
    const VERSION = '3.0.1';
    const REPO_PATH = 'idx425/st-api-switcher';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function getCtx() {
        try {
            return SillyTavern.getContext();
        } catch {
            return null;
        }
    }

    jQuery(async () => {
        const ctx = getCtx();
        if (!ctx) {
            console.error('[API快切] 无法获取 SillyTavern context，扩展未加载（酒馆版本过旧？）');
            return;
        }

        /* ---------------- 设置存取 ---------------- */
        if (!ctx.extensionSettings[MODULE] || !Array.isArray(ctx.extensionSettings[MODULE].profiles)) {
            ctx.extensionSettings[MODULE] = { profiles: [] };
        }
        const settings = ctx.extensionSettings[MODULE];
        const save = () => ctx.saveSettingsDebounced();
        const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        if (!settings.groupCollapsed || typeof settings.groupCollapsed !== 'object') settings.groupCollapsed = {};
        if (!settings.pages || typeof settings.pages !== 'object') settings.pages = {};
        if (!settings.pages.list || typeof settings.pages.list !== 'object') settings.pages.list = {};
        if (typeof settings.pages.embed !== 'number') settings.pages.embed = 0;
        if (typeof settings.pages.quick !== 'number') settings.pages.quick = 0;
        settings.profiles.forEach((p) => {
            if (!p.id) p.id = uid();
            if (typeof p.group !== 'string') p.group = '';
        });

        let editingId = null;

        /* ---------------- 工具 ---------------- */
        const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
        const currentUrl = () => normUrl($('#custom_api_url_text').val());
        const isActive = (p) => !!currentUrl() && currentUrl() === normUrl(p.url);

        function fetchTimeout(url, opts, ms) {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), ms || 8000);
            return fetch(url, Object.assign({}, opts, { signal: ac.signal })).finally(() => clearTimeout(t));
        }

        /* ST/TT 的 /api/secrets/write 只会追加新条目，不会原地覆盖。
         * TT/新版 ST 的 Connect 会把 secret_state 里当前 active 的 id 作为 secret_id 发给后端；
         * 若「先删后写」会让 secret_state 短暂指向已删除 id → Validation error: Secret id not found。
         * 策略：先写新密钥（成为 active）→ 再删旧条目 → 同步 secret_state。
         * Connect 前清空 #api_key_custom，避免官方再 write 追加一条。 */
        const SECRET_KEY_CUSTOM = 'api_key_custom';
        const SECRET_LABEL = 'API 快切';

        let secretsModulePromise = null;
        function loadSecretsModule() {
            if (!secretsModulePromise) {
                secretsModulePromise = import('/scripts/secrets.js')
                    .catch(() => import('../../scripts/secrets.js'))
                    .catch((err) => {
                        console.warn('[API快切] 无法加载 secrets 模块，使用裸 API', err);
                        return null;
                    });
            }
            return secretsModulePromise;
        }

        async function refreshSecretState() {
            const mod = await loadSecretsModule();
            if (mod && typeof mod.readSecretState === 'function') {
                try {
                    await mod.readSecretState();
                    return true;
                } catch (e) {
                    console.warn('[API快切] readSecretState 失败', e);
                }
            }
            // 最后兜底：直接改导出的 secret_state 引用
            if (mod && mod.secret_state && typeof mod.secret_state === 'object') {
                try {
                    let headers;
                    try {
                        headers = ctx.getRequestHeaders({ omitContentType: true });
                    } catch {
                        headers = ctx.getRequestHeaders();
                    }
                    const res = await fetchTimeout('/api/secrets/read', {
                        method: 'POST',
                        headers,
                    }, 8000);
                    if (!res.ok) return false;
                    const state = await res.json();
                    for (const k of Object.keys(mod.secret_state)) delete mod.secret_state[k];
                    Object.assign(mod.secret_state, state || {});
                    if (typeof mod.updateSecretDisplay === 'function') mod.updateSecretDisplay();
                    return true;
                } catch (e) {
                    console.warn('[API快切] 手动同步 secret_state 失败', e);
                }
            }
            return false;
        }

        async function readCustomSecrets() {
            try {
                let headers;
                try {
                    headers = ctx.getRequestHeaders({ omitContentType: true });
                } catch {
                    headers = ctx.getRequestHeaders();
                }
                const res = await fetchTimeout('/api/secrets/read', {
                    method: 'POST',
                    headers,
                }, 8000);
                if (!res.ok) return [];
                const state = await res.json();
                const list = state && state[SECRET_KEY_CUSTOM];
                return Array.isArray(list) ? list : [];
            } catch {
                return [];
            }
        }

        async function deleteCustomSecret(id) {
            const body = id
                ? { key: SECRET_KEY_CUSTOM, id }
                : { key: SECRET_KEY_CUSTOM };
            const res = await fetchTimeout('/api/secrets/delete', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body),
            }, 8000);
            return res.ok || res.status === 204;
        }

        // 串行化密钥库写操作，避免连点切换时 write/delete 交错
        let secretWriteQueue = Promise.resolve();
        function queueSecretWrite(task) {
            const run = secretWriteQueue.then(task, task);
            secretWriteQueue = run.then(() => undefined, () => undefined);
            return run;
        }

        async function pruneOtherCustomSecrets(keepId) {
            for (let round = 0; round < 6; round++) {
                const list = await readCustomSecrets();
                if (list.length <= 1) return list;
                const keep = (keepId && list.find((x) => x && x.id === keepId))
                    || list.find((x) => x && x.active)
                    || list[list.length - 1];
                let removed = 0;
                for (const item of list) {
                    if (!item || !item.id || !keep || item.id === keep.id) continue;
                    if (await deleteCustomSecret(item.id)) removed += 1;
                }
                if (!removed) break;
                await sleep(30);
            }
            return readCustomSecrets();
        }

        async function writeKey(key) {
            const value = String(key || '');
            return queueSecretWrite(async () => {
                const mod = await loadSecretsModule();

                // 空 Key：清空槽位后同步状态
                if (!value) {
                    const list = await readCustomSecrets();
                    for (const item of list) {
                        if (item && item.id) await deleteCustomSecret(item.id);
                        else await deleteCustomSecret();
                    }
                    await refreshSecretState();
                    return;
                }

                // 1) 先写入新密钥（成为 active），绝不能先删光再写
                let keepId = null;
                if (mod && typeof mod.writeSecret === 'function') {
                    keepId = await mod.writeSecret(SECRET_KEY_CUSTOM, value, SECRET_LABEL);
                    if (!keepId) {
                        // writeSecret 失败时回退裸 API
                        const res = await fetchTimeout('/api/secrets/write', {
                            method: 'POST',
                            headers: ctx.getRequestHeaders(),
                            body: JSON.stringify({ key: SECRET_KEY_CUSTOM, value, label: SECRET_LABEL }),
                        }, 8000);
                        if (!res.ok) throw new Error('写入密钥失败: HTTP ' + res.status);
                        try {
                            const data = await res.json();
                            keepId = data && data.id;
                        } catch { /* ignore */ }
                        await refreshSecretState();
                    }
                } else {
                    const res = await fetchTimeout('/api/secrets/write', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ key: SECRET_KEY_CUSTOM, value, label: SECRET_LABEL }),
                    }, 8000);
                    if (!res.ok) throw new Error('写入密钥失败: HTTP ' + res.status);
                    try {
                        const data = await res.json();
                        keepId = data && data.id;
                    } catch { /* ignore */ }
                    await refreshSecretState();
                }

                // 2) 再删旧条目，只保留刚写入的那条（覆盖语义、不堆密钥）
                await pruneOtherCustomSecrets(keepId);

                // 3) 最终同步前端 secret_state，保证 Connect 带上的 secret_id 存在
                await refreshSecretState();
            });
        }

        /* ---------------- 核心：应用配置 ---------------- */
        let applyBusy = false;

        async function applyProfile(p) {
            if (applyBusy) return false;
            applyBusy = true;
            try {
                if (!$('#custom_api_url_text').length) {
                    throw new Error('未找到自定义接口输入框，请确认酒馆版本（需 1.12+）');
                }
                const url = normUrl(p.url);
                const key = String(p.key || '');
                if (!url) throw new Error('站点 URL 为空');
                if (!key) toastr.warning('该站点未保存 API Key，连接可能失败', 'API 快切');

                // 先切源再写 URL/Key，避免源切换时清空
                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('custom').trigger('change');
                await sleep(120);

                // 只写一次密钥库（覆盖同一条），URL/模型写进表单
                await writeKey(key);
                $('#custom_api_url_text').val(url).trigger('input').trigger('change');
                if (p.model) {
                    $('#custom_model_id').val(p.model).trigger('input').trigger('change');
                }
                // 关键关键输入框！Connect 看到有值会再 writeSecret 追加一条
                // 密钥已在 secrets 里激活，custom 源允许 keyless 继续连接
                $('#api_key_custom').val('').trigger('input').trigger('change');
                await sleep(120);

                const $btn = $('#api_button_openai');
                if ($btn.length) $btn.trigger('click');
                else toastr.warning('未找到 Connect 按钮，已写入 URL/Key，请手动点连接');

                toastr.success('已切换到「' + p.name + '」', 'API 快切');
                renderAll();
                return true;
            } catch (err) {
                console.error('[API快切]', err);
                toastr.error(String(err && err.message || err), 'API 快切失败');
                return false;
            } finally {
                applyBusy = false;
            }
        }

        /* ---------------- 更新检查（一键更新） ---------------- */
        let updGlobal = false;
        let updState = 'idle';

        function setUpdateState(s) {
            updState = s;
            const btn = $('#aqs_update_btn');
            if (!btn.length) return;
            const map = {
                idle: '<i class="fa-solid fa-satellite-dish"></i> 检查更新',
                checking: '<i class="fa-solid fa-circle-notch fa-spin"></i> 检测中',
                latest: '<i class="fa-solid fa-circle-check"></i> 已最新',
                available: '<i class="fa-solid fa-cloud-arrow-down"></i> 新版本·点击更新',
                updating: '<i class="fa-solid fa-circle-notch fa-spin"></i> 更新中',
                updated: '<i class="fa-solid fa-rotate-right"></i> 刷新生效',
            };
            btn.html(map[s] || map.idle);
            btn.toggleClass('aqs-update-avail', s === 'available' || s === 'updated');
        }

        let scopeCache;


        async function resolveInstallScope() {
            if (scopeCache !== undefined) return scopeCache;
            try {
                const res = await fetchTimeout('/api/extensions/discover', {
                    method: 'GET',
                    headers: ctx.getRequestHeaders(),
                });
                if (res.ok) {
                    const list = await res.json();
                    const hit = Array.isArray(list) && list.find((e) =>
                        e && (e.name === `third-party/${EXT_NAME}` || e.name === EXT_NAME));
                    if (hit) {
                        scopeCache = String(hit.type).toLowerCase() === 'global';
                        return scopeCache;
                    }
                }
            } catch { /* 后端不支持 discover 时走盲测 */ }
            scopeCache = null;
            return null;
        }

        function cmpVer(a, b) {
            const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                const d = (pa[i] || 0) - (pb[i] || 0);
                if (d) return d;
            }
            return 0;
        }

        async function checkRemoteManifest() {
            const urls = [
                `https://raw.githubusercontent.com/${REPO_PATH}/main/manifest.json`,
                `https://cdn.jsdelivr.net/gh/${REPO_PATH}@main/manifest.json`,
                `https://fastly.jsdelivr.net/gh/${REPO_PATH}@main/manifest.json`,
            ];
            for (const u of urls) {
                try {
                    const res = await fetchTimeout(u, { cache: 'no-cache' }, 6000);
                    if (!res.ok) continue;
                    const m = await res.json();
                    if (m && m.version) return m.version;
                } catch { /* 换下一个源 */ }
            }
            return null;
        }

        let updateNotified = false;

        function notifyUpdate(remoteVer, force) {
            if (updateNotified && !force) return;
            updateNotified = true;
            const label = remoteVer ? ' v' + remoteVer : '';
            toastr.info(
                '检测到新版本' + label + '，点击此通知立即更新（或在插件面板顶部点更新按钮）',
                'API 快切 · 有更新',
                { timeOut: 12000, extendedTimeOut: 4000, onclick: () => doUpdate() },
            );
        }

        async function checkUpdate(silent) {
            if (updState === 'checking' || updState === 'updating') return;
            setUpdateState('checking');
            const scope = await resolveInstallScope();
            const tries = scope === null ? [true, false] : [scope];
            let backendErr = null;
            for (const g of tries) {
                try {
                    const res = await fetchTimeout('/api/extensions/version', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ extensionName: EXT_NAME, global: g }),
                    });
                    if (!res.ok) {
                        backendErr = await res.text().catch(() => 'HTTP ' + res.status);
                        continue;
                    }
                    const data = await res.json();
                    updGlobal = g;
                    if (data.isUpToDate === false) {
                        setUpdateState('available');
                        notifyUpdate('', !silent);
                    } else {
                        setUpdateState('latest');
                        if (!silent) toastr.success('已是最新版本 v' + VERSION, 'API 快切');
                    }
                    return;
                } catch (e) { backendErr = String(e && e.message || e); }
            }
            const remoteVer = await checkRemoteManifest();
            if (remoteVer && cmpVer(remoteVer, VERSION) > 0) {
                if (scope !== null) updGlobal = scope;
                setUpdateState('available');
                notifyUpdate(remoteVer, !silent);
                return;
            }
            if (remoteVer) {
                setUpdateState('latest');
                if (!silent) toastr.success('已是最新版本 v' + VERSION, 'API 快切');
                return;
            }
            setUpdateState('idle');
            if (!silent) {
                const hint = /not found/i.test(backendErr || '')
                    ? '后端找不到扩展目录（可能安装方式不受支持）'
                    : '后端无法连接 GitHub（如在国内请开启代理后重试）';
                toastr.warning('无法检查更新：' + hint, 'API 快切');
            }
        }

        async function doUpdate() {
            if (updState === 'updating') return;
            setUpdateState('updating');
            const scope = await resolveInstallScope();
            const tries = scope === null ? [updGlobal, !updGlobal] : [scope];
            let lastErr = null;
            for (const g of tries) {
                try {
                    const res = await fetchTimeout('/api/extensions/update', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ extensionName: EXT_NAME, global: g }),
                    }, 30000);
                    if (!res.ok) {
                        lastErr = await res.text().catch(() => 'HTTP ' + res.status);
                        continue;
                    }
                    setUpdateState('updated');
                    if (confirm('更新完成！立即刷新页面使新版本生效？')) {
                        location.reload();
                    }
                    return;
                } catch (e) { lastErr = String(e && e.message || e); }
            }
            setUpdateState('available');
            let hint = lastErr || '未知错误';
            if (/metadata is missing/i.test(hint)) {
                hint = '扩展缺少安装来源信息，请在「管理扩展」里删除后，用「安装扩展」粘贴仓库链接重装一次（已保存的配置不会丢失）';
            } else if (/not found/i.test(hint)) {
                hint = '后端找不到扩展目录，请删除后用「安装扩展」重装一次（配置不会丢失）';
            } else if (/network|fetch|timeout|abort|connect/i.test(hint)) {
                hint = '无法连接 GitHub 下载更新（如在国内请开启代理后重试）';
            }
            toastr.error(hint, '更新失败');
        }

        /* ---------------- 模型列表获取 ---------------- */
        function candidateUrls(url) {
            const base = normUrl(url);
            if (!base) return [];
            const out = [base];
            // 有人只填域名、有人多写一层 /v1 —— 都试一遍
            if (/\/v1$/i.test(base)) {
                const root = base.replace(/\/v1$/i, '');
                if (root && !out.includes(root)) out.push(root);
            } else if (!/\/v\d+$/i.test(base)) {
                const withV1 = base + '/v1';
                if (!out.includes(withV1)) out.push(withV1);
            }
            return out;
        }

        function extractModels(json) {
            if (!json) return [];
            let arr = [];
            if (Array.isArray(json)) arr = json;
            else if (Array.isArray(json.data)) arr = json.data;
            else if (json.data && Array.isArray(json.data.data)) arr = json.data.data;
            else if (Array.isArray(json.models)) arr = json.models;
            else if (json.data && Array.isArray(json.data.models)) arr = json.data.models;
            return arr
                .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.model || m.name))))
                .filter(Boolean)
                .map(String);
        }

        function errMsgFromJson(json, fallback) {
            if (!json) return fallback || '未知错误';
            if (typeof json.error === 'string' && json.error && json.error !== 'true') return json.error;
            if (json.error && typeof json.error === 'object') {
                const m = json.error.message || json.error.msg || json.error.code;
                if (m) return String(m);
            }
            if (json.message) return String(json.message);
            if (json.error_message) return String(json.error_message);
            if (json.error === true) return fallback || '上游接口报错（常见：Key 无效、URL 不对、或酒馆服务器 IP 被拦）';
            return fallback || '未知错误';
        }

        function humanizeFetchErr(msg) {
            const s = String(msg || '');
            if (/未填写 API Key/.test(s)) return s;
            if (/401|Unauthorized|invalid.?api.?key|incorrect.?api.?key|authentication/i.test(s)) {
                return '密钥无效或无权限（401）。请确认该站点自己的 API Key 已填对';
            }
            if (/403|Forbidden/i.test(s)) {
                return '被拒绝访问（403）。可能是 Key 权限不足，或站点拦了当前网络';
            }
            if (/Failed to fetch|NetworkError|CORS|blocked by CORS|Load failed/i.test(s)) {
                return '浏览器直连被拦（CORS/网络）。将自动改走酒馆服务器代理；若仍失败，多半是该站点拦了酒馆服务器 IP';
            }
            if (/timeout|aborted|AbortError/i.test(s)) {
                return '请求超时。站点太慢或当前网络访问不到该域名';
            }
            if (/接口报错|上游 \/models 失败|error\s*:\s*true/i.test(s)) {
                return '上游 /models 失败。常见原因：Key 不对、URL 多/少了 /v1、或酒馆服务器 IP 被中转站拦截';
            }
            return s;
        }

        function resolveFetchKey(url, key) {
            let k = String(key || '').trim();
            if (k) return k;
            const formKey = String($('#aqs_key').val() || '').trim();
            if (formKey) return formKey;
            const u = normUrl(url);
            // 同 URL 的已保存站点（编辑时密码框有时是空的，别误用当前连接的 Key）
            const byUrl = settings.profiles.find((p) => normUrl(p.url) === u && String(p.key || '').trim());
            if (byUrl) return String(byUrl.key || '').trim();
            // 再退回当前连接站点
            const active = settings.profiles.find(isActive);
            return active ? String(active.key || '').trim() : '';
        }

        function modelEndpoints(baseUrl) {
            const u = normUrl(baseUrl);
            if (!u) return [];
            const eps = [];
            // OpenAI 兼容：base 通常以 /v1 结尾，只拼 /models
            eps.push(u + '/models');
            if (!/\/v\d+$/i.test(u)) eps.push(u + '/v1/models');
            // 少数网关挂在根路径
            if (/\/v1$/i.test(u)) eps.push(u.replace(/\/v1$/i, '') + '/models');
            return [...new Set(eps)];
        }

        async function fetchModelsDirect(url, key) {
            // 浏览器直连：走手机/本机网络，避开「酒馆服务器 IP 被中转站墙」
            let lastErr = '';
            for (const ep of modelEndpoints(url)) {
                try {
                    const res = await fetchTimeout(ep, {
                        method: 'GET',
                        headers: {
                            'Authorization': 'Bearer ' + (key || ''),
                            'Accept': 'application/json',
                        },
                        mode: 'cors',
                        cache: 'no-store',
                    }, 20000);
                    const text = await res.text();
                    let json = null;
                    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
                    if (!res.ok) {
                        lastErr = errMsgFromJson(json, 'HTTP ' + res.status) + ' @ ' + ep;
                        continue;
                    }
                    const models = extractModels(json);
                    if (models.length) return models;
                    lastErr = '空列表 @ ' + ep;
                } catch (e) {
                    lastErr = String(e && e.message || e) + ' @ ' + ep;
                }
            }
            throw new Error(lastErr || '浏览器直连失败');
        }

        async function fetchModelsViaProxy(url) {
            const res = await fetchTimeout('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: url,
                }),
            }, 25000);
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
            if (!res.ok) {
                throw new Error(errMsgFromJson(json, text || ('HTTP ' + res.status)).slice(0, 200));
            }
            const models = extractModels(json);
            if (models.length) return models;
            // 酒馆在上游失败时仍可能 200 + {error:true, data:{data:[]}}
            if (json && json.error) {
                throw new Error(errMsgFromJson(json, '上游 /models 失败'));
            }
            throw new Error('接口没有返回模型列表');
        }

        async function fetchModelList(url, key) {
            // 拉模型：优先浏览器直连（与手机网络一致），失败再走酒馆代理
            // 写密钥库仅服务代理路径；结束后还原，避免污染当前连接
            const activeProfile = settings.profiles.find(isActive);
            const prevKey = String($('#api_key_custom').val() || '').trim()
                || (activeProfile ? String(activeProfile.key || '').trim() : '');
            const useKey = resolveFetchKey(url, key);
            if (!useKey) throw new Error('未填写 API Key，无法获取模型');

            const urls = candidateUrls(url);
            let lastErr = '';
            let wroteProxyKey = false;

            try {
                // 1) 浏览器直连
                for (const u of urls) {
                    try {
                        const models = await fetchModelsDirect(u, useKey);
                        return [...new Set(models)].sort((a, b) => a.localeCompare(b));
                    } catch (e) {
                        lastErr = String(e && e.message || e);
                    }
                }

                // 2) 酒馆服务端代理（需要把目标 Key 临时写入密钥库；仍只保留一条）
                await writeKey(useKey);
                wroteProxyKey = true;
                // 不把 Key 留在可见框，避免用户点 Connect 再追加一条
                $('#api_key_custom').val('');
                await sleep(250);
                for (const u of urls) {
                    try {
                        const models = await fetchModelsViaProxy(u);
                        return [...new Set(models)].sort((a, b) => a.localeCompare(b));
                    } catch (e) {
                        lastErr = String(e && e.message || e);
                    }
                }
                throw new Error(humanizeFetchErr(lastErr || '获取模型失败'));
            } finally {
                // 只要写过密钥库，就尽量还原到「当前连接站点」的 Key，避免污染
                if (wroteProxyKey) {
                    const restore = (activeProfile && String(activeProfile.key || '').trim()) || prevKey;
                    if (restore && restore !== useKey) {
                        writeKey(restore).then(() => {
                            $('#api_key_custom').val('');
                        }).catch(() => {});
                    } else {
                        $('#api_key_custom').val('');
                    }
                }
            }
        }

        function viewportSize() {
            const vv = window.visualViewport;
            const nums = (...xs) => xs.filter((n) => typeof n === 'number' && isFinite(n) && n > 0);
            // 取最可信的可视宽高：visualViewport 优先，但异常过小时回退
            let vh = Math.round(Math.max(...nums(
                vv && vv.height,
                window.innerHeight,
                document.documentElement && document.documentElement.clientHeight,
                640,
            )));
            let vw = Math.round(Math.max(...nums(
                vv && vv.width,
                window.innerWidth,
                document.documentElement && document.documentElement.clientWidth,
                360,
            )));
            // 有的手机浏览器 vv 只报地址栏缝隙高度，强制用 inner*
            if (vv && vv.height && window.innerHeight && vv.height < window.innerHeight * 0.6) {
                vh = Math.round(window.innerHeight);
            }
            if (vv && vv.width && window.innerWidth && vv.width < window.innerWidth * 0.6) {
                vw = Math.round(window.innerWidth);
            }
            // 不要硬抬高 vh，否则短屏会把弹窗算到屏幕外
            return { vw: Math.max(280, vw), vh: Math.max(280, vh) };
        }

        function layoutModelModal(root) {
            const el = root && root.nodeType ? root : (root && root[0]) || null;
            if (!el || !el.isConnected) return;
            const box = el.querySelector('.aqs-modal-box');
            if (!box) return;
            const list = el.querySelector('.aqs-modal-list');
            const head = box.querySelector('.aqs-modal-head');
            const filter = box.querySelector('.aqs-modal-filter');

            const { vw, vh } = viewportSize();
            const isPhone = vw < 700;
            // 用 flex 居中全屏遮罩，彻底避开 absolute top 算偏导致「只剩一条缝」
            el.style.cssText = [
                'position:fixed',
                'inset:0',
                'top:0',
                'left:0',
                'right:0',
                'bottom:0',
                'width:100%',
                'height:100%',
                'width:100vw',
                'height:100vh',
                'height:100dvh',
                'margin:0',
                'padding:' + (isPhone ? '12px' : '24px'),
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'box-sizing:border-box',
                'overflow:hidden',
                'z-index:2147483000',
                'transform:none',
                'background:rgba(2,4,10,0.86)',
                'backdrop-filter:blur(8px)',
                '-webkit-backdrop-filter:blur(8px)',
                'visibility:visible',
                'opacity:1',
                'pointer-events:auto',
            ].map((s) => s + ' !important').join(';') + ';';

            const pad = isPhone ? 12 : 24;
            const boxW = Math.max(280, Math.min(isPhone ? (vw - pad * 2) : 480, vw - pad * 2));
            // 永远不超过可视区；短屏优先“塞进屏幕”而不是硬撑 360px
            const maxBoxH = Math.max(240, vh - pad * 2);
            const preferH = Math.round(vh * (isPhone ? 0.86 : 0.78));
            const floorH = Math.min(isPhone ? 320 : 360, maxBoxH);
            const boxH = Math.max(floorH, Math.min(preferH, maxBoxH));

            box.style.cssText = [
                'position:relative',
                'top:auto',
                'left:auto',
                'right:auto',
                'bottom:auto',
                'width:' + boxW + 'px',
                'max-width:calc(100vw - ' + (pad * 2) + 'px)',
                'height:' + boxH + 'px',
                'max-height:' + maxBoxH + 'px',
                'min-height:0',
                'margin:0',
                'transform:none',
                'display:flex',
                'flex-direction:column',
                'flex:0 1 auto',
                'box-sizing:border-box',
                'overflow:hidden',
                'visibility:visible',
                'opacity:1',
                'z-index:2147483001',
                'border:1px solid rgba(255,255,255,0.28)',
                'border-radius:' + (isPhone ? '16' : '19') + 'px',
                'background:#0f1522',
                'padding:14px',
                'color:#f8fbff',
                '-webkit-text-fill-color:#f8fbff',
                'pointer-events:auto',
                'box-shadow:0 22px 60px rgba(0,0,0,0.65)',
            ].map((s) => s + ' !important').join(';') + ';';

            if (head) {
                head.style.cssText = [
                    'display:flex',
                    'align-items:center',
                    'justify-content:space-between',
                    'flex:0 0 auto',
                    'padding:4px 2px 11px',
                    'box-sizing:border-box',
                    'width:100%',
                    'color:#ffffff',
                    '-webkit-text-fill-color:#ffffff',
                ].map((s) => s + ' !important').join(';') + ';';
            }
            if (filter) {
                filter.style.cssText = [
                    'display:block',
                    'width:100%',
                    'flex:0 0 auto',
                    'box-sizing:border-box',
                    'margin:0 0 10px 0',
                    'border-radius:11px',
                    'color:#ffffff',
                    '-webkit-text-fill-color:#ffffff',
                    'background:rgba(255,255,255,0.10)',
                    'padding:11px 12px',
                    'font-size:16px',
                ].map((s) => s + ' !important').join(';') + ';';
            }
            if (list) {
                list.style.cssText = [
                    'display:block',
                    'visibility:visible',
                    'opacity:1',
                    'flex:1 1 auto',
                    'min-height:0',
                    'height:auto',
                    'max-height:none',
                    'overflow-y:auto',
                    'overflow-x:hidden',
                    '-webkit-overflow-scrolling:touch',
                    'overscroll-behavior:contain',
                    'touch-action:pan-y',
                    'color:#ffffff',
                    '-webkit-text-fill-color:#ffffff',
                    'box-sizing:border-box',
                    'width:100%',
                ].map((s) => s + ' !important').join(';') + ';';
            }
            el.setAttribute('data-aqs-layout', vw + 'x' + vh + (isPhone ? ':phone' : ':desk'));
        }

        function openModelPicker(url, key, onPick) {
            url = normUrl(url);
            if (!url) { toastr.warning('请先填写接口 URL'); return; }

            $('#aqs_model_modal').remove();
            const overlay = $(`
                <div id="aqs_model_modal" role="dialog" aria-modal="true" aria-label="选择模型">
                  <div class="aqs-modal-box">
                    <div class="aqs-modal-head">
                      <span><i class="fa-solid fa-microchip"></i> MODEL·SELECT<i class="aqs-blink">▊</i></span>
                      <i class="fa-solid fa-xmark aqs-modal-close" title="关闭" role="button" tabindex="0"></i>
                    </div>
                    <input class="text_pole aqs-modal-filter" placeholder="搜索模型…">
                    <div class="aqs-modal-list">
                      <div class="aqs-modal-loading"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp; SCANNING…</div>
                    </div>
                  </div>
                </div>`);
            // 挂到 <html>，避开 body 内 transform/overflow 把 fixed 算歪
            $(document.documentElement).append(overlay);
            const host = overlay[0];
            const relayout = () => {
                try { layoutModelModal(host); } catch (e) { console.error('[API快切] layout', e); }
            };
            relayout();
            requestAnimationFrame(() => {
                relayout();
                requestAnimationFrame(relayout);
            });
            setTimeout(relayout, 16);
            setTimeout(relayout, 50);
            setTimeout(relayout, 160);
            setTimeout(relayout, 360);
            const onResize = () => relayout();
            window.addEventListener('resize', onResize);
            window.addEventListener('orientationchange', onResize);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', onResize);
                window.visualViewport.addEventListener('scroll', onResize);
            }

            const prevOverflow = document.body.style.overflow;
            const prevTouch = document.body.style.touchAction;
            const prevHtmlOverflow = document.documentElement.style.overflow;
            const close = () => {
                document.body.style.overflow = prevOverflow;
                document.body.style.touchAction = prevTouch;
                document.documentElement.style.overflow = prevHtmlOverflow;
                window.removeEventListener('resize', onResize);
                window.removeEventListener('orientationchange', onResize);
                if (window.visualViewport) {
                    window.visualViewport.removeEventListener('resize', onResize);
                    window.visualViewport.removeEventListener('scroll', onResize);
                }
                overlay.remove();
                $(document).off('keydown.aqsmodal');
            };
            document.body.style.overflow = 'hidden';
            document.body.style.touchAction = 'none';
            document.documentElement.style.overflow = 'hidden';
            // 弹窗挂在 html 上，点击事件若冒泡到 document，酒馆会判定"点击了面板外部"
            // 而关闭整个扩展设置面板，导致选完模型被踢回主界面 —— 全部拦截
            overlay.on('pointerdown pointerup mousedown mouseup click touchstart touchend wheel', (e) => {
                e.stopPropagation();
                if ((e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart') && e.target === overlay[0]) close();
            });
            // 列表内部允许滚动，外层不滚动页面
            overlay.find('.aqs-modal-list').on('touchmove wheel', (e) => e.stopPropagation());
            overlay.find('.aqs-modal-close').on('click keydown', (e) => {
                if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    close();
                }
            });
            $(document).on('keydown.aqsmodal', (e) => { if (e.key === 'Escape') close(); });

            const list = overlay.find('.aqs-modal-list');
            const showError = (msg) => {
                list.empty();
                const box = $('<div class="aqs-empty aqs-modal-error"></div>');
                box.append($('<div></div>').text(String(msg || '获取失败')));
                $('<button type="button" class="menu_button aqs-btn aqs-btn-primary" style="margin-top:12px;">重试</button>')
                    .on('click', () => {
                        list.html('<div class="aqs-modal-loading"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp; SCANNING…</div>');
                        relayout();
                        doFetch();
                    })
                    .appendTo(box);
                list.append(box);
                relayout();
            };

            const doFetch = () => {
                fetchModelList(url, key)
                    .then((models) => {
                        const render = (filter) => {
                            list.empty();
                            const f = String(filter || '').toLowerCase();
                            const subset = models.filter((m) => m.toLowerCase().includes(f));
                            if (!subset.length) {
                                list.append($('<div class="aqs-empty">没有匹配的模型</div>'));
                                relayout();
                                return;
                            }
                            for (const m of subset) {
                                $('<div class="aqs-modal-item" tabindex="0" role="option"></div>').text(m)
                                    .css({ color: '#ffffff', webkitTextFillColor: '#ffffff', opacity: 1 })
                                    .on('click', () => { close(); onPick(m); })
                                    .on('keydown', (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            close();
                                            onPick(m);
                                        }
                                    })
                                    .appendTo(list);
                            }
                            relayout();
                        };
                        render('');
                        overlay.find('.aqs-modal-filter').off('input.aqs').on('input.aqs', function () { render(this.value); });
                        relayout();
                        setTimeout(relayout, 40);
                        toastr.success('共 ' + models.length + ' 个模型', 'API 快切');
                    })
                    .catch((err) => {
                        console.error('[API快切] 获取模型失败', err);
                        const msg = humanizeFetchErr(String(err && err.message || err));
                        toastr.error(msg, '获取模型失败');
                        showError(msg);
                    });
            };
            doFetch();
        }

        /* ---------------- 分页 / 列表 ---------------- */
        const PAGE_SIZE = 4;

        function pageCount(total) {
            return Math.max(1, Math.ceil(Math.max(0, total) / PAGE_SIZE));
        }

        function clampPage(page, total) {
            return Math.min(Math.max(0, page | 0), pageCount(total) - 1);
        }

        function slicePage(items, page) {
            const p = clampPage(page, items.length);
            const start = p * PAGE_SIZE;
            return { page: p, items: items.slice(start, start + PAGE_SIZE), total: items.length, pages: pageCount(items.length) };
        }

        function makePager(page, total, onChange) {
            const pages = pageCount(total);
            if (total <= PAGE_SIZE) return $();
            const bar = $('<div class="aqs-pager"></div>');
            const prev = $('<button type="button" class="menu_button aqs-btn aqs-pager-btn" title="上一页"><i class="fa-solid fa-chevron-left"></i></button>')
                .prop('disabled', page <= 0)
                .on('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (page <= 0) return;
                    onChange(page - 1);
                });
            const info = $('<span class="aqs-pager-info"></span>').text((page + 1) + ' / ' + pages + ' · ' + total);
            const next = $('<button type="button" class="menu_button aqs-btn aqs-pager-btn" title="下一页"><i class="fa-solid fa-chevron-right"></i></button>')
                .prop('disabled', page >= pages - 1)
                .on('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (page >= pages - 1) return;
                    onChange(page + 1);
                });
            bar.append(prev, info, next);
            return bar;
        }

        function orderedProfiles() {
            const out = [];
            settings.profiles.filter((p) => !p.group).forEach((p) => out.push(p));
            for (const g of groupNames()) {
                settings.profiles.filter((p) => p.group === g).forEach((p) => out.push(p));
            }
            return out;
        }

        /* ---------------- 设置面板：配置卡片 ---------------- */
        function profileCard(p) {
            const active = isActive(p);
            const card = $('<div class="aqs-card"></div>').toggleClass('aqs-active', active);

            const head = $('<div class="aqs-card-head"></div>');
            $('<span class="aqs-dot"></span>').appendTo(head);
            $('<span class="aqs-card-name"></span>').text(p.name).appendTo(head);
            if (active) $('<span class="aqs-badge">LINKED</span>').appendTo(head);
            card.append(head);

            $('<div class="aqs-card-url"></div>').text(p.url).appendTo(card);

            const meta = $('<div class="aqs-card-meta"></div>');
            if (p.model) $('<span class="aqs-chip aqs-chip-model"></span>').text(p.model).attr('title', p.model).appendTo(meta);
            $('<span class="aqs-chip aqs-chip-dim"></span>').text(p.key ? 'KEY ✓' : 'NO KEY').appendTo(meta);
            card.append(meta);

            const btns = $('<div class="aqs-card-btns"></div>');
            $('<button class="menu_button aqs-btn aqs-btn-primary" title="切换到此配置"><i class="fa-solid fa-plug"></i> 使用</button>')
                .on('click', () => applyProfile(p)).appendTo(btns);
            $('<button class="menu_button aqs-btn" title="从该接口获取模型列表并选择"><i class="fa-solid fa-microchip"></i></button>')
                .on('click', () => openModelPicker(p.url, p.key, (m) => {
                    p.model = m;
                    save();
                    renderAll();
                    if (isActive(p)) {
                        applyProfile(p);
                    } else {
                        toastr.success('已为「' + p.name + '」选择模型：' + m);
                    }
                })).appendTo(btns);
            $('<button class="menu_button aqs-btn" title="编辑"><i class="fa-solid fa-pen"></i></button>')
                .on('click', () => startEdit(p)).appendTo(btns);
            $('<button class="menu_button aqs-btn aqs-danger" title="删除"><i class="fa-solid fa-trash"></i></button>')
                .on('click', () => {
                    if (!confirm('确定删除「' + p.name + '」？')) return;
                    settings.profiles = settings.profiles.filter((x) => x.id !== p.id);
                    if (editingId === p.id) resetForm();
                    save();
                    renderAll();
                }).appendTo(btns);
            card.append(btns);

            return card;
        }

        function groupNames() {
            const set = new Set();
            settings.profiles.forEach((p) => { if (p.group) set.add(p.group); });
            return [...set];
        }

        /* ---- 分组选择器：点选已有分组，或切到输入框新建，两种操作分离不打架 ---- */
        let groupPick = '';
        let groupTyping = false;

        function currentGroupValue() {
            return groupTyping ? String($('#aqs_group').val() || '').trim() : groupPick;
        }

        function setGroupState(pick, typing, typedVal) {
            groupPick = pick || '';
            groupTyping = !!typing;
            const input = $('#aqs_group');
            if (groupTyping) input.show().val(typedVal || '');
            else input.hide().val('');
            renderGroupPicker();
        }

        function renderGroupPicker() {
            const box = $('#aqs_group_picker');
            if (!box.length) return;
            box.empty();
            const names = groupNames();
            // 表单里的分组芯片超过 4 个也分页，避免手机/平板一长串
            const raw = settings.pages.list.__picker__ || 0;
            const cur = clampPage(raw, names.length);
            if (raw !== cur) {
                settings.pages.list.__picker__ = cur;
                save();
            } else {
                settings.pages.list.__picker__ = cur;
            }
            const sliced = slicePage(names, cur);
            for (const g of sliced.items) {
                $('<button type="button" class="aqs-gchip"></button>').text(g)
                    .toggleClass('aqs-gchip-on', !groupTyping && groupPick === g)
                    .on('click', () => {
                        if (!groupTyping && groupPick === g) setGroupState('', false);
                        else setGroupState(g, false);
                    })
                    .appendTo(box);
            }
            $('<button type="button" class="aqs-gchip aqs-gchip-add"><i class="fa-solid fa-plus"></i>&nbsp;新分组</button>')
                .toggleClass('aqs-gchip-on', groupTyping)
                .on('click', () => {
                    if (groupTyping) { setGroupState('', false); return; }
                    setGroupState('', true);
                    setTimeout(() => $('#aqs_group').trigger('focus'), 60);
                })
                .appendTo(box);
            const pager = makePager(sliced.page, sliced.total, (np) => {
                settings.pages.list.__picker__ = np;
                save();
                renderGroupPicker();
            });
            if (pager && pager.length) box.append(pager);
        }

        function appendPagedCards($host, items, pageKey, rerender) {
            const raw = settings.pages.list[pageKey] || 0;
            const cur = clampPage(raw, items.length);
            if (raw !== cur) {
                settings.pages.list[pageKey] = cur;
                save();
            } else {
                settings.pages.list[pageKey] = cur;
            }
            const sliced = slicePage(items, cur);
            sliced.items.forEach((p) => $host.append(profileCard(p)));
            const pager = makePager(sliced.page, sliced.total, (np) => {
                settings.pages.list[pageKey] = np;
                save();
                rerender();
            });
            if (pager && pager.length) $host.append(pager);
        }

        function makeGroupBox(g) {
            const items = settings.profiles.filter((p) => p.group === g);
            const collapsed = !!settings.groupCollapsed[g];
            const box = $('<div class="aqs-group"></div>').toggleClass('aqs-collapsed', collapsed);
            const head = $('<div class="aqs-group-head" title="点击展开/收起"></div>');
            $('<i class="fa-solid fa-chevron-down aqs-group-chevron"></i>').appendTo(head);
            $('<span class="aqs-group-name"></span>').text(g).appendTo(head);
            if (items.some(isActive)) $('<span class="aqs-group-live" title="当前连接在此分组"></span>').appendTo(head);
            $('<span class="aqs-group-count"></span>').text(items.length).appendTo(head);
            head.on('click', () => {
                settings.groupCollapsed[g] = !settings.groupCollapsed[g];
                save();
                renderList();
            });
            box.append(head);
            const body = $('<div class="aqs-group-body"></div>');
            // 组内站点仍按 4 条分页，避免展开后一长串
            if (!collapsed) appendPagedCards(body, items, g, renderList);
            box.append(body);
            return box;
        }

        function renderList() {
            const list = $('#aqs_profile_list').empty();
            const names = groupNames();
            for (const k of Object.keys(settings.groupCollapsed)) {
                if (!names.includes(k)) delete settings.groupCollapsed[k];
            }
            // 站点页 __sites__ / 组页 __groups__ / 表单芯片 __picker__ / 组内页码用分组名
            // 兼容清理旧版 __main__ 等失效键
            const keepKeys = new Set(['__sites__', '__groups__', '__picker__', ...names]);
            for (const k of Object.keys(settings.pages.list)) {
                if (keepKeys.has(k)) continue;
                delete settings.pages.list[k];
            }
            renderGroupPicker();
            if (!settings.profiles.length) {
                list.append($('<div class="aqs-empty">还没有站点，在下方添加第一个吧</div>'));
                return;
            }

            // 分层分页，保证整齐：
            // 1) 未分组站点 >4 → 在「站点层」分页
            // 2) 分组数 >4 → 在「组层」分页（折叠时也只显示当前页的组头）
            // 3) 组内站点 >4 → 展开后在组内分页
            // 不把站点与组混成一条流水线，避免布局忽长忽短
            const ungrouped = settings.profiles.filter((p) => !p.group);
            if (ungrouped.length) {
                const sitesWrap = $('<div class="aqs-list-section aqs-list-sites"></div>');
                appendPagedCards(sitesWrap, ungrouped, '__sites__', renderList);
                list.append(sitesWrap);
            }

            if (names.length) {
                const groupsWrap = $('<div class="aqs-list-section aqs-list-groups"></div>');
                const raw = settings.pages.list.__groups__ || 0;
                const cur = clampPage(raw, names.length);
                if (raw !== cur) {
                    settings.pages.list.__groups__ = cur;
                    save();
                } else {
                    settings.pages.list.__groups__ = cur;
                }
                const sliced = slicePage(names, cur);
                for (const g of sliced.items) {
                    groupsWrap.append(makeGroupBox(g));
                }
                const pager = makePager(sliced.page, sliced.total, (np) => {
                    settings.pages.list.__groups__ = np;
                    save();
                    renderList();
                });
                if (pager && pager.length) groupsWrap.append(pager);
                list.append(groupsWrap);
            }
        }

        /* renderAll 在快捷面板段重定义，同步刷新嵌入面板 */

        /* ---------------- 表单 ---------------- */
        function startEdit(p) {
            editingId = p.id;
            $('#aqs_name').val(p.name);
            $('#aqs_url').val(p.url);
            $('#aqs_key').val(p.key || '');
            $('#aqs_model').val(p.model || '');
            if (p.group && groupNames().includes(p.group)) setGroupState(p.group, false);
            else if (p.group) setGroupState('', true, p.group);
            else setGroupState('', false);
            $('#aqs_form_title').text('编辑：' + p.name);
            $('#aqs_save').html('<i class="fa-solid fa-floppy-disk"></i> 保存修改');
            $('#aqs_cancel_edit').show();
            const t = $('#aqs_form_title')[0];
            if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function resetForm() {
            editingId = null;
            $('#aqs_name, #aqs_url, #aqs_key, #aqs_model').val('');
            setGroupState('', false);
            $('#aqs_form_title').text('新增站点');
            $('#aqs_save').html('<i class="fa-solid fa-plus"></i> 保存站点');
            $('#aqs_cancel_edit').hide();
        }

        function onSave() {
            const name = String($('#aqs_name').val() || '').trim();
            const url = normUrl($('#aqs_url').val());
            const key = String($('#aqs_key').val() || '').trim();
            const model = String($('#aqs_model').val() || '').trim();
            const group = currentGroupValue();

            if (!name || !url) { toastr.warning('名称和 URL 必填'); return; }
            if (!/^https?:\/\//i.test(url)) { toastr.warning('URL 需要以 http:// 或 https:// 开头'); return; }

            if (editingId) {
                const p = settings.profiles.find((x) => x.id === editingId);
                if (!p) { resetForm(); return; }
                const dup = settings.profiles.find((x) => x.name === name && x.id !== editingId);
                if (dup) { toastr.warning('已存在同名站点「' + name + '」'); return; }
                Object.assign(p, { name, url, key, model, group });
                toastr.success('已更新「' + name + '」');
            } else {
                const dup = settings.profiles.find((x) => x.name === name);
                if (dup) {
                    if (!confirm('已存在同名站点「' + name + '」，覆盖它吗？')) return;
                    Object.assign(dup, { url, key, model, group });
                    toastr.success('已覆盖「' + name + '」');
                } else {
                    settings.profiles.push({ id: uid(), name, url, key, model, group });
                    toastr.success('已保存「' + name + '」');
                }
            }
            save();
            resetForm();
            renderAll();
        }

        /* ---------------- 导入 / 导出 ---------------- */
        function exportProfiles() {
            if (!settings.profiles.length) { toastr.warning('没有可导出的站点'); return; }
            const data = JSON.stringify({ app: 'st-api-switcher', version: 2, profiles: settings.profiles }, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'st-api-switcher-backup.json';
            a.click();
            URL.revokeObjectURL(a.href);
            toastr.info('备份文件包含明文 Key，请妥善保管', '已导出');
        }

        function importProfiles(file) {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(String(reader.result));
                    const arr = Array.isArray(data) ? data : data.profiles;
                    if (!Array.isArray(arr)) throw new Error('文件格式不正确');
                    let added = 0, updated = 0;
                    for (const item of arr) {
                        if (!item || typeof item.name !== 'string' || typeof item.url !== 'string') continue;
                        const clean = {
                            name: item.name.trim(),
                            url: normUrl(item.url),
                            key: typeof item.key === 'string' ? item.key : '',
                            model: typeof item.model === 'string' ? item.model : '',
                            group: typeof item.group === 'string' ? item.group.trim() : '',
                        };
                        if (!clean.name || !clean.url) continue;
                        const dup = settings.profiles.find((x) => x.name === clean.name);
                        if (dup) { Object.assign(dup, clean); updated++; }
                        else { settings.profiles.push({ id: uid(), ...clean }); added++; }
                    }
                    save();
                    renderAll();
                    toastr.success(`新增 ${added} 个，更新 ${updated} 个`, '导入完成');
                } catch (err) {
                    toastr.error(String(err && err.message || err), '导入失败');
                }
            };
            reader.readAsText(file);
        }

        /* ---------------- 快捷面板 / 插头嵌入 ---------------- */
        function buildProfileItems($root, { closeOnClick, pageKey } = {}) {
            $root.empty();
            if (!settings.profiles.length) {
                $root.append($('<div class="aqs-empty">先去扩展设置里添加站点</div>'));
                return;
            }

            const flat = orderedProfiles();
            const key = pageKey || 'embed';
            const raw = settings.pages[key] || 0;
            const cur = clampPage(raw, flat.length);
            if (raw !== cur) {
                settings.pages[key] = cur;
                save();
            } else {
                settings.pages[key] = cur;
            }
            const sliced = slicePage(flat, cur);

            const addItem = (p) => {
                const item = $('<div class="aqs-qp-item"></div>').toggleClass('aqs-active', isActive(p));
                const main = $('<div class="aqs-qp-main"></div>').appendTo(item);
                $('<span class="aqs-qp-name"></span>').text(p.name).appendTo(main);
                if (p.model) $('<span class="aqs-qp-model"></span>').text(p.model).attr('title', p.model).appendTo(main);
                item.attr('title', p.model ? (p.name + ' · ' + p.model) : p.name);
                item.on('pointerdown mousedown touchstart click', async (e) => {
                    // down 阶段只拦冒泡，避免魔法棒菜单被当成点外部关掉；勿 preventDefault，否则手机可能不出 click
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    if (e.type !== 'click') return;
                    e.preventDefault();
                    // 快捷面板保持打开，便于连续切换；点面板外 / 标题叉号 / Esc 才关闭
                    await applyProfile(p);
                });
                $root.append(item);
            };

            let lastGroup = null;
            sliced.items.forEach((p) => {
                const g = p.group || '';
                if (g) {
                    if (g !== lastGroup) {
                        $('<div class="aqs-qp-group"></div>').text(g).appendTo($root);
                        lastGroup = g;
                    }
                } else {
                    lastGroup = '';
                }
                addItem(p);
            });

            const pager = makePager(sliced.page, sliced.total, (np) => {
                settings.pages[key] = np;
                save();
                if (key === 'quick') {
                    renderQuickPanel();
                    const anchor = document.getElementById('aqs_wand_btn');
                    requestAnimationFrame(() => layoutQuickPanel(anchor));
                } else renderApiEmbed();
            });
            if (pager && pager.length) $root.append(pager);
        }

        function layoutQuickPanel(anchorEl) {
            const panel = $('#aqs_quick_panel');
            const el = panel[0];
            if (!el || !panel.is(':visible')) return;
            if (el.parentElement !== document.documentElement) {
                document.documentElement.appendChild(el);
            }

            const { vw, vh } = viewportSize();
            const isPhone = vw < 700;
            const isTablet = vw >= 700 && vw < 1100;
            const pad = isPhone ? 8 : 12;
            const gap = 8;

            // 清掉 CSS 默认 bottom/left/animation/transform，避免和 top 打架、被菜单半透明层盖住
            el.style.cssText = [
                'display:block',
                'position:fixed',
                'z-index:2147483646',
                'visibility:visible',
                'opacity:1',
                'pointer-events:auto',
                'box-sizing:border-box',
                'transform:none',
                'animation:none',
                'margin:0',
                'isolation:isolate',
                'bottom:auto',
                'right:auto',
            ].map((s) => s + ' !important').join(';') + ';';

            const maxW = Math.min(isPhone ? Math.min(vw - pad * 2, 360) : (isTablet ? 380 : 400), vw - pad * 2);
            const minW = Math.min(260, maxW);
            const maxH = Math.max(160, Math.min(Math.round(vh * (isPhone ? 0.55 : 0.52)), vh - pad * 2));
            el.style.setProperty('width', maxW + 'px', 'important');
            el.style.setProperty('min-width', minW + 'px', 'important');
            el.style.setProperty('max-width', maxW + 'px', 'important');
            el.style.setProperty('max-height', maxH + 'px', 'important');
            el.style.setProperty('overflow-y', 'auto', 'important');
            el.style.setProperty('overflow-x', 'hidden', 'important');
            el.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
            el.style.setProperty('overscroll-behavior', 'contain', 'important');
            el.style.setProperty('touch-action', 'pan-y', 'important');

            // 临时放到安全区再量高，避免 hidden/动画未完成时高度飘
            el.style.setProperty('top', pad + 'px', 'important');
            el.style.setProperty('left', pad + 'px', 'important');
            void el.offsetHeight;
            const ph = Math.max(120, Math.min(el.scrollHeight || el.offsetHeight || 200, maxH));
            const pw = el.offsetWidth || maxW;

            let menuRect = null;
            if (anchorEl && anchorEl.getBoundingClientRect) {
                try {
                    const menu = (anchorEl.closest && anchorEl.closest(
                        '#extensionsMenu, #extensions_menu, .extensions_menu, .list-group, [id*="extensionsMenu"]'
                    )) || anchorEl;
                    menuRect = menu.getBoundingClientRect();
                } catch {
                    menuRect = anchorEl.getBoundingClientRect();
                }
            }

            let top;
            let left;
            if (menuRect && menuRect.width) {
                const rightOf = menuRect.right + gap;
                const leftOf = menuRect.left - pw - gap;
                const below = menuRect.bottom + gap;
                const above = menuRect.top - ph - gap;
                // 优先：菜单右侧（平板最容易被菜单半透明层盖住的就是「叠在菜单上」）
                if (rightOf + pw <= vw - pad) {
                    left = rightOf;
                    top = Math.max(pad, Math.min(menuRect.top, vh - ph - pad));
                } else if (below + Math.min(ph, 120) <= vh - pad) {
                    // 菜单下方：整块躲开菜单纵向范围
                    left = Math.max(pad, Math.min(menuRect.left, vw - pw - pad));
                    top = below;
                } else if (leftOf >= pad) {
                    left = leftOf;
                    top = Math.max(pad, Math.min(menuRect.top, vh - ph - pad));
                } else if (above >= pad) {
                    left = Math.max(pad, Math.min(menuRect.left, vw - pw - pad));
                    top = above;
                } else {
                    left = pad;
                    top = Math.max(pad, Math.min(vh - ph - pad, below));
                }
            } else {
                top = Math.max(pad, vh - ph - (isPhone ? 88 : 96));
                left = pad;
            }

            top = Math.max(pad, Math.min(top, vh - Math.min(ph, maxH) - pad));
            left = Math.max(pad, Math.min(left, vw - pw - pad));

            // 最后再做一次与菜单矩形的碰撞检测；仍重叠则硬推到右侧/下方
            if (menuRect && menuRect.width) {
                const intersects = !(
                    left + pw <= menuRect.left - 2 ||
                    left >= menuRect.right + 2 ||
                    top + ph <= menuRect.top - 2 ||
                    top >= menuRect.bottom + 2
                );
                if (intersects) {
                    if (menuRect.right + gap + pw <= vw - pad) {
                        left = menuRect.right + gap;
                        top = Math.max(pad, Math.min(menuRect.top, vh - ph - pad));
                    } else if (menuRect.bottom + gap + Math.min(ph, 140) <= vh - pad) {
                        top = menuRect.bottom + gap;
                        left = Math.max(pad, Math.min(left, vw - pw - pad));
                    } else {
                        // 实在挤：贴视口右下，仍保持最高 z-index
                        left = Math.max(pad, vw - pw - pad);
                        top = Math.max(pad, vh - ph - pad);
                    }
                    top = Math.max(pad, Math.min(top, vh - Math.min(ph, maxH) - pad));
                    left = Math.max(pad, Math.min(left, vw - pw - pad));
                }
            }

            el.style.setProperty('top', Math.round(top) + 'px', 'important');
            el.style.setProperty('left', Math.round(left) + 'px', 'important');
            el.style.setProperty('right', 'auto', 'important');
            el.style.setProperty('bottom', 'auto', 'important');
            el.setAttribute('data-aqs-qp-layout', vw + 'x' + vh + '@' + Math.round(top) + ',' + Math.round(left));
        }

        function openQuickPanel(anchorEl) {
            const panel = $('#aqs_quick_panel');
            if (!panel.length) return;
            // 先抬到 html 根再渲染/显示，避免第一次打开仍在 body 里被菜单层盖住
            if (panel[0].parentElement !== document.documentElement) {
                document.documentElement.appendChild(panel[0]);
            }
            renderQuickPanel();
            panel.show();
            const relayout = () => {
                try { layoutQuickPanel(anchorEl); } catch (e) { console.error('[API快切] qp layout', e); }
            };
            relayout();
            requestAnimationFrame(() => {
                relayout();
                requestAnimationFrame(relayout);
            });
            // 触屏/WebView 首帧内容高度常偏小，多拍几次消除「点一次歪、点两次才正」
            setTimeout(relayout, 16);
            setTimeout(relayout, 50);
            setTimeout(relayout, 120);
            setTimeout(relayout, 280);
            setTimeout(relayout, 480);
        }

        function closeQuickPanel() {
            $('#aqs_quick_panel').hide();
        }

        function renderQuickPanel() {
            const panel = $('#aqs_quick_panel');
            if (!panel.length) return;
            buildProfileItems(panel, { closeOnClick: false, pageKey: 'quick' });
            const $title = $('<div class="aqs-qp-title"></div>');
            $title.append($('<span class="aqs-qp-title-text"><i class="fa-solid fa-shuffle"></i> API·SWITCH</span>'));
            const $close = $('<button type="button" class="aqs-qp-close" title="关闭快切（不关魔法棒菜单）" aria-label="关闭快切"><i class="fa-solid fa-xmark"></i></button>');
            // 必须拦截 pointerdown/mousedown：酒馆魔法棒菜单多半在 down 阶段判定「点外部」并整菜单关闭
            $close.on('pointerdown mousedown touchstart pointerup mouseup click touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                if (e.type === 'click' && $close.data('aqs-ptr-handled')) return;
                if (e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart') {
                    if (e.type === 'pointerdown' && e.pointerType === 'mouse' && e.button !== 0) return;
                    if (e.type === 'mousedown' && e.button !== 0) return;
                    $close.data('aqs-ptr-handled', 1);
                    setTimeout(() => $close.removeData('aqs-ptr-handled'), 400);
                    closeQuickPanel();
                }
            });
            $title.append($close);
            panel.prepend($title);
        }

        function renderApiEmbed() {
            const body = $('#aqs_api_embed_body');
            if (!body.length) return;
            buildProfileItems(body, { closeOnClick: false, pageKey: 'embed' });
            const n = settings.profiles.length;
            $('#aqs_api_embed_count').text(n ? (n + ' 站') : '空');
        }

        function ensureApiEmbed() {
            if ($('#aqs_api_embed').length) return true;
            const host = $('#rm_api_block');
            if (!host.length) return false;

            const box = $(`
                <div id="aqs_api_embed" class="aqs-api-embed">
                    <div class="aqs-api-embed-head">
                        <div class="aqs-api-embed-title">
                            <i class="fa-solid fa-shuffle aqs-grad-icon"></i>
                            <span>API 快切</span>
                            <span class="aqs-api-embed-ver">v${VERSION}</span>
                        </div>
                        <div class="aqs-api-embed-actions">
                            <span id="aqs_api_embed_count" class="aqs-chip aqs-chip-dim">空</span>
                            <div id="aqs_api_embed_refresh" class="menu_button menu_button_icon aqs-btn" title="刷新列表">
                                <i class="fa-solid fa-rotate"></i>
                            </div>
                            <div id="aqs_api_embed_toggle" class="menu_button menu_button_icon aqs-btn" title="展开/收起">
                                <i class="fa-solid fa-chevron-up"></i>
                            </div>
                        </div>
                    </div>
                    <div id="aqs_api_embed_body" class="aqs-api-embed-body"></div>
                    <div class="aqs-api-embed-foot">
                        <span class="aqs-note" style="margin:0">点站点即可切换 · 完整管理在「扩展」面板</span>
                    </div>
                </div>
            `);

            // 插到 API 抽屉标题下方，作为主入口
            const title = host.children('h3').first();
            if (title.length) title.after(box);
            else host.prepend(box);

            $('#aqs_api_embed_refresh').on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                renderApiEmbed();
                toastr.info('已刷新站点列表', 'API 快切');
            });
            $('#aqs_api_embed_toggle').on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const collapsed = $('#aqs_api_embed').toggleClass('aqs-collapsed').hasClass('aqs-collapsed');
                $('#aqs_api_embed_toggle i')
                    .toggleClass('fa-chevron-up', !collapsed)
                    .toggleClass('fa-chevron-down', collapsed);
            });

            renderApiEmbed();
            return true;
        }

        function findExtensionsMenu() {
            const candidates = [
                '#extensionsMenu',
                '#extensions_menu',
                '.extensions_menu',
                '#rm_button_panel_extensions_menu',
                '#extensionsMenuButton + div',
                '[id*="extensionsMenu"]',
            ];
            for (const sel of candidates) {
                const $m = $(sel).first();
                if ($m.length) return $m;
            }
            // 兜底：找含 extension_container 的菜单
            const $c = $('.extension_container').first().parent();
            if ($c.length) return $c;
            return $();
        }

        function injectWand() {
            if ($('#aqs_wand_btn').length) return true;
            const menu = findExtensionsMenu();
            if (!menu.length) return false;

            // 与角色卡/世界书插件同一结构：list-group-item + i + span，避免被容器裁切成 ...
            const btn = $(
                '<div id="aqs_wand_btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="API 快切">' +
                '<i class="fa-solid fa-shuffle extensionsMenuExtensionButton"></i>' +
                '<span class="aqs-wand-label">API 快切</span></div>'
            );
            btn.on('pointerup click', function (e) {
                // 手机端优先 pointerup；忽略后续合成 click，避免开了又关
                if (e.type === 'click' && btn.data('aqs-ptr-handled')) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (e.type === 'pointerup') {
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    btn.data('aqs-ptr-handled', 1);
                    setTimeout(() => btn.removeData('aqs-ptr-handled'), 400);
                }
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                const panel = $('#aqs_quick_panel');
                if (panel.is(':visible')) {
                    closeQuickPanel();
                    return;
                }
                // 锚点用按钮本身；布局时面板会抬到菜单之上，避免被半透明菜单层挡住
                openQuickPanel(this);
            });

            // 与其他扩展一致：直接 append 到 #extensionsMenu
            menu.append(btn);
            return true;
        }

        function ensureFloatingPanel() {
            if ($('#aqs_quick_panel').length) return;
            // 挂到 <html>，与模型弹窗一致，避免被 #extensionsMenu 的 stacking / overflow 裁切遮挡
            const $panel = $('<div id="aqs_quick_panel" style="display:none;"></div>');
            $(document.documentElement).append($panel);
            // 面板不在魔法棒菜单 DOM 内；若不拦截冒泡，酒馆会当成「点菜单外」把整菜单关掉
            // X / 列表点击只应关快切或切站，不能连带关魔法棒
            $panel.on('pointerdown pointerup mousedown mouseup click touchstart touchend wheel', (e) => {
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            });
            // pointerdown 比 mousedown/touchstart 更稳；点面板外才关快切（魔法棒是否关由酒馆自己判定）
            $(document).on('pointerdown.aqs_qp touchstart.aqs_qp', (e) => {
                // touchstart 兜底老 WebView；pointer 事件下 touchstart 可能连发，用 data 去重
                if (e.type === 'touchstart' && window.PointerEvent) return;
                const $t = $(e.target);
                if ($t.closest('#aqs_quick_panel, #aqs_wand_btn').length) return;
                closeQuickPanel();
            });
            $(document).on('keydown.aqs_qp', (e) => {
                if (e.key === 'Escape' && $('#aqs_quick_panel').is(':visible')) {
                    closeQuickPanel();
                }
            });
            // 视口变化时若面板开着，重算位置（旋转平板最容易歪）
            const onVp = () => {
                const panel = $('#aqs_quick_panel');
                if (!panel.is(':visible')) return;
                const anchor = document.getElementById('aqs_wand_btn');
                layoutQuickPanel(anchor);
            };
            window.addEventListener('resize', onVp);
            window.addEventListener('orientationchange', onVp);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', onVp);
                window.visualViewport.addEventListener('scroll', onVp);
            }
        }

        function watchUiHosts() {
            ensureFloatingPanel();
            ensureApiEmbed();
            injectWand();

            // 手机 ST 上魔法棒菜单 / API 抽屉可能晚于扩展脚本出现
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                const okWand = injectWand();
                const okEmbed = ensureApiEmbed();
                if ((okWand && okEmbed) || tries > 40) clearInterval(timer);
            }, 500);

            if (window.MutationObserver) {
                const mo = new MutationObserver(() => {
                    injectWand();
                    ensureApiEmbed();
                });
                mo.observe(document.body, { childList: true, subtree: true });
                // 60s 后停观察，避免长期开销；之后仍可靠 interval 前 20s 的结果
                setTimeout(() => mo.disconnect(), 60000);
            }

            // 打开 API 抽屉时强制刷新嵌入列表
            $(document).on('click.aqs_api_drawer', '#API-status-top, #sys-settings-button .drawer-toggle, #rm_api_block', () => {
                setTimeout(() => {
                    ensureApiEmbed();
                    renderApiEmbed();
                }, 50);
            });
        }

        /* 重写 renderAll：同步刷新快捷面板 + 插头嵌入 */
        function renderAll() {
            renderList();
            if ($('#aqs_quick_panel').is(':visible')) renderQuickPanel();
            renderApiEmbed();
        }

        /* ---------------- 设置面板 HTML ---------------- */
        const html = `
            <div class="aqs-settings">
              <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                  <b><i class="fa-solid fa-shuffle aqs-grad-icon"></i>&nbsp;API 快切</b>
                  <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                  <div class="aqs-sys-bar">
                    <span class="aqs-sys-id">API·SWITCH</span>
                    <span class="aqs-sys-ver">v${VERSION}</span>
                    <span class="aqs-blink">_</span>
                    <span class="aqs-sys-spacer"></span>
                    <div id="aqs_update_btn" class="menu_button menu_button_icon aqs-btn" title="检查 / 安装更新">
                      <i class="fa-solid fa-satellite-dish"></i> 检查更新
                    </div>
                  </div>
                  <hr class="aqs-hr">
                  <div id="aqs_profile_list"></div>
                  <hr class="aqs-hr">
                  <div class="aqs-form-title" id="aqs_form_title">新增站点</div>
                  <input id="aqs_name" class="text_pole" type="text" placeholder="名称（如：OpenRouter）" autocomplete="off">
                  <input id="aqs_url" class="text_pole" type="text" placeholder="API URL（https://.../v1）" autocomplete="off">
                  <input id="aqs_key" class="text_pole" type="password" placeholder="API Key" autocomplete="off">
                  <div class="aqs-model-row">
                    <input id="aqs_model" class="text_pole" type="text" placeholder="模型 ID（可留空）" autocomplete="off">
                    <div id="aqs_fetch_models" class="menu_button menu_button_icon aqs-btn" title="从接口拉取模型列表">
                      <i class="fa-solid fa-list"></i> 获取模型
                    </div>
                  </div>
                  <div class="aqs-field-label">分组</div>
                  <div id="aqs_group_picker"></div>
                  <input id="aqs_group" class="text_pole" type="text" placeholder="输入新分组名" autocomplete="off" style="display:none;">
                  <div class="aqs-form-btns">
                    <div id="aqs_save" class="menu_button menu_button_icon aqs-btn aqs-btn-primary">
                      <i class="fa-solid fa-plus"></i> 保存站点
                    </div>
                    <div id="aqs_cancel_edit" class="menu_button menu_button_icon aqs-btn" style="display:none;">
                      取消编辑
                    </div>
                  </div>
                  <div class="aqs-io-btns">
                    <div id="aqs_export" class="menu_button menu_button_icon aqs-btn">
                      <i class="fa-solid fa-file-export"></i> 导出
                    </div>
                    <div id="aqs_import" class="menu_button menu_button_icon aqs-btn">
                      <i class="fa-solid fa-file-import"></i> 导入
                    </div>
                    <input id="aqs_import_file" type="file" accept="application/json,.json" style="display:none;">
                  </div>
                  <span class="aqs-note">
                    手机端主入口：点顶部「插头 / API Connections」即可快切；魔法棒菜单为快捷入口。
                    切换后若密钥未生效，可到 API 页点一次 Connect。
                  </span>
                </div>
              </div>
            </div>
        `;

        ctx.extensionSettings[MODULE] = settings;
        const $settingsHost = () => ($('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings'));
        const container = $settingsHost();
        if (container.length) {
            // 插到扩展设置顶部，与其他插件一致使用 inline-drawer 可整块收起
            container.prepend(html);
        } else {
            // 某些移动端壳子设置面板晚挂载
            const waitSettings = setInterval(() => {
                const c = $settingsHost();
                if (!c.length) return;
                clearInterval(waitSettings);
                if (!$('.aqs-settings').length) c.prepend(html);
                bindSettingsUi();
                renderList();
            }, 400);
            setTimeout(() => clearInterval(waitSettings), 20000);
        }

        function bindSettingsUi() {
            $('#aqs_save').off('click.aqs').on('click.aqs', onSave);
            $('#aqs_cancel_edit').off('click.aqs').on('click.aqs', resetForm);
            $('#aqs_export').off('click.aqs').on('click.aqs', exportProfiles);
            $('#aqs_import').off('click.aqs').on('click.aqs', () => $('#aqs_import_file').trigger('click'));
            $('#aqs_import_file').off('change.aqs').on('change.aqs', function () {
                if (this.files && this.files[0]) importProfiles(this.files[0]);
                this.value = '';
            });
            $('#aqs_fetch_models').off('click.aqs').on('click.aqs', () => {
                openModelPicker($('#aqs_url').val(), $('#aqs_key').val(), (m) => {
                    $('#aqs_model').val(m);
                    toastr.success('已选择：' + m, 'API 快切');
                });
            });
            $('#aqs_update_btn').off('click.aqs').on('click.aqs', async () => {
                if (updState === 'available' || updState === 'updated') await doUpdate();
                else await checkUpdate(false);
            });
        }
        bindSettingsUi();


        // 替换旧的 renderAll 定义：上面已经有新 renderAll，删除后面的重复定义依赖
        // 初始化 UI 宿主
        watchUiHosts();
        renderList();
        setTimeout(() => checkUpdate(true), 3000);

        console.log('[API快切] v' + VERSION + ' 已加载');
    });
})();
