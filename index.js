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
    const VERSION = '1.2.1';
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
        settings.profiles.forEach((p) => { if (!p.id) p.id = uid(); });

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
                await writeKey(p.key);

                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('custom').trigger('change');
                await sleep(150);

                $('#custom_api_url_text').val(p.url || '').trigger('input');
                // 关键修复：同步可见密钥输入框。酒馆的“连接”按钮会把该输入框的残留内容
                // 重新写回密钥库，若不同步，旧 Key 会覆盖刚写入的新 Key（经典切换失效 bug）
                $('#api_key_custom').val(p.key || '').trigger('input').trigger('change');
                if (p.model) $('#custom_model_id').val(p.model).trigger('input');
                await sleep(150);

                $('#api_button_openai').trigger('click');

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

        async function checkUpdate(silent) {
            if (updState === 'checking' || updState === 'updating') return;
            setUpdateState('checking');
            for (const g of [false, true]) {
                try {
                    const res = await fetch('/api/extensions/version', {
                        method: 'POST',
                        headers: ctx.getRequestHeaders(),
                        body: JSON.stringify({ extensionName: EXT_NAME, global: g }),
                    });
                    if (!res.ok) continue;
                    const data = await res.json();
                    updGlobal = g;
                    if (data.isUpToDate === false) {
                        setUpdateState('available');
                        if (!silent) toastr.info('发现新版本，点按钮一键更新', 'API 快切');
                    } else {
                        setUpdateState('latest');
                        if (!silent) toastr.success('已是最新版本 v' + VERSION, 'API 快切');
                    }
                    return;
                } catch { /* 尝试下一种 */ }
            }
            setUpdateState('idle');
            if (!silent) toastr.warning('无法检查更新：需通过「安装扩展」粘贴仓库链接安装才支持', 'API 快切');
        }

        async function doUpdate() {
            setUpdateState('updating');
            try {
                const res = await fetch('/api/extensions/update', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ extensionName: EXT_NAME, global: updGlobal }),
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                setUpdateState('updated');
                if (confirm('更新完成！立即刷新页面使新版本生效？')) {
                    location.reload();
                }
            } catch (err) {
                setUpdateState('available');
                toastr.error(String(err && err.message || err), '更新失败');
            }
        }

        /* ---------------- 模型列表获取 ---------------- */
        async function fetchModelList(url, key) {
            await writeKey(key);
            const res = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ chat_completion_source: 'custom', custom_url: url }),
            });
            if (!res.ok) throw new Error('接口返回 HTTP ' + res.status);
            const json = await res.json();
            if (json && json.error) throw new Error(json.message || '接口报错');
            const arr = Array.isArray(json) ? json : (json.data || json.models || []);
            const models = arr
                .map((m) => (typeof m === 'string' ? m : (m.id || m.model || m.name)))
                .filter(Boolean);
            if (!models.length) throw new Error('接口没有返回模型列表');
            return [...new Set(models)].sort();
        }

        function openModelPicker(url, key, onPick) {
            url = normUrl(url);
            if (!url) { toastr.warning('请先填写接口 URL'); return; }

            $('#aqs_model_modal').remove();
            const overlay = $(`
                <div id="aqs_model_modal">
                  <div class="aqs-modal-box">
                    <div class="aqs-modal-head">
                      <span><i class="fa-solid fa-microchip"></i> MODEL·SELECT<i class="aqs-blink">▊</i></span>
                      <i class="fa-solid fa-xmark aqs-modal-close" title="关闭"></i>
                    </div>
                    <input class="text_pole aqs-modal-filter" placeholder="搜索模型…">
                    <div class="aqs-modal-list">
                      <div class="aqs-modal-loading"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp; SCANNING…</div>
                    </div>
                  </div>
                </div>`);
            $('body').append(overlay);
            const close = () => overlay.remove();
            overlay.on('pointerdown', (e) => { if (e.target === overlay[0]) close(); });
            overlay.find('.aqs-modal-close').on('click', close);

            fetchModelList(url, key)
                .then((models) => {
                    const list = overlay.find('.aqs-modal-list');
                    const render = (filter) => {
                        list.empty();
                        const f = String(filter || '').toLowerCase();
                        const subset = models.filter((m) => m.toLowerCase().includes(f));
                        if (!subset.length) {
                            list.append($('<div class="aqs-empty">没有匹配的模型</div>'));
                            return;
                        }
                        for (const m of subset) {
                            $('<div class="aqs-modal-item"></div>').text(m)
                                .on('click', () => { close(); onPick(m); })
                                .appendTo(list);
                        }
                    };
                    render('');
                    overlay.find('.aqs-modal-filter').on('input', function () { render(this.value); }).trigger('focus');
                    toastr.success('共 ' + models.length + ' 个模型', 'API 快切');
                })
                .catch((err) => {
                    close();
                    console.error('[API快切] 获取模型失败', err);
                    toastr.error(String(err && err.message || err), '获取模型失败');
                });
        }

        /* ---------------- 设置面板：配置卡片 ---------------- */
        function profileCard(p) {
            const active = isActive(p);
            const card = $('<div class="aqs-card"></div>').toggleClass('aqs-active', active);
            card.append($('<span class="aqs-hud aqs-hud-tl"></span>'), $('<span class="aqs-hud aqs-hud-br"></span>'));

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

        function renderList() {
            const list = $('#aqs_profile_list').empty();
            if (!settings.profiles.length) {
                list.append($('<div class="aqs-empty">还没有配置，在下方添加第一个吧</div>'));
                return;
            }
            settings.profiles.forEach((p) => list.append(profileCard(p)));
        }

        function renderAll() {
            renderList();
            if ($('#aqs_quick_panel').is(':visible')) renderQuickPanel();
        }

        /* ---------------- 表单 ---------------- */
        function startEdit(p) {
            editingId = p.id;
            $('#aqs_name').val(p.name);
            $('#aqs_url').val(p.url);
            $('#aqs_key').val(p.key || '');
            $('#aqs_model').val(p.model || '');
            $('#aqs_form_title').text('编辑：' + p.name);
            $('#aqs_save').html('<i class="fa-solid fa-floppy-disk"></i> 保存修改');
            $('#aqs_cancel_edit').show();
        }

        function resetForm() {
            editingId = null;
            $('#aqs_name, #aqs_url, #aqs_key, #aqs_model').val('');
            $('#aqs_form_title').text('新增配置');
            $('#aqs_save').html('<i class="fa-solid fa-plus"></i> 保存配置');
            $('#aqs_cancel_edit').hide();
        }

        function onSave() {
            const name = String($('#aqs_name').val() || '').trim();
            const url = normUrl($('#aqs_url').val());
            const key = String($('#aqs_key').val() || '').trim();
            const model = String($('#aqs_model').val() || '').trim();

            if (!name || !url) { toastr.warning('名称和 URL 必填'); return; }
            if (!/^https?:\/\//i.test(url)) { toastr.warning('URL 需要以 http:// 或 https:// 开头'); return; }

            if (editingId) {
                const p = settings.profiles.find((x) => x.id === editingId);
                if (!p) { resetForm(); return; }
                const dup = settings.profiles.find((x) => x.name === name && x.id !== editingId);
                if (dup) { toastr.warning('已存在同名配置「' + name + '」'); return; }
                Object.assign(p, { name, url, key, model });
                toastr.success('已更新「' + name + '」');
            } else {
                const dup = settings.profiles.find((x) => x.name === name);
                if (dup) {
                    if (!confirm('已存在同名配置「' + name + '」，覆盖它吗？')) return;
                    Object.assign(dup, { url, key, model });
                    toastr.success('已覆盖「' + name + '」');
                } else {
                    settings.profiles.push({ id: uid(), name, url, key, model });
                    toastr.success('已保存「' + name + '」');
                }
            }
            save();
            resetForm();
            renderAll();
        }

        /* ---------------- 导入 / 导出 ---------------- */
        function exportProfiles() {
            if (!settings.profiles.length) { toastr.warning('没有可导出的配置'); return; }
            const data = JSON.stringify({ app: 'st-api-switcher', version: 1, profiles: settings.profiles }, null, 2);
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

        /* ---------------- 快捷面板（魔棒菜单） ---------------- */
        function renderQuickPanel() {
            const panel = $('#aqs_quick_panel').empty();
            $('<div class="aqs-qp-title"><i class="fa-solid fa-shuffle"></i> API·SWITCH</div>').appendTo(panel);
            if (!settings.profiles.length) {
                $('<div class="aqs-empty">先去扩展设置里添加配置</div>').appendTo(panel);
                return;
            }
            for (const p of settings.profiles) {
                const item = $('<div class="aqs-qp-item"></div>').toggleClass('aqs-active', isActive(p));
                $('<span class="aqs-qp-name"></span>').text(p.name).appendTo(item);
                if (p.model) $('<span class="aqs-qp-model"></span>').text(p.model).appendTo(item);
                item.on('click', async () => {
                    $('#aqs_quick_panel').hide();
                    await applyProfile(p);
                });
                panel.append(item);
            }
        }

        function setupQuickPanel() {
            $('<div id="aqs_quick_panel"></div>').hide().appendTo('body');

            const menuItem = $(
                '<div id="aqs_wand_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">' +
                '<i class="fa-solid fa-shuffle"></i><span>API 快切</span></div>'
            );
            $('#extensionsMenu').append(menuItem);
            menuItem.on('click', () => {
                const panel = $('#aqs_quick_panel');
                if (panel.is(':visible')) { panel.hide(); return; }
                renderQuickPanel();
                panel.show();
            });

            $(document).on('pointerdown', (e) => {
                const panel = $('#aqs_quick_panel');
                if (!panel.is(':visible')) return;
                if ($(e.target).closest('#aqs_quick_panel, #aqs_wand_item').length) return;
                panel.hide();
            });
        }

        /* ---------------- 斜杠命令 /apiswitch ---------------- */
        function setupSlashCommand() {
            try {
                const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
                if (!SlashCommandParser || !SlashCommand) return;
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: 'apiswitch',
                    aliases: ['aqs'],
                    helpString: '按名称切换已保存的 API 配置，例如 /apiswitch 中转A；不带参数列出全部配置名。',
                    unnamedArgumentList: SlashCommandArgument ? [SlashCommandArgument.fromProps({
                        description: '配置名称',
                        typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                        isRequired: false,
                    })] : [],
                    callback: async (_args, value) => {
                        const name = String(value || '').trim();
                        if (!name) {
                            const names = settings.profiles.map((p) => p.name).join('、') || '（空）';
                            toastr.info(names, '已保存的配置');
                            return names;
                        }
                        const p = settings.profiles.find((x) => x.name === name);
                        if (!p) { toastr.warning('没有找到配置：' + name); return ''; }
                        await applyProfile(p);
                        return p.name;
                    },
                }));
            } catch (e) {
                console.warn('[API快切] 斜杠命令注册失败（不影响其他功能）', e);
            }
        }

        /* ---------------- 设置面板挂载 ---------------- */
        const html = `
        <div class="aqs-settings">
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b><i class="fa-solid fa-shuffle aqs-grad-icon"></i>&nbsp;API 快切</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="aqs-sys-bar">
                <span class="aqs-sys-id">API·SWITCHER</span>
                <span class="aqs-sys-ver">v${VERSION}</span>
                <i class="aqs-blink">▊</i>
                <span class="aqs-sys-spacer"></span>
                <button id="aqs_update_btn" class="menu_button aqs-btn"><i class="fa-solid fa-satellite-dish"></i> 检查更新</button>
              </div>
              <div id="aqs_profile_list"></div>
              <div class="aqs-io-btns">
                <button id="aqs_export" class="menu_button aqs-btn" title="导出全部配置为 JSON 备份"><i class="fa-solid fa-download"></i> 导出</button>
                <button id="aqs_import" class="menu_button aqs-btn" title="从 JSON 备份导入（同名覆盖）"><i class="fa-solid fa-upload"></i> 导入</button>
                <input type="file" id="aqs_import_file" accept=".json,application/json" hidden>
              </div>
              <hr class="aqs-hr">
              <div id="aqs_form_title" class="aqs-form-title">新增配置</div>
              <input id="aqs_name" class="text_pole" placeholder="配置名称（如：中转A）">
              <input id="aqs_url" class="text_pole" placeholder="接口地址 URL（如 https://xx.com/v1）">
              <input id="aqs_key" class="text_pole" type="password" placeholder="API 密钥 Key" autocomplete="off">
              <div class="aqs-model-row">
                <input id="aqs_model" class="text_pole" placeholder="模型 ID（可点右侧按钮获取）">
                <button id="aqs_fetch_models" class="menu_button aqs-btn" title="从上面填的 URL+Key 获取模型列表"><i class="fa-solid fa-microchip"></i> 获取模型</button>
              </div>
              <div class="aqs-form-btns">
                <button id="aqs_fill_current" class="menu_button aqs-btn" title="读取当前连接面板里的 URL 和模型（Key 无法读取，需手填）"><i class="fa-solid fa-rotate"></i> 读取当前</button>
                <button id="aqs_save" class="menu_button aqs-btn aqs-btn-primary"><i class="fa-solid fa-plus"></i> 保存配置</button>
                <button id="aqs_cancel_edit" class="menu_button aqs-btn" style="display:none">取消编辑</button>
              </div>
              <small class="aqs-note">Key 明文存于本机 settings.json，仅建议个人设备使用。快捷入口：输入框旁魔棒菜单 → API 快切，或命令 /apiswitch 配置名</small>
            </div>
          </div>
        </div>`;

        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        container.append(html);

        $('#aqs_update_btn').on('click', () => {
            if (updState === 'available') { doUpdate(); return; }
            if (updState === 'updated') { location.reload(); return; }
            checkUpdate(false);
        });
        $('#aqs_save').on('click', onSave);
        $('#aqs_cancel_edit').on('click', resetForm);
        $('#aqs_fill_current').on('click', () => {
            $('#aqs_url').val($('#custom_api_url_text').val());
            $('#aqs_model').val($('#custom_model_id').val());
            toastr.info('已填入当前 URL 和模型，Key 需手动填写');
        });
        $('#aqs_fetch_models').on('click', () => {
            const url = normUrl($('#aqs_url').val());
            const key = String($('#aqs_key').val() || '').trim();
            openModelPicker(url, key, (m) => $('#aqs_model').val(m));
        });
        $('#aqs_export').on('click', exportProfiles);
        $('#aqs_import').on('click', () => $('#aqs_import_file').trigger('click'));
        $('#aqs_import_file').on('change', function () {
            if (this.files && this.files[0]) importProfiles(this.files[0]);
            this.value = '';
        });

        let urlTimer = null;
        $(document).on('input', '#custom_api_url_text', () => {
            clearTimeout(urlTimer);
            urlTimer = setTimeout(renderAll, 500);
        });

        setupQuickPanel();
        setupSlashCommand();
        renderList();
        setTimeout(() => checkUpdate(true), 3000);

        console.log('[API快切] v' + VERSION + ' 已加载');
    });
})();
