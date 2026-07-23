# AgentFighter 可玩原型 v0.8

[![Deploy GitHub Pages](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml)

[在线试玩](https://1766108709.github.io/agentfighter-prototype/) · [自动发布状态](https://github.com/1766108709/agentfighter-prototype/actions/workflows/deploy-pages.yml)

浏览器内的格斗与脚本 AI 原型，支持“玩家 vs AI”“AI vs AI”和完全脱离 DOM、Canvas、音频的无头批量模拟。真人、两侧 AI 与命令行模拟共用同一套方向、六键攻击、系统技、格挡、抓投、搓招和空战解析。

## 完整双角色

v0.8 已接入两套完整角色数据：`苍流 · Vanguard` 共 `82` 招，采用 SF 六键和 Drive 风格系统；`赤锋 · Ember` 共 `76` 招，采用 KOF 四键、翻滚、MAX 与多分支连技。旧版 `highLight`、`fireballLight` 等动作名继续作为兼容别名，界面和 AI 则可直接读取完整 MOVESET。

- `苍流 · Vanguard`：街霸式全能骨架。地面 QCF 发波、DP 升龙，并拥有空中 QCB 重腿 `airTatsu`。
- `赤锋 · Ember`：拳皇式近身骨架。地面 QCF 变为前进连击 `rekka`、DP 对空，并拥有空中下重压击 `airHammer`。

两名角色都可使用空中轻攻击与跳入重击。脚本 AI 会主动跳跃、空对空、跳入压制，并根据角色模板使用专属空中招式。

## 帧数据与设计基准

搓招表负责识别方向与按键输入；真正决定出招手感的是启动、持续、收招等帧数，以及每一帧变化的攻击盒与受击盒。

- `Vanguard` 的帧结构以《Street Fighter 6》的 Ryu 为主要基准。
- `Ember` 的帧结构以《The King of Fighters XV》的 Kyo Kusanagi 为主要基准。

本项目只借鉴动作的帧结构与相对判定关系，并将其归一化到 `46×112` 的原创火柴人骨架；不复制原角色造型、动画、音效或其他 IP 美术资产。

以下为代表动作，普通技按“启动 / 有效 / 收招”记录：

| 模板 | 站轻 | 站重 | 蹲轻 | 扫腿 | 跳轻 | 跳重 |
| --- | --- | --- | --- | --- | --- | --- |
| Vanguard | `4 / 3 / 7` | `10 / 5 / 18` | `5 / 2 / 10` | `9 / 3 / 23` | `4 / 10 / 落地3` | `10 / 8 / 落地3` |
| Ember | `4 / 2 / 8` | `4 / 3 / 19` | `5 / 3 / 10` | `7 / 4 / 23` | `4 / 5 / 落地1` | `8 / 5 / 落地1` |

- Vanguard 轻 / 重飞行物分别在第 `16F / 12F` 生成，总动作均为 `47F`；轻升龙为 `5 / 10 / 21`，另含 `12F` 落地恢复，总计 `47F`。
- Ember 前进连击首段为 `11 / 6 / 21`；轻升龙的有效窗为 `4–7F / 9–12F`，重升龙从 `7F` 启动；空中下压为 `12 / 4 / 落地1`。

判定盒使用脚底根节点与角色身高 `H` 表示 `(中心X, 中心Y, 宽, 高)`。例如 Vanguard 站轻为 `(0.38, -0.72, 0.43, 0.22)H`、扫腿为 `(0.48, -0.14, 0.75, 0.20)H`；升龙早 / 晚段分别约为 `(0.22, -0.63, 0.40, 0.58)H` 与 `(0.08, -0.73, 0.42, 0.89)H`。Ember 远站轻、扫腿和空中下压分别约为 `(0.51, -0.77, 0.57, 0.26)H`、`(0.53, -0.29, 0.67, 0.33)H`、`(0.18, -0.09, 0.71, 0.30)H`。面向左侧时只镜像 X；每个动作还拥有独立的肢体受击盒。

这是一套用于试手感的首轮基准，不是对原作的逐像素复刻；伤害、硬直和角色平衡仍按本原型继续迭代。

## 击倒、受身与连击

软倒地可在落地时用 `LP / LK` 快速起身、按水平方向后滚、按住下延迟起身，或不输入正常起身；硬倒地只能按固定时序起身。起身结束提供短暂无敌，系统还支持起身反击、地面反弹和墙面反弹。

连段通常从 `100%` 伤害开始，按动作的 scaling step 递减，通用下限为 `10%`，超杀自身最低缩放为 `40%`；特定起手技可覆写初始补正。空中连段另有浮空点数：每次追击消耗 juggle cost，超过该招 juggle limit 就不能继续命中，落地或连段结束后清零。

## 满资源 TOD 验收

大厅的“观看真实十割”会启动一场独立表演赛，固定使用角落路线 `c.C → 3D → Quick MAX → Yakumo`。导演脚本仍然逐帧输入真实方向与按键，招式识别、取消、资源消费、补正和碰撞都走正常战斗引擎。

这条路线的固定规则是：赤锋在 MAX Mode 中使用 Yakumo 时获得 `2.125×` Climax 伤害修正。它不会读取对手的当前或剩余血量；因此对 1000 HP 木桩自然造成恰好 1000 点实际伤害，对 1100 HP 木桩只造成 1000 点并留下 100 HP。

Yakumo 的 13 段拥有 13 个独立命中帧、逐段 Hitstop 与不同火柴人关键姿势；连击数会真实经过 `3 → 4 → 5 → … → 16`，血条也逐段下降。最后一击后先保留约 `720ms` 的空血条与终结定格，再显示验真结果。

表演成功必须同时满足：满血起手、16 Hit 属于同一连续 combo、Quick MAX 先于 Yakumo 合法启动、Yakumo 的 13 段全部命中、实际扣血从 1000 到 0、每击均为标准伤害且 `forcedDamage = 0`。普通 KO、残血起手、断连、伪造 `tod` 标记或动态补伤都不能通过验收。这是 AgentFighter 自己的资源与伤害调校，不宣称复刻 KOF XV 的实战伤害。

## 启动

```bash
npm start
```

然后打开 `http://127.0.0.1:4173`。

## 对战模式

- `玩家 vs AI`：玩家亲自操作左侧角色，挑战所选脚本。
- `AI vs AI`：分别选择左右两个脚本，观看它们在完全相同的输入规则下对战。
- `无头模式`：从命令行批量跑可复现对局，输出胜率、局长、动作、连段、TOD 与吞吐量统计。

AI 对战双方共享所选难度和观测延迟，但各自拥有独立的决策状态、输入队列和适应统计。

## 无头批量模拟

无需打开网页即可批量运行脚本对战：

```bash
npm run headless -- --matches 100 --agent-a pressure --agent-b zoner --delay 12
```

直接调用 CLI 并输出机器可读 JSON：

```bash
node headless.mjs --matches 100 --agent-a pressure --agent-b zoner --template-a ember --template-b vanguard --seed 20260720 --format json
```

无头模式完全不会启动浏览器、Canvas 或音频。它默认逐局交替交换双方位置，并在终端汇总胜率、局长、动作统计和模拟吞吐量。

### Agent V1 接口

第三方本地脚本通过 `src/agent-sdk.js` 接入，只实现三个生命周期方法：`reset(matchInfo)`、`act(observation)`、`end(result)`。`act` 必须同步返回由 `createActionV1()` 创建的动作；引擎只会传入 JSON-safe 的公开观察，不会暴露原始 `game`、对手输入、指令缓存或内部 AI 计划。

观测延迟是平台公平规则：无头模式的 `--delay N` 会在统一 runner 中同时缓冲双方感知。决策帧 `F`、全局计时、回合状态和自己的状态始终是当前值；对手、对手飞行物及对手产生的公开事件来自 `F-N`，并通过 `observation.perception.opponentFrame` 明示。开局不足 `N` 帧时使用本回合最早快照，进入新回合会清空旧感知，绝不会看到上回合对手。内置脚本不会再额外叠加延迟。`observation.recentEvents` 只保留有限窗口内的公开战斗摘要，用于学习拆投、逆转、空挥、防御、跳跃和起身习惯；AI 理由、输入缓存和引擎内部对象不会进入事件摘要。

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

`createInProcessAgentRunner()` 还可配置 `observationDelayFrames`、决策间隔、动作保持、deadline，以及非法动作 / 异常 / 超时后的 `neutral`、`hold-last` 或 `disable` 策略。它只适用于可信本地代码：进程内 JavaScript 不可抢占、不是沙箱，死循环仍会锁死比赛，禁止直接运行用户上传脚本。网络、大模型或不可信 Agent 必须放进 Worker / 独立进程，在外部完成超时和资源隔离，再通过同步 mailbox 适配器送入 60 Hz 引擎。

种子只会作为可复现输入传给 Agent。内置脚本遵守种子；自定义 Agent 仍可读取时间、`Math.random()` 或网络，因此汇总会标为 `agents: "unverified"`，平台只保证战斗引擎和已给定动作序列的确定性。

### 战斗复盘 / ReplayV1

普通对局结束后可点击“战斗复盘”，使用播放/暂停、前后单帧、时间轴 seek 和倍速控制查看录像；面板会同步展示双方输入、生命资源、事件标记和 Agent 决策摘要。录像默认只驻留当前页面内存，刷新页面即丢失；独立 TOD 表演赛暂不进入普通对局录像。

核心 API 位于 `src/replay.js`：`createReplayRecorder(game)` 逐帧记录，`createReplayPlayer(replay)` 播放与 `verify()` 验证，`validateReplayV1(replay)` 校验格式。无头批量赛默认不保存录像，以免占用大量内存；调用 `runHeadlessTournament(options, { recordReplay: true })` 才会在每场 `result.replay` 返回 ReplayV1，也可用 `onMatchReplay(replay, context)` 流式接收。录像中的 `stateHash` 用于发现重放分歧，不是密码学签名，也不能证明文件来源可信。

常用参数：

- `--matches <数量>`：设置模拟场数。
- `--agent-a <balanced|pressure|zoner>`：选择 Agent A 的脚本。
- `--agent-b <balanced|pressure|zoner>`：选择 Agent B 的脚本。
- `--template-a <vanguard|ember>`：选择参赛者 A 的角色模板。
- `--template-b <vanguard|ember>`：选择参赛者 B 的角色模板。
- `--difficulty <easy|normal|hard|expert>`：设置双方难度。
- `--delay <帧数>`：设置双方的 AI 观测延迟。
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
- `Shift`：`system1`，Vanguard 为 Parry，Ember 为 Roll
- `;`：`system2`，Vanguard 为 Drive Impact，Ember 为 Blowback
- `Space`：防御快捷键；配合 `S` 使用蹲防
- `P / Escape`：暂停
- `R`：重新开始
- `F1`：显示判定框

KOF 四键布局使用 `U = A（LP）`、`J = B（LK）`、`O = C（HP）`、`L = D（HK）`；SF 六键布局则使用完整的 `U/I/O + J/K/L`。`LP+LK`、`MP+MK`、`HP+HK` 分别等价于投技、`system1`、`system2`。右侧“完整出招表”会直接读取当前角色 MOVESET，按 category 分组显示名称、指令、帧数与资源消耗。

Vanguard 的 SA2 在 `214214P` 后继续按住任意拳：超过 `7F` 进入 Level 2，超过 `39F` 进入 Level 3；有 Denjin 时自动选强化版本且只消费一次资源。按住 `MP+MK` 再输入 `66` 可触发 Parry Drive Rush，普通技命中 / 防御后同样输入则走 Drive Rush Cancel；两种 Rush 的直接后继攻击在命中或防御时均获得 `+4F`。防御硬直或起身末段可预先输入相对前方向 `6 + ;`，动作只会在合法恢复帧执行 Drive Reversal。Ember 的可蓄力超杀也会按实际按住帧数切换伤害档位，蓄力期间保留数据声明的上半身无敌。

人机挑战不会连接网络，也不影响任何排名。

方向指令会根据角色当前朝向自动镜像。每次起跳可启动一次空中攻击，攻击期间仍会受到重力和水平空速影响。站防可挡普通攻击与空中 / overhead，蹲防可挡普通攻击与下段；只有显式标记 `whiffsOnCrouch` 的上段会越过蹲姿，抓投则可以破解两种防御。

## F1 帧调试

按 `F1` 可查看引擎当前帧的真实判定：红色为攻击盒（hit），青绿色为受击盒（hurt），橙色为飞行道具（projectile）。两侧面板同时显示当前动作帧及 `startup / active / recovery` 阶段；`S / A / R` 分别表示启动、有效与收招帧数。

常规 HUD 会在字段可用时显示真实 Super、Drive 或 Guard 资源、连段数与累计伤害；Agent 提供意图遥测时，还会显示当前 intent 与 reason。所有新字段都有旧 game 数据回退，不影响 v0.6 的无头模式与页面配置。

## 主要参考

- [Capcom：《Street Fighter 6》Ryu Frame Data](https://www.streetfighter.com/6/character/ryu/frame)
- [Ultimate Frame Data：SF6 Ryu](https://ultimateframedata.com/sf6/ryu)
- [DreamCancel Wiki：KOF XV / Kyo Kusanagi](https://www.dreamcancel.com/wiki/The_King_of_Fighters_XV/Kyo_Kusanagi)
- [SNK：KOF XV Patch Ver. 2.50](https://www.snk-corp.co.jp/us/games/kof-xv/img/news/patch_2.50.pdf)
- [SNK：KOF XV Patch Ver. 2.51](https://www.snk-corp.co.jp/us/games/kof-xv/img/news/patch_2.51.pdf)
