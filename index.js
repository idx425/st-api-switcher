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
    const VERSION = '2.1.8';
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
        settings.profiles.forEach((p) => {
            if (!p.id) p.id = uid();
            if (typeof p.group !== 'string') p.group = '';
        });

        let editingId = null;

        /* ---------------- 工具 ---------------- */
        const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
        const currentUrl = () => normUrl($('#custom_api_url_text').val());
        const isActive = (p) => !!currentUrl() && currentUrl() === normUrl(p.url);

        async function writeKey(key) {
            const res = await fetch('/api/secrets/write', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ key: 'api_key_custom', value: key || '' }),
            });
            if (!res.ok) throw new Error('写入密钥失败: HTTP ' + res.status);
        }

        /* ---------------- 核心：应用配置 ---------------- */
        async function applyProfile(p) {
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

                // 密钥库 + 可见框必须同时写，且在点 Connect 前再写一次
                await writeKey(key);
                $('#custom_api_url_text').val(url).trigger('input').trigger('change');
                $('#api_key_custom').val(key).trigger('input').trigger('change');
                if (p.model) {
                    $('#custom_model_id').val(p.model).trigger('input').trigger('change');
                }
                await sleep(120);
                // Connect 会回读可见密钥框写回密钥库：再确保一次
                await writeKey(key);
                $('#api_key_custom').val(key);

                const $btn = $('#api_button_openai');
                if ($btn.length) $btn.trigger('click');
                else toastr.warning('未找到 Connect 按钮，已写入 URL/Key，请手动点连接');

                toastr.success('已切换到「' + p.name + '」', 'API 快切');
                renderAll();
            } catch (err) {
                console.error('[API快切]', err);
                toastr.error(String(err && err.message || err), 'API 快切失败');
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

        function fetchTimeout(url, opts, ms) {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), ms || 8000);
            return fetch(url, Object.assign({}, opts, { signal: ac.signal })).finally(() => clearTimeout(t));
        }

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

                // 2) 酒馆服务端代理（需要把目标 Key 临时写入密钥库）
                await writeKey(useKey);
                wroteProxyKey = true;
                $('#api_key_custom').val(useKey);
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
                            if (String($('#api_key_custom').val() || '') === useKey) {
                                $('#api_key_custom').val(restore);
                            }
                        }).catch(() => {});
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
            if (p.model) $('<span class="aqs-chip aqs-chip-model"></span>').text(p.model).appendTo(meta);
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
            for (const g of groupNames()) {
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
        }

        function renderList() {
            const list = $('#aqs_profile_list').empty();
            const names = groupNames();
            for (const k of Object.keys(settings.groupCollapsed)) {
                if (!names.includes(k)) delete settings.groupCollapsed[k];
            }
            renderGroupPicker();
            if (!settings.profiles.length) {
                list.append($('<div class="aqs-empty">还没有站点，在下方添加第一个吧</div>'));
                return;
            }
            settings.profiles.filter((p) => !p.group).forEach((p) => list.append(profileCard(p)));
            for (const g of groupNames()) {
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
                items.forEach((p) => body.append(profileCard(p)));
                box.append(body);
                list.append(box);
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
        function buildProfileItems($root, { closeOnClick } = {}) {
            $root.empty();
            if (!settings.profiles.length) {
                $root.append($('<div class="aqs-empty">先去扩展设置里添加站点</div>'));
                return;
            }
            const addItem = (p) => {
                const item = $('<div class="aqs-qp-item"></div>').toggleClass('aqs-active', isActive(p));
                $('<span class="aqs-qp-name"></span>').text(p.name).appendTo(item);
                if (p.model) $('<span class="aqs-qp-model"></span>').text(p.model).appendTo(item);
                item.on('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (closeOnClick) $('#aqs_quick_panel').hide();
                    await applyProfile(p);
                    renderAll();
                });
                $root.append(item);
            };
            settings.profiles.filter((p) => !p.group).forEach(addItem);
            for (const g of groupNames()) {
                $('<div class="aqs-qp-group"></div>').text(g).appendTo($root);
                settings.profiles.filter((p) => p.group === g).forEach(addItem);
            }
        }

        function renderQuickPanel() {
            const panel = $('#aqs_quick_panel');
            if (!panel.length) return;
            buildProfileItems(panel, { closeOnClick: true });
            panel.prepend($('<div class="aqs-qp-title"><i class="fa-solid fa-shuffle"></i> API·SWITCH</div>'));
        }

        function renderApiEmbed() {
            const body = $('#aqs_api_embed_body');
            if (!body.length) return;
            buildProfileItems(body, { closeOnClick: false });
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

            const btn = $(`
                <div id="aqs_wand_btn" class="extension_container interactable" tabindex="0" title="API 快切">
                    <div class="list-group-item flex-container flexGap5 interactable">
                        <div class="fa-solid fa-shuffle extensionsMenuExtensionButton"></div>
                        API 快切
                    </div>
                </div>
            `);
            btn.on('click touchend', function (e) {
                // touchend 在部分安卓 WebView 比 click 更稳；防双触发
                if (e.type === 'touchend') {
                    e.preventDefault();
                    if (btn.data('aqs-touch-lock')) return;
                    btn.data('aqs-touch-lock', 1);
                    setTimeout(() => btn.removeData('aqs-touch-lock'), 350);
                }
                e.stopPropagation();
                const panel = $('#aqs_quick_panel');
                if (panel.is(':visible')) {
                    panel.hide();
                    return;
                }
                renderQuickPanel();
                panel.show();
                // 打开后把面板尽量贴近按钮
                try {
                    const r = this.getBoundingClientRect();
                    const ph = panel.outerHeight() || 200;
                    const top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.top - ph - 8));
                    const left = Math.max(8, Math.min(window.innerWidth - (panel.outerWidth() || 280) - 8, r.left));
                    panel.css({ top: top + 'px', left: left + 'px', bottom: 'auto' });
                } catch { /* ignore */ }
            });

            // 优先塞进 extension_container 区域
            const container = menu.find('.extension_container').first();
            if (container.length) container.append(btn);
            else menu.append(btn);
            return true;
        }

        function ensureFloatingPanel() {
            if ($('#aqs_quick_panel').length) return;
            $('body').append('<div id="aqs_quick_panel" style="display:none;"></div>');
            $(document).on('mousedown.aqs_qp touchstart.aqs_qp', (e) => {
                const $t = $(e.target);
                if ($t.closest('#aqs_quick_panel, #aqs_wand_btn').length) return;
                $('#aqs_quick_panel').hide();
            });
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
        `;

        ctx.extensionSettings[MODULE] = settings;
        const container = $('#extensions_settings2, #extensions_settings').first();
        if (container.length) {
            container.append(html);
        } else {
            // 某些移动端壳子设置面板晚挂载
            const waitSettings = setInterval(() => {
                const c = $('#extensions_settings2, #extensions_settings').first();
                if (!c.length) return;
                clearInterval(waitSettings);
                if (!$('.aqs-settings').length) c.append(html);
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
