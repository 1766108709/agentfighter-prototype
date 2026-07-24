# AgentFighter 可玩原型 v0.9

[![Deploy GitHub Pages](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml)

[在线试玩](https://1766108709.github.io/agentfighter-prototype/) · [自动发布状态](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml)

浏览器内的格斗与脚本 AI 原型，支持“玩家 vs AI”“AI vs AI”和完全脱离 DOM、Canvas、音频的无头批量模拟。真人、两侧 AI 与命令行模拟共用同一套方向、六键攻击、系统技、格挡、抓投、搓招和空战解析。

v0.9 新增 AgenTank 式外部 Agent 闭环：游戏签发一次性展示的 Fighter Key，玩家把 API Base URL、Agent Guide URL 和 Fighter Key 交给自己选择的 Codex、Claude Code、Cursor 等编码 Agent。外部 Agent 通过 HTTP 读取角色、上传完整 JavaScript 控制器、私下模拟、发布版本、发起正式挑战并读取赛果/Replay。AgentFighter 不会请求、接收或保存玩家的 OpenAI、Anthropic 或其他模型厂商 API Key，大模型也不会逐帧联网操控。

## 唯一角色：苍流

当前公开对局只使用 `苍流`。玩家、内置脚本和外部 Agent 都操控同一名角色、读取同一份完整 MOVESET，不再划分角色类型；胜负只取决于输入、策略和资源运用。内部协议为兼容现有数据仍使用 `templateId: "vanguard"`。

苍流拥有完整六键普通技、地面 QCF 飞行物、DP 对空、空中 QCB 重腿 `airTatsu`、投技、Drive 系统与超必杀。脚本 AI 会主动跳跃、空对空和跳入压制。

## 帧数据与设计基准

搓招表负责识别方向与按键输入；真正决定出招手感的是启动、持续、收招等帧数，以及每一帧变化的攻击盒与受击盒。

苍流的帧结构以《Street Fighter 6》的 Ryu 为主要基准。

本项目只借鉴动作的帧结构与相对判定关系，并将其归一化到 `46×112` 的原创火柴人骨架；不复制原角色造型、动画、音效或其他 IP 美术资产。

以下为代表动作，普通技按“启动 / 有效 / 收招”记录：

| 角色 | 站轻 | 站重 | 蹲轻 | 扫腿 | 跳轻 | 跳重 |
| --- | --- | --- | --- | --- | --- | --- |
| 苍流 | `4 / 3 / 7` | `10 / 5 / 18` | `5 / 2 / 10` | `9 / 3 / 23` | `4 / 10 / 落地3` | `10 / 8 / 落地3` |

- 苍流轻 / 重飞行物分别在第 `16F / 12F` 生成，总动作均为 `47F`；轻升龙为 `5 / 10 / 21`，另含 `12F` 落地恢复，总计 `47F`。

判定盒使用脚底根节点与角色身高 `H` 表示 `(中心X, 中心Y, 宽, 高)`。例如苍流站轻为 `(0.38, -0.72, 0.43, 0.22)H`、扫腿为 `(0.48, -0.14, 0.75, 0.20)H`；升龙早 / 晚段分别约为 `(0.22, -0.63, 0.40, 0.58)H` 与 `(0.08, -0.73, 0.42, 0.89)H`。面向左侧时只镜像 X；每个动作还拥有独立的肢体受击盒。

这是一套用于试手感的首轮基准，不是对原作的逐像素复刻；伤害、硬直和角色平衡仍按本原型继续迭代。

## 击倒、受身与连击

软倒地可在落地时用 `LP / LK` 快速起身、按水平方向后滚、按住下延迟起身，或不输入正常起身；硬倒地只能按固定时序起身。起身结束提供短暂无敌，系统还支持起身反击、地面反弹和墙面反弹。

连段通常从 `100%` 伤害开始，按动作的 scaling step 递减，通用下限为 `10%`，超杀自身最低缩放为 `40%`；特定起手技可覆写初始补正。空中连段另有浮空点数：每次追击消耗 juggle cost，超过该招 juggle limit 就不能继续命中，落地或连段结束后清零。

## 满资源 TOD 验收

大厅的“观看真实十割”会启动一场苍流的独立表演赛。导演脚本仍然逐帧输入真实方向与按键，招式识别、取消、资源消费、补正和碰撞都走正常战斗引擎。

固定路线为“近身重拳 → 双断踢 → 极限解放 → 天穹十三式”：极限解放消耗全部 `600 Drive`，奥义再消耗 `300 Super`，13 次终结冲击分别占用独立命中帧。整套共 `16 Hit`，对 1000 HP 训练假人造成固定 1000 点标准伤害；1100 HP 控制组会留下 100 HP。

表演必须从满血开始，在同一段连续 combo 中通过合法取消与资源消费自然把训练假人从满血打到零；普通 KO、残血起手、断连、伪造 `tod` 标记或动态补伤都不能通过验收。HUD 会逐击显示连击数、实际伤害和最终验真结果。

## 启动

```bash
npm start
```

然后打开 `http://127.0.0.1:4173`。本地服务会同时启动游戏页与 Agent API，持久化数据默认写入被 Git 忽略的 `.data/agent-api/`。

## 让玩家自己的大模型参赛

打开页面后点击右上角“接入 Agent”，填写参赛名称，再点“生成 Fighter Key”。双方固定使用苍流，不需要选择角色模板。页面会生成一段可以直接复制给编码 Agent 的完整指令，恰好包含这三项接入信息：

- `API Base URL`：模拟、发布、挑战和复盘的服务地址。
- `Agent Guide URL`：大模型先读取的规则与 API 文档；
- `Fighter Key`：仅控制这一名 Fighter 的游戏侧 Bearer 凭证。

Fighter Key 只在创建响应里完整显示一次，服务端只保存 SHA-256 哈希。当前没有 Key 恢复或轮换接口，丢失后只能创建新 Fighter。它不是模型厂商 Key，也绝不能写入上传的控制器、仓库或公开聊天。玩家自己的 Agent 在自己的环境里调用所选模型；AgentFighter 不会向玩家索要，也不会收到模型厂商 API Key。

外部 Agent 的标准迭代循环：

```text
GET fighter → 读苍流招式清单 → 写候选脚本 → simulate 内置对手
            → publish 完整版本 → 选公开对手 → challenge(opponentId)
            → 先读紧凑赛果，按需读 events / frames / Replay → 继续迭代
```

主要接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/fighters` | 创建角色并一次性签发 Fighter Key |
| `GET` | `/api/schemas/agent-v1` | 读取完整的 Agent V1 生命周期、字段与示例 |
| `GET` | `/api/agent/fighter` | 读取自己的角色、活动版本、限制与文档链接 |
| `POST` | `/api/agent/fighter/simulate` | 用候选代码私下模拟，不发布、不计战绩 |
| `POST` | `/api/agent/fighter/code` | 发布一份完整 JavaScript 版本 |
| `GET` | `/api/agent/fighter/versions/{versionId}` | 读取自己某个不可变版本的完整源码 |
| `POST` | `/api/agent/fighter/versions/{versionId}/activate` | 把自己的旧版本重新设为活动版本 |
| `GET` | `/api/agent/opponents` | 获取内置与玩家对手 |
| `GET` | `/api/agent/leaderboard` | 读取正式排行榜 |
| `POST` | `/api/agent/fighter/challenge` | 仅提交 `opponentId`，用活动版本挑战 |
| `GET` | `/api/agent/fighter/matches` | 读取自己的已记录比赛 |
| `GET` | `/api/matches/{id}/agent.json` | 读取紧凑赛果 |
| `GET` | `/api/matches/{id}/agent.json?view=events` | 读取面向 Agent 的关键事件 |
| `GET` | `/api/matches/{id}/agent/frames?from=&to=` | 按小范围读取逐帧输入与状态 |
| `GET` | `/api/matches/{id}/replay.json` | 读取完整 ReplayV1 |

上传代码声明 `function createAgent(api)`，返回带同步 `act(observation)` 的对象；脚本通过 `api.action({...})` 返回严格的 ActionV1。正式 challenge 的规则与 seed 由服务端决定，客户端只提交 `opponentId`。内置对手用于训练和有记录的表演赛，`rankEligible: false`，不会改变正式胜负统计或排行榜。

模拟与挑战共享同一名 Fighter 的短冷却。收到 `429` 时读取 `error.details.retryAfterMs`（或 `Retry-After` 响应头）再重试。复盘时优先读取紧凑 `agent.json`，信息不足再读取 events、左闭右开的窄范围 frames，最后才下载可能很大的完整 Replay。完整契约、MatchInfoV1、ObservationV1、MatchResultV1、ActionV1 字段、示例与 curl 调用见 [AGENT_GUIDE.md](./AGENT_GUIDE.md)。

代码在独立 Worker 内执行，附加 VM 能力限制、每次调用超时、整场墙钟上限和内存上限；正式挑战由服务端无头引擎结算并保存 Replay。这里实现的是可本地试玩/自托管的参考沙箱，Node `vm` 不是公网多租户的完整安全边界。公开部署用户脚本前仍需使用独立容器/微虚机、账号体系、持久数据库和平台级限流。

可配置：

```bash
HOST=127.0.0.1 \
PORT=4173 \
AGENTFIGHTER_DATA_DIR=/absolute/private/data \
AGENTFIGHTER_PUBLIC_URL=https://api.example.com \
npm start
```

GitHub Pages 仍只承载静态试玩页，因此在线页会在“接入 Agent”弹窗里明确显示后端未连接；部署长期运行的 Agent API 后，在弹窗填写它的地址即可。模型厂商 Key 只留在玩家自己的模型客户端中；AgentFighter、Pages、前端代码和 GitHub Actions 都不应接触它。

## 对战模式

- `玩家 vs AI`：玩家亲自操作左侧角色，挑战所选脚本。
- `AI vs AI`：分别选择左右两个脚本，观看它们在完全相同的输入规则下对战。
- `无头模式`：从命令行批量跑可复现对局，输出胜率、局长、动作、连段、TOD 与吞吐量统计。

AI 对战双方共享所选难度，并在同一决策帧获得实时公开观测；双方仍各自拥有独立的决策状态、输入队列和适应统计。

## 无头批量模拟

无需打开网页即可批量运行脚本对战：

```bash
npm run headless -- --matches 100 --agent-a pressure --agent-b zoner
```

直接调用 CLI 并输出机器可读 JSON：

```bash
node headless.mjs --matches 100 --agent-a pressure --agent-b zoner --seed 20260720 --format json
```

无头模式完全不会启动浏览器、Canvas 或音频。它默认逐局交替交换双方位置，并在终端汇总胜率、局长、动作统计和模拟吞吐量。

### Agent V1 接口

第三方本地脚本通过 `src/agent-sdk.js` 接入，只实现三个生命周期方法：`reset(matchInfo)`、`act(observation)`、`end(result)`。`act` 必须同步返回由 `createActionV1()` 创建的动作；引擎只会传入 JSON-safe 的公开观察，不会暴露原始 `game`、对手输入、指令缓存或内部 AI 计划。

`ObservationV1` 使用实时公开观测：决策帧 `F` 获得同一帧的全局计时、回合状态、双方状态、飞行物和公开事件。为兼容协议 v1，`observation.perception.delayFrames` 固定为 `0`，`observation.perception.opponentFrame` 等于 `observation.frame`。`observation.recentEvents` 只保留有限窗口内的公开战斗摘要，用于学习拆投、逆转、空挥、防御、跳跃和起身习惯；AI 理由、输入缓存和引擎内部对象不会进入事件摘要。

```js
import { createActionV1 } from "./src/agent-sdk.js";
import { runHeadlessTournament } from "./src/headless.js";

const makeAgent = () => ({
  reset(matchInfo) {},
  act(observation) {
    const right = observation.self.position.x < observation.opponent.position.x;
    return createActionV1({ left: !right, right, lp: observation.frame % 12 === 0 });
  },
  end(result) {},
});

const summary = runHeadlessTournament(
  { matches: 10, bestOf: 3 },
  { agents: { A: makeAgent(), B: makeAgent() } },
);
```

`createInProcessAgentRunner()` 还可配置决策间隔、动作保持、deadline，以及非法动作 / 异常 / 超时后的 `neutral`、`hold-last` 或 `disable` 策略。它只适用于可信本地代码：进程内 JavaScript 不可抢占、不是沙箱，死循环仍会锁死比赛，禁止直接运行用户上传脚本。外部 Agent Gateway 会把整场无头引擎和上传脚本一起放进一次性 Worker，并在 Worker 内再限制 VM 能力与单次调用时间；公网多租户部署还必须增加进程/容器级隔离。

种子只会作为可复现输入传给 Agent。内置脚本遵守种子；自定义 Agent 仍可读取时间、`Math.random()` 或网络，因此汇总会标为 `agents: "unverified"`，平台只保证战斗引擎和已给定动作序列的确定性。

### 战斗复盘 / ReplayV1

普通对局结束后可点击“战斗复盘”，使用播放/暂停、前后单帧、时间轴 seek 和倍速控制查看录像；面板会同步展示双方输入、生命资源、事件标记和 Agent 决策摘要。录像默认只驻留当前页面内存，刷新页面即丢失；独立 TOD 表演赛暂不进入普通对局录像。

核心 API 位于 `src/replay.js`：`createReplayRecorder(game)` 逐帧记录，`createReplayPlayer(replay)` 播放与 `verify()` 验证，`validateReplayV1(replay)` 校验格式。无头批量赛默认不保存录像，以免占用大量内存；调用 `runHeadlessTournament(options, { recordReplay: true })` 才会在每场 `result.replay` 返回 ReplayV1，也可用 `onMatchReplay(replay, context)` 流式接收。录像中的 `stateHash` 用于发现重放分歧，不是密码学签名，也不能证明文件来源可信。

常用参数：

- `--matches <数量>`：设置模拟场数。
- `--agent-a <balanced|pressure|zoner>`：选择 Agent A 的脚本。
- `--agent-b <balanced|pressure|zoner>`：选择 Agent B 的脚本。
- `--difficulty <easy|normal|hard|expert>`：设置双方难度。
- `--seed <整数>`：设置可复现的锦标赛种子。
- `--round-seconds <秒>`、`--best-of <奇数>`：设置回合时间和赛制。
- `--format json`：将汇总结果输出为 JSON。
- `--no-swap`：关闭默认的交替换边。
- `--help`：查看命令帮助。

## 操作

- `A / D`：移动
- `W`：跳跃
- `S`：蹲下
- `U / I / O`：`LP / MP / HP`
- `J / K / L`：`LK / MK / HK`
- `H`：投技快捷键
- `Shift`：`system1`，Parry
- `;`：`system2`，Drive Impact
- `Space`：防御快捷键；配合 `S` 使用蹲防
- `P / Escape`：暂停
- `R`：重新开始
- `F1`：显示判定框

苍流使用完整的 `U/I/O + J/K/L` 六键布局。`LP+LK`、`MP+MK`、`HP+HK` 分别等价于投技、`system1`、`system2`。右侧“完整出招表”只读取苍流 MOVESET，按 category 分组显示名称、指令、帧数与资源消耗。

苍流的 SA2 在 `214214P` 后继续按住任意拳：超过 `7F` 进入 Level 2，超过 `39F` 进入 Level 3；有 Denjin 时自动选强化版本且只消费一次资源。按住 `MP+MK` 再输入 `66` 可触发 Parry Drive Rush，普通技命中 / 防御后同样输入则走 Drive Rush Cancel；两种 Rush 的直接后继攻击在命中或防御时均获得 `+4F`。防御硬直或起身末段可预先输入相对前方向 `6 + ;`，动作只会在合法恢复帧执行 Drive Reversal。

人机挑战不会连接网络，也不影响任何排名。

方向指令会根据角色当前朝向自动镜像。每次起跳可启动一次空中攻击，攻击期间仍会受到重力和水平空速影响。站防可挡普通攻击与空中 / overhead，蹲防可挡普通攻击与下段；只有显式标记 `whiffsOnCrouch` 的上段会越过蹲姿，抓投则可以破解两种防御。

## F1 帧调试

按 `F1` 可查看引擎当前帧的真实判定：红色为攻击盒（hit），青绿色为受击盒（hurt），橙色为飞行道具（projectile）。两侧面板同时显示当前动作帧及 `startup / active / recovery` 阶段；`S / A / R` 分别表示启动、有效与收招帧数。

常规 HUD 会在字段可用时显示真实 Super、Drive 或 Guard 资源、连段数与累计伤害；Agent 提供意图遥测时，还会显示当前 intent 与 reason。所有新字段都有旧 game 数据回退，不影响 v0.6 的无头模式与页面配置。

## 主要参考

- [Capcom：《Street Fighter 6》Ryu Frame Data](https://www.streetfighter.com/6/character/ryu/frame)
- [Ultimate Frame Data：SF6 Ryu](https://ultimateframedata.com/sf6/ryu)
