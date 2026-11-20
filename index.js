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
    const VERSION = '4.0.0';
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
        // 只补全结构，绝不因 profiles 异常而整包清空（避免误伤其它字段）
        if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
            ctx.extensionSettings[MODULE] = { profiles: [] };
        }
        const settings = ctx.extensionSettings[MODULE];
        const save = () => ctx.saveSettingsDebounced();
        const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        function uniqStrings(items) {
            const out = [];
            const seen = new Set();
            for (const item of items || []) {
                const v = String(item || '').trim();
                if (!v || seen.has(v)) continue;
                seen.add(v);
                out.push(v);
            }
            return out;
        }
        function splitModelValues(...values) {
            const out = [];
            for (const value of values) {
                if (Array.isArray(value)) out.push(...value);
                else out.push(...String(value || '').split(/[\n,，;；]+/));
            }
            return uniqStrings(out);
        }
        if (!Array.isArray(settings.profiles)) settings.profiles = [];
        if (!settings.groupCollapsed || typeof settings.groupCollapsed !== 'object') settings.groupCollapsed = {};
        if (!settings.modelCollapsed || typeof settings.modelCollapsed !== 'object') settings.modelCollapsed = {};
        if (!Array.isArray(settings.secretIds)) settings.secretIds = [];
        settings.secretIds = uniqStrings(settings.secretIds);
        if (typeof settings.autoSyncNative !== 'boolean') settings.autoSyncNative = true;
        if (!settings.pages || typeof settings.pages !== 'object') settings.pages = {};
        if (!settings.pages.list || typeof settings.pages.list !== 'object') settings.pages.list = {};
        if (typeof settings.pages.embed !== 'number' || settings.pages.embed < 0) settings.pages.embed = 0;
        if (typeof settings.pages.quick !== 'number' || settings.pages.quick < 0) settings.pages.quick = 0;
        // 清洗脏数据：保证每条站点字段类型稳定；仅在实际改动时落盘
        const rawProfiles = Array.isArray(settings.profiles) ? settings.profiles : [];
        const cleanProfiles = rawProfiles
            .filter((p) => p && typeof p === 'object')
            .map((p) => {
                const models = splitModelValues(p.model, p.models);
                const model = models[0] || '';
                return {
                    id: typeof p.id === 'string' && p.id ? p.id : uid(),
                    name: String(p.name || '').trim() || '未命名',
                    url: String(p.url || '').trim().replace(/\/+$/, ''),
                    key: typeof p.key === 'string' ? p.key : String(p.key || ''),
                    model,
                    models,
                    group: typeof p.group === 'string' ? p.group.trim() : '',
                    favorite: p.favorite === true,
                };
            });
        const dirty = rawProfiles.length !== cleanProfiles.length || rawProfiles.some((p, i) => {
            const c = cleanProfiles[i];
            if (!p || !c) return true;
            return p.id !== c.id || String(p.name || '') !== c.name || String(p.url || '').replace(/\/+$/, '') !== c.url
                || String(p.key || '') !== c.key || splitModelValues(p.model, p.models).join('\n') !== c.models.join('\n')
                || String(p.group || '').trim() !== c.group;
        });
        settings.profiles = cleanProfiles;
        if (dirty) {
            try { save(); } catch { /* ignore */ }
        }

        let editingId = null;
        let searchQuery = '';  // 全局搜索关键词

        /* ---------------- 工具 ---------------- */
        const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
        function validApiUrl(value) {
            try {
                const url = new URL(value);
                return /^https?:\/\//i.test(value) && ['http:', 'https:'].includes(url.protocol)
                    && !url.username && !url.password && !url.search && !url.hash;
            } catch { return false; }
        }
        const currentUrl = () => $('#main_api').val() === 'openai' && $('#chat_completion_source').val() === 'custom'
            ? normUrl($('#custom_api_url_text').val()) : '';
        const currentModel = () => String($('#custom_model_id').val() || '').trim();
        const isActive = (p) => !!currentUrl() && currentUrl() === normUrl(p.url);
        const profileModels = (p) => splitModelValues(p && p.model, p && p.models);
        const matchSearch = (p) => {
            if (!searchQuery) return true;
            const q = searchQuery.toLowerCase();
            return p.name.toLowerCase().includes(q)
                || p.url.toLowerCase().includes(q)
                || profileModels(p).some((m) => m.toLowerCase().includes(q))
                || (p.group || '').toLowerCase().includes(q);
        };
        const isActiveChoice = (p, model) => isActive(p) && String(model || '') === currentModel();

        function setSelectValueIfNeeded(selector, value) {
            const $el = $(selector);
            if (!$el.length) return false;
            if (String($el.val() || '') === String(value || '')) return false;
            $el.val(value).trigger('change');
            return true;
        }

        async function waitForElement(selector, ms = 2500) {
            const deadline = Date.now() + ms;
            let $el = $(selector);
            while (!$el.length && Date.now() < deadline) {
                await sleep(50);
                $el = $(selector);
            }
            return $el;
        }

        function fetchTimeout(url, opts, ms) {
            const ac = new AbortController();
            const signal = opts.signal;
            const cancel = () => ac.abort(signal.reason);
            if (signal?.aborted) cancel();
            else signal?.addEventListener('abort', cancel, { once: true });
            const t = setTimeout(() => ac.abort(new DOMException('Request timeout', 'TimeoutError')), ms || 8000);
            return fetch(url, { ...opts, signal: ac.signal }).finally(() => {
                clearTimeout(t);
                signal?.removeEventListener('abort', cancel);
            });
        }

        const SECRET_KEY_CUSTOM = 'api_key_custom';
        const SECRET_LABEL = 'API 快切';
        const TT = Boolean(window.__TAURITAVERN__);

        async function secretRequest(action, payload) {
            const res = await fetchTimeout('/api/secrets/' + action, {
                method: 'POST',
                headers: ctx.getRequestHeaders({ omitContentType: payload === undefined }),
                body: payload === undefined ? undefined : JSON.stringify({ key: SECRET_KEY_CUSTOM, ...payload }),
            });
            if (!res.ok) throw new Error('密钥操作失败 (' + action + ', HTTP ' + res.status + ')');
            return res;
        }

        async function readCustomSecrets() {
            const state = await (await secretRequest('read')).json();
            if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('酒馆返回了无效的密钥状态');
            const entries = state[SECRET_KEY_CUSTOM];
            if (entries == null || entries === false) return [];
            if (entries === true) return [{ active: true }];
            if (!Array.isArray(entries)) throw new Error('酒馆返回了无效的自定义密钥列表');
            return entries;
        }

        function isPluginSecret(item) {
            return Boolean(item?.id && (settings.secretIds.includes(String(item.id)) || item.label === SECRET_LABEL));
        }

        async function writeKey(value) {
            const before = await readCustomSecrets();
            // TT 支持保存空值，防止无 Key 站点继承原生槽里的密钥。
            if (!TT && !value && !before.length) return;
            if (!TT && !value) throw new Error('当前宿主无法安全使用无 Key 站点，请在原生连接面板管理已启用的自定义密钥');
            const result = await (await secretRequest('write', { value, label: SECRET_LABEL })).json();
            const id = typeof result?.id === 'string' ? result.id : typeof result === 'string' ? result : '';
            if (!id) throw new Error('密钥写入结果缺少 ID，请在原生连接面板检查当前密钥');
            settings.secretIds = uniqStrings([...settings.secretIds, id]);
            save();
            const after = await readCustomSecrets();
            if ((TT || after.some((item) => item.id)) && !after.some((item) => String(item.id) === id && item.active)) {
                throw new Error('酒馆未启用刚保存的密钥，请重试');
            }
            for (const item of before.filter((entry) => isPluginSecret(entry) && String(entry.id) !== id)) {
                try {
                    await secretRequest('delete', { id: String(item.id) });
                    settings.secretIds = settings.secretIds.filter((known) => known !== String(item.id));
                } catch {
                    toastr.warning('旧的快切密钥暂未清理，下次切换将重试', 'API 快切');
                }
            }
            save();
        }

        /* ---------------- 核心：应用配置 ---------------- */
        let applyBusy = false;

        let applyBusyToastAt = 0;
        async function applyProfile(p, modelOverride) {
            if (applyBusy) {
                if (Date.now() - applyBusyToastAt > 1200) {
                    applyBusyToastAt = Date.now();
                    toastr.info('正在切换，请稍候…', 'API 快切');
                }
                return false;
            }
            applyBusy = true;
            try {
                const url = normUrl(p.url);
                const key = String(p.key || '');
                if (!validApiUrl(url)) throw new Error('请填写有效的 HTTP(S) API 基础地址');

                const controls = '#main_api, #chat_completion_source, #custom_api_url_text, #custom_model_id, #api_key_custom, #api_button_openai';
                const getControls = () => Object.fromEntries([...document.querySelectorAll(controls)].map((el) => [el.id, el]));
                const ready = (fields) => fields.main_api?.value === 'openai' && fields.chat_completion_source?.value === 'custom'
                    && fields.custom_api_url_text && fields.custom_model_id && fields.api_key_custom && fields.api_button_openai;
                const targetModel = String(modelOverride !== undefined ? modelOverride : (p.model || '')).trim();
                const configure = async () => {
                    const main = await waitForElement('#main_api');
                    if (!main.length) throw new Error('请先打开 API 连接抽屉');
                    setSelectValueIfNeeded('#main_api', 'openai');
                    const source = await waitForElement('#chat_completion_source');
                    if (source.length) setSelectValueIfNeeded('#chat_completion_source', 'custom');
                    await waitForElement('#custom_api_url_text');
                    if (!ready(getControls())) throw new Error('自定义连接面板尚未就绪，请打开 API 连接抽屉重试');
                    await writeKey(key);
                    const fields = getControls();
                    if (!ready(fields)) throw new Error('切换期间连接面板发生变化，请重试');
                    $(fields.custom_api_url_text).val(url).trigger('input').trigger('change');
                    $(fields.custom_model_id).val(targetModel).trigger('input').trigger('change');
                    $(fields.api_key_custom).val('').trigger('input');
                    return fields.api_button_openai;
                };
                let connect;
                if (TT) {
                    const { withConnectionValidationSuspended } = await import('/script.js');
                    if (typeof withConnectionValidationSuspended !== 'function') throw new Error('此 TT 版本缺少安全切换连接所需的接口');
                    connect = await withConnectionValidationSuspended('API 快切', configure);
                } else {
                    connect = await configure();
                }
                if (!connect.isConnected) throw new Error('连接面板已关闭，请打开后重试');
                connect.click();
                toastr.info('已提交「' + p.name + '」，请查看酒馆连接状态', 'API 快切');
                renderAll();
                // Connect 异步改 DOM 后补刷一次高亮
                setTimeout(() => { try { renderAll(); } catch { /* ignore */ } }, 400);
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
            const parse = (v) => String(v || '')
                .replace(/^v/i, '')
                .split(/[.+_-]/)
                .map((x) => {
                    const n = parseInt(x, 10);
                    return Number.isFinite(n) ? n : 0;
                });
            const pa = parse(a), pb = parse(b);
            const len = Math.max(pa.length, pb.length, 3);
            for (let i = 0; i < len; i++) {
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
                return '浏览器无法直连。请检查网络和站点的 CORS 配置，或手动填写模型 ID';
            }
            if (/timeout|aborted|AbortError/i.test(s)) {
                return '请求超时。站点太慢或当前网络访问不到该域名';
            }
            if (/接口报错|上游 \/models 失败|error\s*:\s*true/i.test(s)) {
                return '上游 /models 失败。常见原因：Key 不对、URL 多/少了 /v1、或酒馆服务器 IP 被中转站拦截';
            }
            return s;
        }

        async function fetchModelList(url, key, signal) {
            if (!validApiUrl(url)) throw new Error('请填写有效的 HTTP(S) API 基础地址');
            const useKey = String(key || '').trim();
            if (TT && !useKey && (await readCustomSecrets()).length) {
                throw new Error('酒馆保存了自定义密钥。请填写此站点自己的 Key，避免获取模型时使用其他站点的密钥。');
            }
            let lastError;
            for (const base of candidateUrls(url)) {
                if (signal?.aborted) throw signal.reason;
                try {
                    // TT 保持桌面/移动端的端点信任检查，通过请求头指定当前站点的 Key。
                    const target = TT ? '/api/backends/chat-completions/status' : base + '/models';
                    const authorization = useKey ? 'Bearer ' + useKey : '';
                    const options = TT ? {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({
                            chat_completion_source: 'custom', custom_url: base, custom_api_format: 'openai_compat',
                            ...(authorization ? { custom_include_headers: { Authorization: authorization } } : {}),
                        }),
                    } : {
                        method: 'GET', headers: { Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                        cache: 'no-store', redirect: 'error', credentials: 'omit',
                    };
                    const res = await fetchTimeout(target, { ...options, signal }, 12000);
                    const json = await res.json().catch(() => null);
                    if (!res.ok || json?.error || json?.cancelled) {
                        const error = new Error(String(errMsgFromJson(json, 'HTTP ' + res.status)).replaceAll(useKey || '\0', '[已隐藏]'));
                        if (TT || res.status === 401 || res.status === 403) throw Object.assign(error, { terminal: true });
                        throw error;
                    }
                    const models = uniqStrings(extractModels(json)).sort((a, b) => a.localeCompare(b));
                    if (models.length) return models;
                    lastError = new Error('接口没有返回模型列表');
                } catch (error) {
                    if (signal?.aborted) throw signal.reason;
                    if (error.terminal) throw error;
                    lastError = error;
                }
            }
            throw new Error(humanizeFetchErr(lastError?.message || '获取模型失败'));
        }

        function viewportSize() {
            const viewport = window.visualViewport;
            return viewport?.width > 0 && viewport?.height > 0
                ? { vw: viewport.width, vh: viewport.height, x: viewport.offsetLeft, y: viewport.offsetTop }
                : { vw: window.innerWidth, vh: window.innerHeight, x: 0, y: 0 };
        }

        function layoutModelModal(overlay) {
            const { vw, vh, x, y } = viewportSize();
            overlay.style.setProperty('--aqs-vw', vw + 'px');
            overlay.style.setProperty('--aqs-vh', vh + 'px');
            overlay.style.setProperty('--aqs-vx', x + 'px');
            overlay.style.setProperty('--aqs-vy', y + 'px');
        }

        let closeModelPicker;

        function openModelPicker(url, key, onPick) {
            url = normUrl(url);
            if (!validApiUrl(url)) { toastr.warning('请填写有效的 HTTP(S) API 基础地址'); return; }

            closeModelPicker?.();
            const request = new AbortController();
            const opener = document.activeElement;
            const overlay = $(`
                <div id="aqs_model_modal" role="dialog" aria-modal="true" aria-label="选择模型">
                  <div class="aqs-modal-box">
                    <div class="aqs-modal-head">
                      <span>选择模型</span>
                      <button type="button" class="aqs-modal-close" aria-label="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                    </div>
                    <input class="text_pole aqs-modal-filter" placeholder="搜索模型…">
                    <div class="aqs-modal-list">
                      <div class="aqs-modal-loading"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp; 正在获取模型…</div>
                    </div>
                  </div>
                </div>`);
            // 挂到 <html>，避开 body 内 transform/overflow 把 fixed 算歪
            $(document.documentElement).append(overlay);
            if (!window.matchMedia('(pointer: coarse)').matches) overlay.find('.aqs-modal-filter')[0].focus({ preventScroll: true });
            const host = overlay[0];
            const relayout = () => { if (host.isConnected) layoutModelModal(host); };
            const onResize = relayout;
            relayout();
            window.addEventListener('resize', onResize);
            window.addEventListener('orientationchange', onResize);
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', onResize);
                window.visualViewport.addEventListener('scroll', onResize);
            }

            const prevOverflow = document.body.style.overflow;
            const prevHtmlOverflow = document.documentElement.style.overflow;
            let isClosed = false;
            const close = () => {
                if (isClosed) return;
                isClosed = true;
                document.body.style.overflow = prevOverflow;
                document.documentElement.style.overflow = prevHtmlOverflow;
                window.removeEventListener('resize', onResize);
                window.removeEventListener('orientationchange', onResize);
                if (window.visualViewport) {
                    window.visualViewport.removeEventListener('resize', onResize);
                    window.visualViewport.removeEventListener('scroll', onResize);
                }
                overlay.remove();
                request.abort();
                closeModelPicker = undefined;
                document.removeEventListener('keydown', onKey, true);
                if (opener?.isConnected) opener.focus({ preventScroll: true });
            };
            document.body.style.overflow = 'hidden';
            document.documentElement.style.overflow = 'hidden';
            // 弹窗挂在 html 上，点击事件若冒泡到 document，酒馆会判定"点击了面板外部"
            // 而关闭整个扩展设置面板，导致选完模型被踢回主界面 —— 全部拦截
            overlay.on('pointerdown pointerup mousedown mouseup click touchstart touchend wheel', (e) => {
                e.stopPropagation();
                if (e.type === 'click' && e.target === host) close();
            });
            overlay.find('.aqs-modal-close').on('click', close);
            const onKey = (e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                close();
            };
            document.addEventListener('keydown', onKey, true);
            closeModelPicker = close;

            const list = overlay.find('.aqs-modal-list');
            const showError = (msg) => {
                list.empty();
                const box = $('<div class="aqs-empty aqs-modal-error"></div>');
                box.append($('<div></div>').text(String(msg || '获取失败')));
                $('<button type="button" class="menu_button aqs-btn aqs-btn-primary" style="margin-top:12px;">重试</button>')
                    .on('click', () => {
                        list.html('<div class="aqs-modal-loading"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp; 正在获取模型…</div>');
                        relayout();
                        doFetch();
                    })
                    .appendTo(box);
                list.append(box);
                relayout();
            };

            const doFetch = () => {
                fetchModelList(url, key, request.signal)
                    .then((models) => {
                        if (isClosed) return;
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
                        render(overlay.find('.aqs-modal-filter').val());
                        overlay.find('.aqs-modal-filter')
                            .off('input.aqs').on('input.aqs', function () { render(this.value); })
                            .off('keydown.aqs').on('keydown.aqs', function (e) {
                                if (e.key === 'Enter' && !e.originalEvent?.isComposing && e.which !== 229) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const firstItem = list.find('.aqs-modal-item').first();
                                    if (firstItem.length) {
                                        firstItem.trigger('click');
                                    }
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    close();
                                }
                            });
                        relayout();
                        setTimeout(relayout, 40);
                        toastr.success('共 ' + models.length + ' 个模型', 'API 快切');
                    })
                    .catch((err) => {
                        if (isClosed) return;
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
            return out.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
        }

        function isModelFolded(p) {
            if (!p || !p.id) return true;
            return settings.modelCollapsed[p.id] !== false;
        }

        function toggleModelFold(p) {
            if (!p || !p.id) return;
            settings.modelCollapsed[p.id] = !isModelFolded(p);
            save();
        }

        function setProfileModels(p, models, preferred) {
            const list = uniqStrings([preferred, ...splitModelValues(models)]);
            p.models = list;
            p.model = list[0] || '';
        }

        function appendModelToInput(selector, model) {
            const $input = $(selector);
            const list = splitModelValues($input.val(), model);
            $input.val(list.join('\n')).trigger('input').trigger('change');
            return list;
        }

        function modelSummary(models) {
            if (!models.length) return '';
            if (models.length === 1) return models[0];
            return models[0] + ' +' + (models.length - 1);
        }

        /* ---------------- 设置面板：配置卡片 ---------------- */
        function profileCard(p) {
            const active = isActive(p);
            const models = profileModels(p);
            const folded = isModelFolded(p);
            const card = $('<div class="aqs-card"></div>').toggleClass('aqs-active', active);

            const head = $('<div class="aqs-card-head"></div>');
            $('<span class="aqs-card-name"></span>').text(p.name).appendTo(head);
            if (active) $('<span class="aqs-badge">当前</span>').appendTo(head);
            $('<button type="button" class="aqs-btn aqs-favorite"></button>')
                .attr({ 'aria-label': (p.favorite ? '取消收藏 ' : '收藏 ') + p.name, 'aria-pressed': String(Boolean(p.favorite)) })
                .text(p.favorite ? '★' : '☆')
                .on('click', () => {
                    p.favorite = !p.favorite;
                    settings.pages.quick = 0;
                    settings.pages.embed = 0;
                    save();
                    renderAll();
                }).appendTo(head);
            card.append(head);

            $('<div class="aqs-card-url"></div>').text(p.url).appendTo(card);

            const meta = $('<div class="aqs-card-meta"></div>');
            if (models.length) $('<span class="aqs-chip aqs-chip-model"></span>').text(modelSummary(models)).attr('title', models.join('\n')).appendTo(meta);
            if (models.length > 1) $('<span class="aqs-chip aqs-chip-dim"></span>').text(models.length + ' 个模型').appendTo(meta);
            $('<span class="aqs-chip aqs-chip-dim"></span>').text(p.key ? '已保存密钥' : '无密钥').appendTo(meta);
            card.append(meta);

            if (models.length > 1 && !folded) {
                const modelBox = $('<div class="aqs-card-models"></div>');
                for (const m of models) {
                    $('<button type="button" class="menu_button aqs-btn aqs-model-choice"></button>')
                        .toggleClass('aqs-active', isActiveChoice(p, m))
                        .text(m)
                        .attr('title', '切换到模型：' + m)
                        .on('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            applyProfile(p, m);
                        })
                        .appendTo(modelBox);
                }
                card.append(modelBox);
            }

            const btns = $('<div class="aqs-card-btns"></div>');
            $('<button class="menu_button aqs-btn aqs-btn-primary" title="切换到默认模型"><i class="fa-solid fa-plug"></i> 使用</button>')
                .on('click', () => applyProfile(p)).appendTo(btns);
            if (models.length > 1) {
                $('<button class="menu_button aqs-btn" title="展开 / 折叠该站模型"><i class="fa-solid fa-layer-group"></i> 模型</button>')
                    .on('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleModelFold(p);
                        renderAll();
                    }).appendTo(btns);
            }
            $('<button class="menu_button aqs-btn" title="从该接口获取模型列表并设为默认模型"><i class="fa-solid fa-microchip"></i></button>')
                .on('click', () => openModelPicker(p.url, p.key, (m) => {
                    setProfileModels(p, profileModels(p), m);
                    save();
                    renderAll();
                    if (isActive(p)) {
                        applyProfile(p, m);
                    } else {
                        toastr.success('已为「' + p.name + '」选择默认模型：' + m);
                    }
                })).appendTo(btns);
            $('<button class="menu_button aqs-btn" title="编辑"><i class="fa-solid fa-pen"></i></button>')
                .on('click', () => startEdit(p)).appendTo(btns);
            $('<button class="menu_button aqs-btn aqs-danger" title="删除"><i class="fa-solid fa-trash"></i></button>')
                .on('click', () => {
                    if (!confirm('确定删除「' + p.name + '」？')) return;
                    settings.profiles = settings.profiles.filter((x) => x.id !== p.id);
                    if (p.id) delete settings.modelCollapsed[p.id];
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

        function groupPageKey(g) {
            return '__group__:' + String(g || '');
        }

        function makeGroupBox(g) {
            const items = settings.profiles.filter((p) => p.group === g && matchSearch(p));
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
            if (!collapsed) appendPagedCards(body, items, groupPageKey(g), renderList);
            box.append(body);
            return box;
        }

        function renderList() {
            const list = $('#aqs_profile_list');
            if (!list.length) return;
            const names = groupNames();
            for (const k of Object.keys(settings.groupCollapsed)) {
                if (!names.includes(k)) delete settings.groupCollapsed[k];
            }
            // 站点页 __sites__ / 组页 __groups__ / 表单芯片 __picker__ / 组内页码用 namespaced key
            // 兼容清理旧版 __main__、旧组名页码等失效键
            const keepKeys = new Set(['__sites__', '__groups__', '__picker__', ...names.map(groupPageKey)]);
            for (const k of Object.keys(settings.pages.list)) {
                if (keepKeys.has(k)) continue;
                delete settings.pages.list[k];
            }
            renderGroupPicker();

            if (!list.children('.aqs-search-bar').length) addSearch(list, 'settings');

            renderListContent();

            function renderListContent() {
                // 移除搜索栏之后的内容
                list.find('.aqs-list-section, .aqs-empty').remove();
                const filtered = settings.profiles.filter(matchSearch);
                if (!filtered.length) {
                    if (searchQuery) {
                        list.append($('<div class="aqs-empty">没有匹配「' + $('<span>').text(searchQuery).html() + '」的站点</div>'));
                    } else {
                        list.append($('<div class="aqs-empty">还没有站点，在下方添加第一个吧</div>'));
                    }
                    return;
                }

                // 分层分页，保证整齐：
                // 1) 未分组站点 >4 → 在「站点层」分页
                // 2) 分组数 >4 → 在「组层」分页（折叠时也只显示当前页的组头）
                // 3) 组内站点 >4 → 展开后在组内分页
                // 搜索时也按同样的分层逻辑
                const ungrouped = filtered.filter((p) => !p.group);
                if (ungrouped.length) {
                    const sitesWrap = $('<div class="aqs-list-section aqs-list-sites"></div>');
                    appendPagedCards(sitesWrap, ungrouped, '__sites__', renderListContent);
                    list.append(sitesWrap);
                }

                const filteredGroups = [...new Set(filtered.filter((p) => p.group).map((p) => p.group))];
                if (filteredGroups.length) {
                    const groupsWrap = $('<div class="aqs-list-section aqs-list-groups"></div>');
                    const raw = settings.pages.list.__groups__ || 0;
                    const cur = clampPage(raw, filteredGroups.length);
                    if (raw !== cur) {
                        settings.pages.list.__groups__ = cur;
                        save();
                    } else {
                        settings.pages.list.__groups__ = cur;
                    }
                    const sliced = slicePage(filteredGroups, cur);
                    for (const g of sliced.items) {
                        groupsWrap.append(makeGroupBox(g));
                    }
                    const pager = makePager(sliced.page, sliced.total, (np) => {
                        settings.pages.list.__groups__ = np;
                        save();
                        renderListContent();
                    });
                    if (pager && pager.length) groupsWrap.append(pager);
                    list.append(groupsWrap);
                }
            }
        }

        /* renderAll 在快捷面板段重定义，同步刷新嵌入面板 */

        /* ---------------- 表单 ---------------- */
        function startEdit(p) {
            editingId = p.id;
            $('#aqs_name').val(p.name);
            $('#aqs_url').val(p.url);
            $('#aqs_key').val(p.key || '');
            $('#aqs_model').val(profileModels(p).join('\n'));
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
            const models = splitModelValues($('#aqs_model').val());
            const model = models[0] || '';
            const group = currentGroupValue();

            if (!name || !url) { toastr.warning('名称和 URL 必填'); return; }
            if (!validApiUrl(url)) { toastr.warning('请填写有效的 HTTP(S) API 基础地址'); return; }

            if (editingId) {
                const p = settings.profiles.find((x) => x.id === editingId);
                if (!p) { resetForm(); return; }
                const dup = settings.profiles.find((x) => x.name === name && x.id !== editingId);
                if (dup) { toastr.warning('已存在同名站点「' + name + '」'); return; }
                Object.assign(p, { name, url, key, model, models, group });
                toastr.success('已更新「' + name + '」');
            } else {
                const dup = settings.profiles.find((x) => x.name === name);
                if (dup) {
                    if (!confirm('已存在同名站点「' + name + '」，覆盖它吗？')) return;
                    Object.assign(dup, { url, key, model, models, group });
                    toastr.success('已覆盖「' + name + '」');
                } else {
                    settings.profiles.push({ id: uid(), name, url, key, model, models, group });
                    toastr.success('已保存「' + name + '」');
                }
            }
            save();
            resetForm();
            renderAll();
        }

        /* ---------------- 导入 / 导出 ---------------- */
        function exportProfiles(includeKeys = false) {
            if (!settings.profiles.length) { toastr.warning('没有可导出的站点'); return; }
            if (includeKeys && !confirm('完整备份包含明文 API Key。确认导出？')) return;
            const profiles = settings.profiles.map(({ key, ...profile }) => includeKeys ? { ...profile, key } : profile);
            const data = JSON.stringify({ app: EXT_NAME, version: VERSION, includesKeys: includeKeys, profiles }, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = includeKeys ? 'st-api-switcher-full-backup.json' : 'st-api-switcher-profiles.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            toastr.info(includeKeys ? '完整备份包含明文 Key，请妥善保管' : '已导出站点配置，未包含 Key', '已导出');
        }

        function importProfiles(file) {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(String(reader.result));
                    const arr = Array.isArray(data) ? data : data?.profiles;
                    if (!Array.isArray(arr)) throw new Error('文件格式不正确');
                    let added = 0, updated = 0;
                    for (const item of arr) {
                        if (!item || typeof item.name !== 'string' || typeof item.url !== 'string') continue;
                        const models = splitModelValues(item.model, item.models);
                        const clean = {
                            name: String(item.name || '').trim(),
                            url: normUrl(item.url),
                            model: models[0] || '',
                            models,
                            group: typeof item.group === 'string' ? item.group.trim() : '',
                        };
                        if (!clean.name || !clean.url) continue;
                        if (!validApiUrl(clean.url)) continue;
                        const dup = settings.profiles.find((x) => x.name === clean.name);
                        if (typeof item.favorite === 'boolean') clean.favorite = item.favorite;
                        if (typeof item.key === 'string') clean.key = item.key;
                        else if (dup && normUrl(dup.url) !== clean.url) clean.key = '';
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
            reader.onerror = () => toastr.error('无法读取备份文件', '导入失败');
            reader.readAsText(file);
        }

        /* ---------------- 快捷面板 / 插头嵌入 ---------------- */
        function buildProfileItems($root, { pageKey } = {}) {
            $root.empty();
            const filtered = settings.profiles.filter(matchSearch);
            if (!filtered.length) {
                if (searchQuery) {
                    $root.append($('<div class="aqs-empty">没有匹配「' + $('<span>').text(searchQuery).html() + '」的站点</div>'));
                } else {
                    $root.append($('<div class="aqs-empty">先去扩展设置里添加站点</div>'));
                }
                return;
            }

            const flat = orderedProfiles().filter(matchSearch);
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

            const bindQpClick = (item, handler) => {
                item.on('pointerdown mousedown touchstart click', async (e) => {
                    // down 阶段只拦冒泡，避免魔法棒菜单被当成点外部关掉；勿 preventDefault，否则手机可能不出 click
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    if (e.type !== 'click') return;
                    e.preventDefault();
                    await handler(e);
                });
            };

            const addItem = (p) => {
                const models = profileModels(p);
                const folded = isModelFolded(p);
                const multi = models.length > 1;
                const item = $('<button type="button" class="aqs-qp-item"></button>')
                    .toggleClass('aqs-active', isActive(p))
                    .toggleClass('aqs-has-models', multi);
                const main = $('<span class="aqs-qp-main"></span>').appendTo(item);
                $('<span class="aqs-qp-name"></span>').text(p.name).appendTo(main);
                if (p.favorite) $('<span class="aqs-qp-favorite" aria-hidden="true">★</span>').appendTo(item);
                if (models.length) {
                    $('<span class="aqs-qp-model"></span>')
                        .text(multi ? (models.length + ' 个模型 · ' + modelSummary(models)) : models[0])
                        .attr('title', models.join('\n'))
                        .appendTo(main);
                }
                if (multi) {
                    $('<span class="aqs-qp-chevron"></span>').html('<i class="fa-solid ' + (folded ? 'fa-chevron-right' : 'fa-chevron-down') + '"></i>').appendTo(item);
                    item.attr({ title: '展开 / 折叠模型：' + p.name, 'aria-expanded': String(!folded) });
                    bindQpClick(item, async () => {
                        toggleModelFold(p);
                        if (key === 'quick') {
                            renderQuickPanel();
                            requestAnimationFrame(() => layoutQuickPanel(document.getElementById('aqs_wand_btn')));
                        } else renderApiEmbed();
                    });
                } else {
                    item.attr('title', models[0] ? (p.name + ' · ' + models[0]) : p.name);
                    bindQpClick(item, async () => applyProfile(p, models[0] || undefined));
                }
                $root.append(item);

                if (multi && !folded) {
                    const modelList = $('<div class="aqs-qp-model-list"></div>');
                    for (const m of models) {
                        const choice = $('<button type="button" class="aqs-qp-item aqs-qp-model-choice"></button>')
                            .toggleClass('aqs-active', isActiveChoice(p, m))
                            .attr('title', '切换到：' + p.name + ' · ' + m);
                        const choiceMain = $('<span class="aqs-qp-main"></span>').appendTo(choice);
                        $('<span class="aqs-qp-name"></span>').text(m).appendTo(choiceMain);
                        $('<span class="aqs-qp-model"></span>').text(p.name).appendTo(choiceMain);
                        bindQpClick(choice, async () => applyProfile(p, m));
                        modelList.append(choice);
                    }
                    $root.append(modelList);
                }
            };

            let lastGroup = null;
            sliced.items.forEach((p) => {
                const group = p.favorite ? 'favorites' : 'group:' + (p.group || '');
                const g = p.favorite ? '收藏' : p.group;
                if (g) {
                    if (group !== lastGroup) {
                        $('<div class="aqs-qp-group"></div>').text(g).appendTo($root);
                        lastGroup = group;
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

            const { vw, vh, x, y } = viewportSize();
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

            const maxW = Math.max(1, Math.min(isPhone ? 360 : (isTablet ? 380 : 400), vw - pad * 2));
            const minW = Math.min(260, maxW);
            const maxH = Math.max(1, Math.min(Math.max(190, Math.round(vh * 0.55)), vh - pad * 2));
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
            const ph = Math.min(el.offsetHeight || maxH, maxH);
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

            if (menuRect) menuRect = { width: menuRect.width, left: menuRect.left - x, right: menuRect.right - x,
                top: menuRect.top - y, bottom: menuRect.bottom - y };
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

            el.style.setProperty('top', Math.round(y + top) + 'px', 'important');
            el.style.setProperty('left', Math.round(x + left) + 'px', 'important');
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
            const panel = $('#aqs_quick_panel');
            if (!panel.length || !panel.is(':visible')) return;
            panel[0].style.removeProperty('display');
            panel.hide();
        }

        function addSearch(host, surface) {
            const bar = $('<div class="aqs-search-bar"></div>');
            if (surface === 'embed') bar.attr('id', 'aqs_embed_search');
            if (surface === 'quick') bar.addClass('aqs-qp-search');
            const input = $('<input class="text_pole aqs-search-input" type="search" placeholder="搜索站点…" aria-label="搜索站点" autocomplete="off">').val(searchQuery);
            const clear = $('<button type="button" class="menu_button aqs-btn aqs-search-clear" aria-label="清除搜索"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>');
            bar.append(input, clear);
            host.append(bar);
            clear.toggle(Boolean(searchQuery));
            const update = () => {
                const next = String(input.val() || '');
                if (next.trim() === searchQuery) return;
                searchQuery = next.trim();
                for (const field of document.querySelectorAll('.aqs-search-input')) {
                    if (field !== input[0]) field.value = searchQuery;
                }
                $('.aqs-search-clear').toggle(Boolean(searchQuery));
                renderAll();
                layoutQuickPanel(document.getElementById('aqs_wand_btn'));
            };
            input.on('input.aqs', (event) => { if (!event.originalEvent?.isComposing) update(); });
            input.on('compositionend.aqs', update);
            clear.on('click.aqs', () => { input.val(''); update(); input[0].focus({ preventScroll: true }); });
            return bar;
        }

        function renderQuickPanel() {
            const panel = $('#aqs_quick_panel');
            if (!panel.length) return;
            if (!panel.children('.aqs-qp-title').length) {
                const title = $('<div class="aqs-qp-title"><span class="aqs-qp-title-text">API 快切</span></div>').appendTo(panel);
                $('<button type="button" class="aqs-qp-close" aria-label="关闭快切"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>')
                    .on('click', closeQuickPanel).appendTo(title);
                addSearch(panel, 'quick');
                panel.append('<div class="aqs-quick-results"></div>');
            }
            panel.find('.aqs-search-input').each(function () { if (this !== document.activeElement) this.value = searchQuery; });
            panel.find('.aqs-search-clear').toggle(Boolean(searchQuery));
            buildProfileItems(panel.children('.aqs-quick-results'), { pageKey: 'quick' });
        }

        function renderApiEmbed() {
            const body = $('#aqs_api_embed_body');
            if (!body.length) return;
            if (!$('#aqs_embed_search').length) body.before(addSearch(body.parent(), 'embed'));
            buildProfileItems(body, { pageKey: 'embed' });
            const n = settings.profiles.filter(matchSearch).length;
            const total = settings.profiles.length;
            $('#aqs_api_embed_count').text(searchQuery ? n + '/' + total + ' 站' : total ? total + ' 站' : '空');
        }

        function ensureApiEmbed() {
            const host = $('#rm_api_block');
            if (!host.length) return false;
            const existing = $('#aqs_api_embed');
            if (existing.length) {
                if (!host[0].contains(existing[0])) {
                    const title = host.children('h3').first();
                    if (title.length) title.after(existing);
                    else host.prepend(existing);
                }
                // 宿主重建后可能丢了 jQuery 委托外的直绑；幂等重绑
                $('#aqs_api_embed_refresh').off('click.aqs').on('click.aqs', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    renderApiEmbed();
                    toastr.info('已刷新站点列表', 'API 快切');
                });
                $('#aqs_api_embed_toggle').off('click.aqs').on('click.aqs', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const collapsed = $('#aqs_api_embed').toggleClass('aqs-collapsed').hasClass('aqs-collapsed');
                    $('#aqs_api_embed_toggle').attr('aria-expanded', String(!collapsed)).find('i')
                        .toggleClass('fa-chevron-up', !collapsed)
                        .toggleClass('fa-chevron-down', collapsed);
                });
                return true;
            }

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
                            <button type="button" id="aqs_api_embed_refresh" class="menu_button menu_button_icon aqs-btn" aria-label="刷新列表">
                                <i class="fa-solid fa-rotate" aria-hidden="true"></i>
                            </button>
                            <button type="button" id="aqs_api_embed_toggle" class="menu_button menu_button_icon aqs-btn" aria-label="展开或收起快切" aria-expanded="true">
                                <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                            </button>
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

            $('#aqs_api_embed_refresh').off('click.aqs').on('click.aqs', (e) => {
                e.preventDefault();
                e.stopPropagation();
                renderApiEmbed();
                toastr.info('已刷新站点列表', 'API 快切');
            });
            $('#aqs_api_embed_toggle').off('click.aqs').on('click.aqs', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const collapsed = $('#aqs_api_embed').toggleClass('aqs-collapsed').hasClass('aqs-collapsed');
                $('#aqs_api_embed_toggle').attr('aria-expanded', String(!collapsed)).find('i')
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
            const menu = findExtensionsMenu();
            if (!menu.length) return false;
            const existing = $('#aqs_wand_btn');
            // 菜单重建后按钮可能悬空：移回菜单即可，勿重复创建
            if (existing.length) {
                if (!menu[0].contains(existing[0])) menu.append(existing);
                return true;
            }

            // 与角色卡/世界书插件同一结构：list-group-item + i + span，避免被容器裁切成 ...
            const btn = $(
                '<div id="aqs_wand_btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="button" title="API 快切">' +
                '<i class="fa-solid fa-shuffle extensionsMenuExtensionButton"></i>' +
                '<span class="aqs-wand-label">API 快切</span></div>'
            );
            const toggleFromBtn = function (el) {
                const panel = $('#aqs_quick_panel');
                if (panel.is(':visible')) {
                    closeQuickPanel();
                    return;
                }
                openQuickPanel(el);
            };
            btn.on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleFromBtn(this);
            });
            btn.on('keydown', function (e) {
                if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                e.stopPropagation();
                toggleFromBtn(this);
            });

            // 与其他扩展一致：直接 append 到 #extensionsMenu
            menu.append(btn);
            return true;
        }

        let qpChromeBound = false;
        function bindQuickPanelChrome() {
            if (qpChromeBound) return;
            qpChromeBound = true;
            // pointerdown 比 mousedown/touchstart 更稳；点面板外才关快切（魔法棒是否关由酒馆自己判定）
            $(document).off('pointerdown.aqs_qp touchstart.aqs_qp keydown.aqs_qp');
            $(document).on('pointerdown.aqs_qp touchstart.aqs_qp', (e) => {
                // touchstart 兜底老 WebView；pointer 事件下 touchstart 可能连发
                if (e.type === 'touchstart' && window.PointerEvent) return;
                const $t = $(e.target);
                // 模型选择弹窗 / 设置区交互时不要误关快切
                if ($t.closest('#aqs_quick_panel, #aqs_wand_btn, #aqs_model_modal, .aqs-settings').length) return;
                closeQuickPanel();
            });
            $(document).on('keydown.aqs_qp', (e) => {
                if (e.key !== 'Escape') return;
                if ($('#aqs_model_modal').length) return;
                if ($('#aqs_quick_panel').is(':visible')) closeQuickPanel();
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

        function ensureFloatingPanel() {
            let $panel = $('#aqs_quick_panel');
            if ($panel.length) {
                if ($panel[0].parentElement !== document.documentElement) {
                    document.documentElement.appendChild($panel[0]);
                }
                bindQuickPanelChrome();
                return;
            }
            // 挂到 <html>，与模型弹窗一致，避免被 #extensionsMenu 的 stacking / overflow 裁切遮挡
            $panel = $('<div id="aqs_quick_panel" style="display:none;" role="dialog" aria-label="API 快切"></div>');
            $(document.documentElement).append($panel);
            // 面板不在魔法棒菜单 DOM 内；若不拦截冒泡，酒馆会当成「点菜单外」把整菜单关掉
            // X / 列表点击只应关快切或切站，不能连带关魔法棒
            $panel.on('pointerdown pointerup mousedown mouseup click touchstart touchend wheel', (e) => {
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            });
            bindQuickPanelChrome();
        }

        function profileNameFromUrl(url) {
            try {
                const u = new URL(url);
                return u.hostname.replace(/^www\./i, '') || '自定义接口';
            } catch {
                return '自定义接口';
            }
        }

        function uniqueProfileName(base) {
            const clean = String(base || '').trim() || '自定义接口';
            const used = new Set(settings.profiles.map((p) => p.name));
            if (!used.has(clean)) return clean;
            for (let i = 2; i < 1000; i++) {
                const name = clean + ' ' + i;
                if (!used.has(name)) return name;
            }
            return clean + ' ' + Date.now().toString(36);
        }

        function captureNativeApiSnapshot() {
            if (!settings.autoSyncNative || applyBusy) return null;
            if (String($('#main_api').val() || '') !== 'openai') return null;
            if (String($('#chat_completion_source').val() || '') !== 'custom') return null;
            const url = normUrl($('#custom_api_url_text').val());
            if (!validApiUrl(url)) return null;
            return {
                url,
                key: String($('#api_key_custom').val() || '').trim(),
                model: String($('#custom_model_id').val() || '').trim(),
            };
        }

        function upsertNativeProfile(snap) {
            if (!settings.autoSyncNative || applyBusy || !snap) return false;
            const url = normUrl(snap.url);
            if (!validApiUrl(url)) return false;
            const key = String(snap.key || '').trim();
            const models = splitModelValues(snap.model);
            // 没有可同步的新信息时不打扰用户；Key 若已被酒馆清空，也无法安全读回明文
            if (!key && !models.length) return false;

            let changed = false;
            const hit = settings.profiles.find((p) => normUrl(p.url) === url);
            if (hit) {
                if (key && hit.key !== key) { hit.key = key; changed = true; }
                const merged = splitModelValues(profileModels(hit), models);
                if (merged.join('\n') !== profileModels(hit).join('\n')) {
                    hit.models = merged;
                    if (!hit.model) hit.model = merged[0] || '';
                    changed = true;
                }
                if (changed) {
                    save();
                    renderAll();
                    toastr.success('已同步原生连接到「' + hit.name + '」', 'API 快切');
                }
                return changed;
            }

            const name = uniqueProfileName(profileNameFromUrl(url));
            settings.profiles.push({
                id: uid(),
                name,
                url,
                key,
                model: models[0] || '',
                models,
                group: '',
            });
            save();
            renderAll();
            toastr.success('已从原生 API 面板同步「' + name + '」', 'API 快切');
            return true;
        }

        function bindNativeSync() {
            document.addEventListener('click', (event) => {
                if (!event.target.closest?.('#api_button_openai')) return;
                const snap = captureNativeApiSnapshot();
                if (!snap) return;
                queueMicrotask(() => {
                    if (currentUrl() === snap.url) upsertNativeProfile(snap);
                });
            }, true);
        }

        function watchUiHosts() {
            ensureFloatingPanel();
            ensureApiEmbed();
            injectWand();

            // 手机 ST 上魔法棒菜单 / API 抽屉可能晚于扩展脚本出现
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                ensureFloatingPanel();
                const okWand = injectWand();
                const okEmbed = ensureApiEmbed();
                if ((okWand && okEmbed) || tries > 60) clearInterval(timer);
            }, 500);

            // 菜单/抽屉被 ST 重建后要把入口挂回去；节流，长期轻量观察
            if (window.MutationObserver && !window.__aqsHostMo) {
                let moTimer = null;
                const mo = new MutationObserver(() => {
                    if (moTimer) return;
                    moTimer = setTimeout(() => {
                        moTimer = null;
                        ensureFloatingPanel();
                        ensureSettings();
                        injectWand();
                        ensureApiEmbed();
                    }, 180);
                });
                mo.observe(document.body, { childList: true, subtree: true });
                window.__aqsHostMo = mo;
            }

            // 打开 API 抽屉时强制刷新嵌入列表
            $(document).off('click.aqs_api_drawer').on('click.aqs_api_drawer', '#API-status-top, #sys-settings-button .drawer-toggle, #rm_api_block, #api_button_openai', () => {
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
                    <span class="aqs-sys-ver">v${VERSION}</span>
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
                    <textarea id="aqs_model" class="text_pole" rows="2" placeholder="模型 ID（可多个：换行 / 逗号分隔，首个为默认）" autocomplete="off"></textarea>
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
                  <label class="aqs-check-row" title="在酒馆原生 API 面板填写 URL / Key / 模型并点 Connect 后，自动保存到 API 快切">
                    <input id="aqs_auto_sync_native" type="checkbox">
                    <span>原生 API 连接后自动同步到快切</span>
                  </label>
                  <div class="aqs-io-btns">
                    <button type="button" id="aqs_export" class="menu_button aqs-btn">导出配置</button>
                    <button type="button" id="aqs_export_full" class="menu_button aqs-btn" title="包含明文 API Key">完整备份</button>
                    <button type="button" id="aqs_import" class="menu_button aqs-btn">导入</button>
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
        function ensureSettings() {
            const container = $settingsHost();
            if (!container.length) return;
            // TT 可把抽屉暂时停放在离线 DOM 中，复用原表单避免重复 ID 和丢失草稿。
            if (!settingsPanel) {
                settingsPanel = $(html);
                container.prepend(settingsPanel);
                bindSettingsUi();
                renderList();
            } else if (!container[0].contains(settingsPanel[0])) {
                container.prepend(settingsPanel);
                renderList();
            }
        }
        let settingsPanel;

        function bindSettingsUi() {
            $('#aqs_save').off('click.aqs').on('click.aqs', onSave);
            $('#aqs_cancel_edit').off('click.aqs').on('click.aqs', resetForm);
            $('#aqs_export').off('click.aqs').on('click.aqs', () => exportProfiles());
            $('#aqs_export_full').off('click.aqs').on('click.aqs', () => exportProfiles(true));
            $('#aqs_import').off('click.aqs').on('click.aqs', () => $('#aqs_import_file').trigger('click'));
            $('#aqs_import_file').off('change.aqs').on('change.aqs', function () {
                if (this.files && this.files[0]) importProfiles(this.files[0]);
                this.value = '';
            });
            $('#aqs_fetch_models').off('click.aqs').on('click.aqs', () => {
                openModelPicker($('#aqs_url').val(), $('#aqs_key').val(), (m) => {
                    const list = appendModelToInput('#aqs_model', m);
                    toastr.success('已加入：' + m + (list.length > 1 ? '（共 ' + list.length + ' 个模型）' : ''), 'API 快切');
                });
            });
            $('#aqs_auto_sync_native')
                .prop('checked', !!settings.autoSyncNative)
                .off('change.aqs')
                .on('change.aqs', function () {
                    settings.autoSyncNative = !!this.checked;
                    save();
                });
            $('#aqs_update_btn').off('click.aqs').on('click.aqs', async () => {
                if (updState === 'updated') {
                    location.reload();
                } else if (updState === 'available') await doUpdate();
                else await checkUpdate(false);
            });
        }
        ensureSettings();

        // 初始化 UI 宿主（魔法棒 / 插头嵌入 / 浮层）
        bindNativeSync();
        watchUiHosts();
        renderList();
        setTimeout(() => checkUpdate(true), 3000);

        console.log('[API快切] v' + VERSION + ' 已加载');
    });
})();
