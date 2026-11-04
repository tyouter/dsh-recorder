# 录制脚本规范 v1

给「插件录制器」（`@tyouter/dsh-recorder`）用的脚本格式。面板和 `recorder_demo` 工具读同一种脚本：页面会按它真实地打字、点击、选中、切面板，同时把真实窗口录成 GIF。

一份脚本 = 一次演示。目标：**可重放、无副作用、画面跟得上**。

## 两种写法

**逐行（人写、推荐）**

```
# 注释
open notes
wait .dshn-root
click .dshn-switch[aria-checked="true"]
set .dshn-textarea |
click .dshn-textarea
type .dshn-textarea | 第一行\n第二行
sleep 900
select .dshn-textarea | 第二行
sleep 1200
```

**JSON（机器生成，等价）**

```json
[
  { "op": "openPanel", "panel": "notes" },
  { "op": "wait", "selector": ".dshn-root" },
  { "op": "click", "selector": ".dshn-textarea" },
  { "op": "type", "selector": ".dshn-textarea", "text": "第一行\n第二行", "ms": 45 },
  { "op": "select", "selector": ".dshn-textarea", "text": "第二行" }
]
```

页面以 `[` 开头判断 JSON，否则按行解析。两种写法可混用的只有“文件里选一种”。

## 指令

| 行写法 | JSON `op` | 参数 | 说明 |
| --- | --- | --- | --- |
| `open <panel>` | `openPanel` | `panel` | 切到插件主面板（`main` 的 key，如 `notes`、`wuche`） |
| `click <sel> [| 文字]` | `click` | `selector`, `text` | 点击。`文字` 用于在多个匹配里挑（可见文案） |
| `type <sel> | 文字` | `type` | `selector`,`text`（`ms` 可设每字毫秒，默认 60） | 逐字输入，`\n` 换行 |
| `set <sel> | 文字` | `setValue` | `selector`,`text` | 一次性赋值；`set x |`（竖线后空）表示清空。只用于 textarea/input |
| `paste <sel> | 文字` | `paste` | `selector`,`text` | 把文字插入输入框（走浏览器 `insertText`）；富文本 contenteditable 用这个 |
| `select <sel> | 文字` | `select` | `selector`,`text` 或 `from`,`to` | 选中文字（字符下标也可） |
| `wait <sel> [毫秒]` | `wait` | `selector`,`timeoutMs` | 等元素可见，默认 8000 |
| `sleep <毫秒>` | `sleep` | `ms` | 停顿 |
| `key <sel> <键>` | `key` | `selector`,`key` | `Tab` / `Enter` / `Escape` / `ArrowDown` … |
| `scroll <sel>` | `scroll` | `selector` | 滚到元素 |
| `focus <sel>` | `focus` | `selector` | 聚焦 |

JSON 的 `steps` 里还可以加 `strict: true`（由调用方传入，不在步骤里）——失败即停；默认失败记一笔后继续。

## 选择器规则（最容易错的地方）

1. **必须来自真实 DOM**，不要凭想象写。拿不准时用录制器的 `recorder_scan` 读当前页面。
2. 优先级：插件自己的类名前缀（`.dshn-…`）→ `[role=…]` / `[aria-label=…]` → 结构选择器。
3. **不要用哈希类名**（`wtg9ga_…`、`_button_1rv3m_2` 这类构建产物），也不要依赖 `nth-child` 的偶然顺序；宿主 UI 改版就会断。
4. 点按钮优先写 `click <容器> | 按钮文字`：文案比类名稳定，且中英文切换也能命中。
5. 一个选择器要唯一命中；有歧义时用更具体的类名/属性收窄，而不是加 `:nth-child`。
6. 面板切换后的元素在切换前不存在——所以 `open` 之后先 `wait` 一个该面板的根选择器，再操作。

**给插件作者的更稳约定**：在关键控件上挂一个语义属性，例如
`<button data-demo="capture-save">`，脚本里写 `click [data-demo="capture-save"]`。
它不随类名重构、文案改语言、布局调顺序而失效，是长期演示最省心的一种选择器。

## 节奏与安全

- 切面板、长耗时操作后加 `wait` 或 `sleep`（300–900 ms），否则画面和操作不同步。
- 打字前先 `click` 输入框；可重放的脚本应先 `set … |` 清空，再 `type`。
- 宿主会话的提问框是 contenteditable；用 `paste` / `type`，不要用 `set`。
- 8–15 步、10–20 秒为宜；超过 20 步通常该拆成两条。
- **不要**保存、删除、提交、发消息、调用模型或消耗 token；演示应可重复、无副作用。用户明确要求展示“保存”时才做，并在文案里说明。
- 失败步骤默认继续：录制不会因为一个可选按钮消失而整段中断；演示里重要的步骤前用 `wait` 兜底。

## 给“另一个 agent”的生成约定

把录制器的 prompt 粘贴给了解目标插件的 agent 时，要求它：

- 只输出**一个** ```text 代码块（或一个 ```json 数组），不要解释、不要多段代码；
- 从插件源码里找类名/`aria-label`，不要猜宿主 UI 的类名；
- 如果用户给了「当前页面元件清单」，优先用清单里的 selector 和文字；
- 说明哪些选择器是推断的（代码块外一句话）；
- 不写保存/删除/提交类步骤，除非用户要求。

## 常见失败

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `no visible element matches …` | 选择器不存在/被折叠 | 先 `open` + `wait` 根元素；确认类名 |
| 点错按钮 | 选择器命中多个 | 加 `| 文字`，或用更具体的类名 |
| 打字没反应 | 输入框是富文本 contenteditable（如宿主的提问框），旧版 set 改不动它 | 用 `paste`（或 `type`，现已走 insertText + InputEvent） |
| 画面停在旧面板 | 切面板后没等 | 在 `open` 后 `wait` 面板根元素 |
| 中文变成 `?` | 脚本以非 UTF-8 编码写入 | 用面板/工具直接传字符串，不要经 ANSI 编码的 shell |
| 录制里出现别的应用 | 录制中焦点被抢 | 结果会带 `⚠`；重录时让 Harness 窗口保持前台 |
