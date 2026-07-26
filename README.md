# API 快切 (ST API Switcher)

SillyTavern（酒馆）扩展：一键切换 OpenAI 兼容接口的 **URL + API Key + 模型**。

酒馆内置的"连接配置文件"不会为自定义端点保存各自的 Key（所有自定义端点共用一个 Key 槽位），每次换中转站都要手动改 URL、贴 Key、重新保存。本扩展把这三样绑成一个配置，点一下整套切换并自动重连。

## 功能

- 🗂️ **配置卡片**：保存任意多个「名称 + URL + Key + 模型」组合，当前生效的配置高亮显示
- ⚡ **一键切换**：点「使用」自动写入 Key → 切换到自定义(OpenAI 兼容)接口 → 填入 URL/模型 → 自动连接
- 🪄 **魔棒快捷面板**：聊天输入框旁的魔棒菜单 → API 快切，聊天中随手切换，无需进设置
- ⌨️ **斜杠命令**：`/apiswitch 配置名`（别名 `/aqs`），可配合快速回复（Quick Reply）做成按钮
- 📦 **导入 / 导出**：JSON 备份，换设备不用重填
- 🔄 **内置一键更新**：面板顶部自动检测新版本，点一下即可更新，无需进管理界面
- 🛸 **FUI 科幻界面**：HUD 角框、CRT 扫描线、雷达脉冲、霓虹渐变边框、等宽数据读出
- ✏️ 编辑、删除（带确认）、同名覆盖确认、「读取当前」快速录入

## 安装

### 方式一：通过链接安装（推荐）

酒馆 → 扩展面板（三个方块图标）→ **安装扩展 (Install extension)** → 粘贴本仓库地址：

```
https://github.com/idx425/st-api-switcher
```

### 方式二：手动安装

把本仓库文件夹放入酒馆目录：

```
SillyTavern/data/default-user/extensions/st-api-switcher/
```

（较老版本放 `SillyTavern/public/scripts/extensions/third-party/st-api-switcher/`），然后刷新页面。

## 使用

1. 扩展面板 → **API 快切** 抽屉
2. 填写名称、URL、Key、模型（可选）→ **保存配置**
3. 切换：点配置卡片上的 **使用**，或魔棒菜单 → API 快切，或 `/apiswitch 配置名`

## 注意事项

- 需要 SillyTavern **1.12+**
- Key 以明文存储在本机 `settings.json` 中（酒馆扩展设置的通用机制），仅建议在个人设备上使用，导出的备份文件同样包含明文 Key
- "当前"高亮按 URL 匹配判断（Key 出于安全无法读回比对）
- 仅作用于「聊天补全 → 自定义(OpenAI 兼容)」接口来源

## License

MIT
