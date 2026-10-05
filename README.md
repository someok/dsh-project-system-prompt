# @someok/dsh-project-system-prompt

在**项目根目录**放 markdown 文件，覆盖或追加当前模式的系统提示词——DSH 版的 `SYSTEM.md`（类似 pi / oh-my-pi）。

## 解析顺序

每个模型步骤都会重新解析一次，项目根 = 会话工作目录向上最近的含 `.git` 的祖先目录（没有 `.git` 时就是工作目录本身），与 DSH 自己的 `AGENTS.md` / `.dsh/skills` 规则一致：

| 优先级 | 文件 | 行为 |
|---|---|---|
| 1 | `<root>/.dsh/SYSTEM.md` | **覆盖**：系统提示词 = 该文件内容，当前模式（preset）自己的提示词段落全部被替换 |
| 2 | `<root>/SYSTEM.md` | 同上（仅在 1 不存在时） |
| 3 | `<root>/.dsh/SYSTEM.append.md` | **追加**：附加在现有系统提示词之后 |
| 4 | `<root>/SYSTEM.append.md` | 同上（仅在 3 不存在时） |

- 覆盖与追加可以同时存在：此时追加内容接在覆盖内容之后，作为同一个系统提示词（两者各自独立解析变量与 frontmatter）。
- 两者都不存在（或文件只有空白）→ 完全交给当前模式，行为与未安装本插件一致。
- 追加是加在所有段落之后；真实运行时的动态上下文（sandbox 策略、approval 策略、时间等）不受影响，仍会照常注入。
- 每次 assemble 都重新读盘：改文件下一次模型步骤生效，删掉文件立刻恢复模式提示词，不需要重启。

## 变量插值（默认开启）

文件里可以引用本次装配已注册的提示词变量，默认替换为实际值：

| 变量 | 值 |
|---|---|
| `{{model}}` | 当前路由的模型名 |
| `{{provider}}` | 当前路由的 provider |
| `{{cwd}}` | 会话工作目录 |

其它插件注册的变量同样可用。规则：

- **未知变量、写法不合法（如 `{{a.b}}`、`{{ spaced }}`）、已注册但本次没有取值的变量**一律**原样保留**，不会像 harness 自带渲染那样直接报错——项目文件永远不会把一次请求搞崩。
- 替换进去的值不会被二次扫描（值里再写 `{{x}}` 也不会被替换）。
- 想输出字面量 `{{cwd}}`，写 `\{{cwd}}`（仅在插值开启时有意义）。

### 自己决定是否插值

在文件**第一行**用 frontmatter 关闭或显式开启：

```markdown
---
interpolate: false
---
这里的 {{cwd}} 会原样保留
```

布尔写法支持 `true/false`、`yes/no`、`on/off`、`1/0`（大小写不敏感）；`interpolate` 缺省为 `true`。

只有满足「首行是 `---`、后面有闭合的 `---`、中间每行都是受支持的 `key: value`」才会被当作 frontmatter 并从提示词里删掉；否则整段原样留在提示词里——所以文件开头的普通 markdown 分隔线不会被误吃。

## 作用范围

这是挂在 host 层的行，因此对**所有模式**（standard / ptc / minimal / cordis）以及它们的子代理生效；解析基于该 agent 自己的会话工作目录，所以同一进程里不同项目的会话互不干扰。

覆盖是彻底的：`SYSTEM.md` 生效时，harness 身份、"你是由 X 模型驱动的编码代理"、"工作目录是 Y"、工具 SDK 说明等段落都会被替换掉（工具本身照常可用）。如果你只想加规则而不想丢失这些，用 `SYSTEM.append.md`。

## 安装

已发布到 npm：[`@someok/dsh-project-system-prompt`](https://www.npmjs.com/package/@someok/dsh-project-system-prompt)

在终端里装进你的 profile（`<profile>` 换成 profile 名，如 `desktop`、`web`）：

```bash
dsh plugin --profile <profile> add @someok/dsh-project-system-prompt
```

也可以让会话内的 agent 直接装：

```
plugin_manager  action: install_bundle  target: @someok/dsh-project-system-prompt
```

两种方式都会把依赖写进 `~/.dsh/profiles/<profile>/package.json`，并把 `@someok/dsh-project-system-prompt` 追加进 `dsh.profile.bundles`；其 `cordis.patch.yml` 插入 `project-system-prompt` 行（该行以相对路径 `./lib/plugin.js` 引用插件，路径相对 patch 文件解析）。装好后**重启 Desktop 应用**生效。

### 本地开发：装工作区里的代码

要改插件本身时，用 `link:` 指向工作区，免得每改一行都发一次版：

```bash
dsh plugin --profile <profile> add link:/绝对路径/dsh-project-system-prompt
```

这样 `node_modules/@someok/dsh-project-system-prompt` 只是指向工作区的符号链接，跑的就是你正在编辑的代码。

### 改完插件代码怎么生效

- 当前进程**不会**热重载本插件：DSH 的 HMR 监视 profile 目录并忽略 `**/node_modules`，而 bundle 是以 `link:` 安装的（代码在工作区）。
- 生效方式：重启 Desktop 应用（profile 启动时重新导入），或对 bundle / 该行做一次 disable→enable 触发重新装配——注意 ESM 模块缓存按 URL 命中，**同一路径不会重新求值**，只有改了模块路径（重命名文件并同步 `cordis.patch.yml`）才会真正加载新代码。
- 从 npm 安装的版本升级后同样要重启：`dsh plugin --profile <profile> add @someok/dsh-project-system-prompt@<新版本>`，然后重启应用。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/plugin.js` | 插件本体：`system-prompt/assemble` waterfall 监听器、文件解析、frontmatter、变量替换 |
| `cordis.patch.yml` | bundle patch：向 profile 插入一行 |
| `test/plugin.test.mjs` | 解析、frontmatter、插值与改写逻辑的用例（`node --test test/plugin.test.mjs`） |

## 限制

- 项目内切换工作目录（例如在子目录里开会话）不会改变项目根：根永远取最近的 `.git` 祖先。
- 单文件读取上限 1 MiB，超出部分截断并附一行说明。
- 提示词被替换后，模型若在会话中途"忘记"工具用法，属于预期副作用。
- 只按字面匹配变量名（`[a-z][a-z0-9_]*`），不做表达式、默认值、条件等模板语法。
