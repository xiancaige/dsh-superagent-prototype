# Phase 2 D：交付权限与原图职责对照

## 范围与结论

本页按当前工作树源码核对能力边界，区分实现、接线约定与缺口；不是生产发布验收记录。A/B/C/D **不能宣称完整替代原图**：CQTest、UE 编译与资产操作仍未覆盖；真实 Git push、PR 与正式发布 adapter 不内置。

D 只增加交付授权与持久副作用账本，不修改 C 生命周期，不启图、不自动远端操作，也不把普通开发工单的 `ready` 解释为发布授权。测试目标只能使用本地临时目录或模拟目标，不以正式渠道做验收。

## 独立授权与共享门禁

实现主体：[Deliveries](<../src/core/delivery.ts>) 的 `grant`、`check`、`execute`。

- `commit`（本地）、`push`（远端）、`release`（打包/上传/发布）三项独立授权，缺省均关闭；其中一项不授予其他项。
- 授权由 host/operator 配置；worker 只能请求执行。host 直接执行与 worker 请求共用 `check`，不存在 host 绕过入口。
- 每次 grant 绑定 ticket、assignment、真实 workspace、当前内容 fingerprint、验收状态摘要、target、version；有效期为一小时。另对 push/release 的 unittest 和配置视觉证据实行一小时 freshness 检查（缺失/无效时间、超过 5 分钟的未来时间均拒绝）；这不改变 A/B 普通 ready 的历史规则。
- 修改内容、改变 assignment、改变证据或目标版本后，旧授权不能继续执行；须重新验收并重新授权。即使内容相同，授权也不能跨 assignment 使用。
- `push` / `release` 强制要求 strict unittest contract 与 host 留存的通过证据；缺失、未启用 strict、仅视觉合同均不足。继续复用 strict acceptance gate，并在配置视觉项时检查视觉证据及磁盘产物。
- `push` / `release` 必须由本 ticket **当前持有**环境独占。没有环境 port、已交接、他人持有均拒绝；执行入口不自动重新取锁，也不以历史验收或 completed 代替 `holds`。
- 拒绝写入持久 refusal 事实，返回具体原因；无权 release 不静默降级为 commit。

验收复用：[strict binding/gate](<../src/core/validation.ts>)、[真实 unittest 与内容指纹](<../src/validation.ts>)、[视觉结论与帧摘要](<../src/core/validation.ts>)。不能把报告文本或 worker 提交的“通过 JSON”当成证据。

## 已实现接线与开发时序

HTTP 管理面 `tickets/:id/delivery` 提供 GET（状态）、PUT（operator 授权/撤销）、POST（执行请求）；沿用现有管理路由的同源检查与严格 schema。对应接线位置为 [HTTP routes](<../src/app/http.ts>)、[API 类型表](<../src/app/api.ts>)。这不是给 worker 增加 operator 身份：worker 工具只能以闭包绑定的 ticket 与当前 assignment 请求 action/request id，不能选择任意命令、伪造证据、上传 receipt 或 grant；已实现工具 `orchestrator_request_delivery`，参见 [executor tools](<../src/app/tools/executor.ts>)。

推荐顺序：

1. 开发 assignment 在原工单独占中完成修改。
2. host 运行可信 unittest，并完成合同要求的视觉验收。
3. operator 对当前绑定分别授予所需交付等级。
4. **在 ready 前且仍持 lease 时**请求交付；先检查、持久预留，再执行 trusted target。
5. 报告 ready；ready 不 grant、不调用 delivery、不自动重发副作用。

当前 [Assignments.report](<../src/core/assignments.ts#L100-L135>) 中，无 follows 的 ready 可直接结束 ticket。D 不新增 ready 后发布的旁路；已 ended 的 ticket 不得靠旧 lease 或完成状态继续交付。若未来需要 ready 后交付，应另设计显式 delivery-pending 生命周期与独占释放规则，而不是放宽当前 gate。

## Trusted target 与幂等

[DeliveryTarget](<../src/core/delivery.ts>) 是由 host 显式注入的可信 adapter，不接收 worker 自定义 command。未配置 target 时拒绝授权/执行；默认不执行真实 push、打包或上传。模拟目标仅在本地临时目录验证协议。运行时仅当 host 显式设置 `DSH_SUPERAGENT_DELIVERY_SIMULATION=1` 时创建 [SimulatedDelivery](<../src/app/simulated-delivery.ts>)，receipt 写至 stateDir 的 `delivery-simulation/`；默认无 target。本工单未安装/启用该运行时开关。

Target 的 `version(workspace)` 必须代表确切、不可变的交付内容。Git adapter 将来必须把提交身份及必要的 HEAD/index 状态纳入版本，并保证交付提交树对应受验内容；仅工作树文件 fingerprint 不足以证明即将 push 的历史正确。

持久账本语义是 **at-most-once dispatch，不是远端 exactly-once**：

- 以 ticket、workspace、等级、target、内容及 version 生成 operation key；更换 request id 不能重复执行同一 operation。
- 同一次原子检查中先保存 `running` 预留，再调用 target；只有预留者可 dispatch。
- 成功保存 durable receipt，标为 `delivered`；重复命中已有 operation 返回其状态，不再次执行。
- 超时、异常、非成功返回都不能证明目标未发生副作用；标为 `uncertain`。中断遗留的 `running` 与 `uncertain` 均不自动重发。
- 未解决操作阻止后续新副作用。恢复须人工核查目标侧 operation key/receipt 并 reconcile；本页不宣称已有自动 reconcile API，也不建议直接删账本重试。
- 若目标包含 push 与 PR 等多个子副作用，adapter 必须用相同 key 自行覆盖并可核验；当前**不内置 PR 或真实 push/release adapter**。

## 原图职责逐项对照

“已覆盖”只指该行列明的插件协议能力，不表示整个 UE 游戏研发流程等价；未配置可选能力时也不自动获得相应验收。

| 原图职责 | 状态 | 当前源码依据与边界 |
|---|---|---|
| 需求与范围 | 已覆盖（工单协议） | [路由 schema](<../src/app/tools/main.ts#L47-L67>) 区分 accept/attach/ignore/stop；[Tickets.create](<../src/core/tickets.ts#L38-L75>) 留存 mandate、来源与 assignment。覆盖来源到工单的范围归属，不替人做需求正确性判断。 |
| 设计确认 | 部分覆盖（可选结构化门） | [design](<../src/core/design.ts>) 由管理端配置必要任务的设计文档及范围，批准绑定文档摘要、工单和 assignment；启动与完成重新核验。见 `013-design-confirmation.md`。不自动判断哪些需求必须设计，也不追溯撤销配置前的实施。 |
| 修改 | 部分覆盖 | [DshExecutor 启动](<../src/executor/dsh.ts#L430-L459>) 在 ticket workspace 准备 worker Session 并发送 assignment；不等于插件内置 UE 代码/资产编辑能力。**资产操作未覆盖**。 |
| 审查 | 部分覆盖（可选独立签核门） | [review](<../src/core/review.ts>) 配置实施者/审查者，管理端代录判决；拒自签、缺签、驳回、版本或 assignment 变化，完成/result/各级交付共用检查。见 `012-independent-review.md`。身份为受信 operator 声明，非 OS 认证；不自动证明审查质量。 |
| 编译 | 未覆盖（UE） | [validation adapter](<../src/validation.ts#L98-L121>) 接受显式配置的 `python-unittest` 与 `node-test`；[编辑器恢复](<../src/app/editor-recovery.ts#L458-L512>) 的启动/握手不是 UE 编译。**UE C++ 编译及编译结果验收未覆盖**。 |
| 测试 | 部分覆盖 | [validation](<../src/validation.ts>) 运行真实 Python unittest 或 Node 内置 node:test，并校验必需用例、退出状态及版本绑定（不解析 stdout 伪成功）；[strict gate](<../src/core/validation.ts>) 将证据接入验收。**CQTest runner、Gauntlet 与 UE 测试报告适配未覆盖**。 |
| 视觉 | 部分覆盖 | 截图与读图由 worker 用项目编辑器自带工具完成，[Engine.recordVisual](<../src/core/engine.ts>) 只记录结论并校验每帧 sha256；宿主不再代截图、不托管 inspector。**不替代人工对画面语义的判断**。 |
| 返工 | 已覆盖（工单协议） | [Tickets.retry](<../src/core/tickets.ts#L200-L211>) 结束 stalled assignment、建立新 assignment；[strict binding](<../src/core/validation.ts>) 阻止沿用其他 assignment 的证据。交接后重做仍须重新获取独占，delivery 不代取。 |
| 恢复 | 部分覆盖 | [编辑器 recover](<../src/app/editor-recovery.ts#L458-L516>) 限制恢复次数，核验进程/端口与握手；[runtime lease 恢复](<../src/app/runtime.ts#L338-L355>) 恢复 live ticket；D 账本防重复 dispatch。不是通用所有副作用的自动恢复；下述 C completion 风险为历史记录，修复见 C+D 综合验收补充。 |
| 交付 | 部分覆盖 | [Deliveries](<../src/core/delivery.ts>) 提供独立授权、共享 gate、持久拒绝与 at-most-once 预留；仅显式注入 trusted target。真实 push、PR、打包/上传/正式发布 adapter 及其目标侧 receipt reconcile 集成未覆盖。 |

## 已知 C 基线风险（本次 D 不修改）

源码核对：[Tickets.end](<../src/core/tickets.ts#L377-L405>) 对 completed 不调用环境 `end`，注释将释放职责留给 host；[runtime ended 回调](<../src/app/runtime.ts#L250-L256>) 仅调用 recovery cleanup，未接通成功 completion 的 lease 释放。与此同时，[恢复逻辑](<../src/app/runtime.ts#L338-L355>) 仅恢复 live ticket 的 lease handle。

因此成功 ready/completed 后可能遗留租约；重启后 completed ticket 不恢复 handle，环境可能继续被旧 record 阻塞。D **不能依赖这个遗漏保持交付资格**：ready 前请求、ended 检查与 `holds` 要求均保留，不能豁免独占、自动抢锁或把 cleanup 等同于 lease 释放。该风险需独立 C 生命周期修复与成功 completion/重启回归，不在 D 文档中宣称已修复。

## 信任与一致性边界

这是工作流授权边界，不是对同一 OS 用户下恶意代码的安全沙箱。workspace fingerprint 只比较观测状态，`.git` 等生成目录不在内容指纹内；独占协调其他 ticket，不锁住外部人工修改。检查到 adapter 执行之间无恶意同用户隔离或完整 TOCTOU 保证。生产 adapter 须交付不可变 payload，并校验目标版本；不能从本地模拟通过推断这些能力已经具备。

## 验证记录

2026-11-03，本工单独立 worktree `wt/dsh-plugins/dsh-superagent`，Node 24.19.0、pnpm 11.7.0；以 C 工作树最新插件源码为起点。最终源码验收（17:29 开始）真实结果：

```powershell
pnpm install --frozen-lockfile
pnpm exec vitest run tests/phase2d-delivery.spec.ts tests/phase2d-tool.spec.ts tests/phase2c-engine.spec.ts tests/phase2c-exclusive.spec.ts tests/strict-validation.spec.ts tests/visual-gate.spec.ts tests/visual-integrity.spec.ts tests/core-engine.spec.ts tests/docs.spec.ts tests/model-surface.spec.ts tests/http.spec.ts tests/tools.spec.ts --testTimeout=30000 --hookTimeout=30000
pnpm typecheck
pnpm run build
git diff --check
```

- 安装 exit 0；最终定向 **12 文件、298/298 通过**，46.78 秒，exit 0；其中 D 新增 **38 项交付行为 + 25 项 worker 工具边界**。
- 最终 typecheck / build 均 exit 0；构建只产生本工单忽略的 `lib/`，未安装到运行 profile。patch whitespace 检查 exit 0。
- 独立复审发现 request alias 未落盘可在重新授权后改绑版本，已修复：所有 accepted request id（含重复 operation 的别名）都持久绑定。新增 SQLite 重开、跨等级/版本拒绝与新请求允许回归通过；复审 probe 亦确认不重发。
- 曾完整运行 `pnpm exec vitest run --testTimeout=30000 --hookTimeout=30000`：**1345 通过、48 失败、17 错误（72 文件）**，257.24 秒，exit 1。它不是最终全量绿证据：含 Windows 缺 `sh`/`sleep`、shell/权限模式差异及当时尚未修完的文档/工具面漂移。后两类 D 漂移已在上述最终定向中修复并通过；没有改低预算或跳过原有验收来刷绿。
- 未修改 C 基线执行 `tests/model-surface.spec.ts tests/runtime.spec.ts tests/store.spec.ts` 对照：110 通过 / 5 失败（runtime 4、store POSIX 权限 1），exit 1，确认这 5 项在 C 同样失败；未声称其余全部全量失败都逐项重跑证实为基线。
- 最初 5 秒默认 timeout 的定向出现 3 个真实 Git/Python 超时，命令级提升等待上限至 30 秒后同批行为通过；未改变任何行为期望。
- 未运行 UE 编译、CQTest 或实际资产编辑；未真实 commit/push/建 PR/发布，未访问远端，未自行重启或安装宿主。真实运行 profile 加载验证留给父会话集成，本源码交付不宣称当前 GUI 已加载。

交付文件以本工单 **`wt/` 独立 worktree** 为准。工单目录此前无 `.git` 的 `dsh-plugins/` 是旧未通过草稿，不应集成。相对复制的 C 基线，本次 D 仅涉及 delivery core、模拟 target、Engine/model/options、HTTP/API/runtime/executor-tool 接线、文档与定向测试；C 环境源码未重复研发。

可复用 fixture：[环境 broker](<../tests/fixtures/environment.ts>)、[C engine harness](<../tests/fixtures/engine-harness.ts>)、[真实 unittest 验收用例](<../tests/strict-validation.spec.ts>)、[HTTP schema/同源用例](<../tests/http.spec.ts>)。其中 C harness 不包含 runtime completion 回调，不能单独证明运行时成功释放。


## C+D 综合验收补充（2026-11-03）

**生命周期（C）**：成功 ready/completed 经宿主验收后，先停止本工单自己启动的编辑器（按 PID 精确停止，并核对记录的进程创建时间；进程枚举失败、PID 仍在但无创建时间记录，均拒绝并保留锁），再释放租约；清理失败不交给 B，可用 `POST tickets/:id/environment/release` 重试。人工交接先导出（tracked / staged / 每个 untracked / 二进制），不 stash、不 reset、不 clean。交接或失锁后原工单继续（launch、新消息）前调用 `ensureEnvironment`：能重取则重取，已有新 owner 则拒绝且不抢；`runTicketTests` / `captureVisual` / `readVisual` 未持锁时抛 `notHolding`。`acquireHolder` 只恢复本进程自己的记录或本机已死 PID 的记录，活着的别的 PID 不抢。

**ready 与交付的顺序**：ready 经验收后释放锁；之后交付需 operator 显式 `POST tickets/:id/environment/acquire`（租约带 `purpose=delivery`，重启不会误释放），D 再次校验当前内容、证据（一小时内）、授权与独占后才允许。D 不自动取锁、不放宽 C 的释放。交付后 `release` 归还。`commit` 级同样要求持有独占；已启用 strict 的工单 commit 也要求证据有效。

**交付账本**：宿主重启时仍为 `running` 的 attempt 转 `uncertain`（`recoverDeliveries`），不自动重发；operator 用目标自己的 receipt 对账（`POST tickets/:id/delivery/reconcile`，`delivered` 或 `discarded`；`discarded` 同时撤销该级授权，需重新授权）。

**未覆盖 / 残余风险（如实）**
- 本机 worker 的 shell 理论上可直接 curl 回环管理 API 自行授权：同源检查不是 OS 沙箱，也没有 operator 专用 token。任意 shell 的外部操作、其他进程直接写工作区或直接杀编辑器，均不属于此机制的覆盖范围。
- 导出之后到释放之前，worker 仍可能写入工作区，这段改动不在导出内；尚未做暂停 worker 或导出后指纹复核。
- 编辑器的启动时间身份仅在“本机看到它启动”时才有；没有记录的存活 PID 一律拒绝并要求人工停止，不猜测。
- 没有在真实 UE 编辑器上运行 `kill` / `Stop-Process` 路径；该路径只有注入式单元测试，未做真实进程验证。
- 当前运行的 3080 宿主未加载、未重启；本交付仅为源码与隔离模拟结果。
- 生产 Git/Steam adapter、UE 编译、CQTest、资产操作、视觉语义的完整验收仍未覆盖，不宣称完整替代。
