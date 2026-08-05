# CS2 战术板 · P11/P12/P13 Codex 任务提示词

> 使用方式（项目根目录 D:\KimiCode\cs2-tactical-board）：
> codex exec "$(cat docs/P11-P13-codex-prompts.md)"   # 一次全做
> codex exec "P11 部分"                               # 单任务可复制对应段落
> 建议用 --sandbox workspace-write

---

## P11 人物模型升级（替换圆饼）

项目：D:\KimiCode\cs2-tactical-board（Three.js + Vite + TypeScript，无需解释架构，直接看代码）。

任务：玩家形象目前是"小圆柱底座 + 标签精灵"，与 CS2 游戏内角色外观不一致。把它升级为接近 CS2 角色的低模人形，战术模式和 demo 回放共用。

关键代码位置：
- web/src/tactic.ts 中 createActorVisual(label, isT) —— 现在用 CylinderGeometry(1.7, 1.7, 0.5) 底座 + createMarkerSprite 标签
- web/src/replay.ts 中 buildActors() —— 复用 createActorVisual，另加贴地扇形 yaw 视锥（CircleGeometry 扇形，rotation.x = -PI/2）
- 调用方：tactic.ts / replay.ts / view.ts 三处

要求：
1. 优先用 Three.js 原生几何拼低模人形（头 + 躯干 + 四肢，参考 CS2 角色比例：头身比、肩宽）；**若原生拼装效果不佳，可改用免费低模人形 .glb 模型**（如 Kenney 角色包），需随项目自包含（放 data/models/ 或 web/public/models/），用 GLTFLoader 加载，不能依赖外链；两种方案都要 T/CT 两套配色（材质着色或双模型）
2. T 队黄色、CT 队蓝色区分（沿用现有 MARKER_DEFS['marker-t'/'marker-ct'] 的颜色），材质 Lambert 或 Standard
3. 保留头顶标签精灵（名字 + 队伍色），远距离/俯视角清晰可读
4. yaw 朝向语义保留：回放时人形身体朝向跟随 yaw（旋转整个人形组即可），贴地 yaw 视锥扇形保留
5. 保持 createActorVisual(label, isT) 导出签名不变，调用方零改动或最小改动
6. 贴地逻辑不变（groundY 沿用），模型高度约 3 单位内，不得穿地板
7. 同屏最多 20 个人形（战术 10 + 回放 10），帧率不能掉

验收：
- 战术模式拖拽 10 演员显示人形，T/CT 颜色正确，标签可读
- demo 回放 10 人显示人形，朝向随 yaw 转动
- tsc 0 错误，vite build 通过
- 完成后列出改动的文件和关键 diff 摘要

---

## P12 击杀效果 + 击杀播报（kill feed）

项目：D:\KimiCode\cs2-tactical-board（Three.js + Vite + TypeScript 前端，FastAPI 后端）。

任务：demo 回放时玩家死亡没有视觉反馈，观众分不清谁死了。实现游戏内风格的两件事：① 死亡视觉（倒地/变灰）② 右上角击杀播报（kill feed）。

关键代码位置：
- 后端 tools/parse_demo.py —— player_death 事件已解析为 {tick, type:'kill', label:'{attacker} 击杀 {user}（{weapon}）'}，但**缺 headshot 标记**
- 后端解析结果经 GET /api/demos/{id}/pack 返回（meta 含 _events 已入库 demo_events，勿改表结构，只加字段可选）
- 前端 web/src/replay.ts —— buildBookmarks() 只把事件画成时间轴书签点；回放核心在 seek()/帧插值；演员对象在 actorObjs[slot] = {group}，slot 对应 pack.players 下标
- 前端已有 BOOKMARK_COLORS.kill = '#ff5252'

要求：
1. 后端 parse_demo.py：player_death 解析增加 headshot 布尔字段（有则 label 追加"（爆头）"）；旧 pack 无此字段时前端不能报错（可选链/默认值）
2. 死亡视觉：击杀发生的 tick，受害者人形倒地（绕 X 轴旋转约 90° 贴地）+ 变灰/变暗；击杀者短暂高亮（如 1s 描边或闪烁）；round_start 事件恢复所有人生存状态
3. 击杀播报：右上角 CS2 风格 kill feed——「击杀者名 [武器名] 受害者名」，爆头加红色爆头标识；多条堆叠，3~4 秒后向上滚动消失；半透明黑底 CSS 样式，T/CT 用队伍色区分名字
4. 与时间轴联动：拖动滑块/快进/跳书签时，kill feed 与死亡状态按当前时间正确显示（seek 到击杀前则恢复站立）；快进时可用快照式补齐，不要求逐帧动画
5. 播报样式放 web/src/style.css 或现有样式文件，不引入 UI 框架

验收：
- 回放中 A 击杀 B：B 倒地变灰 + 右上角出现「A [武器] B」播报
- 快进/回拖后死亡状态与 kill feed 与时间点一致
- 旧 pack（无 headshot）加载不报错
- tsc 0 错误，vite build 通过
- 完成后列出改动的文件

---

## P13 道具落地效果游戏化

项目：D:\KimiCode\cs2-tactical-board（Three.js + Vite + TypeScript）。

任务：三种道具（烟雾弹/闪光弹/燃烧弹）落地效果太抽象（灰球、白球、橙盘），升级为接近 CS2 游戏内观感的效果。效果不需要像素级一致，观感接近即可；可参考 CS2 实战/道具视频或游戏社区免费粒子/火焰贴图资源（若用外部贴图，需随项目自包含，走 data/ 或 web/public/，不能依赖外链）。

关键代码位置：
- web/src/utility.ts 中 spawnLandingEffect(u, pt) —— 现在实现：flash=白球爆闪+点光 0.5s；molotov=橙色圆盘脉动+橙光 3s；smoke=灰球扩散 4.5 倍停 4s 淡出
- effects[] 数组 + 每项 { t, life, objs, tick(t,k) } 生命周期机制；updateUtility(dt) 主循环驱动
- 调用方：战术推演 playUtility() 与 demo 回放（utility_events）共用

要求：
1. 烟雾弹：大体积不规则灰白烟雾团（多球叠加或粒子系统），缓慢翻滚扩散并笼罩落点区域，持续约 15s 后淡出；烟雾应有遮挡感（调整透明度/深度写入，别让人物从烟里"透视"出来）
2. 闪光弹：爆闪白屏（全屏白色叠加层快速闪亮衰减约 1.5s）+ 落点高光爆球，做出"闪瞎"的观感
3. 燃烧弹：地面火海——橙红火焰（多层火焰贴图或粒子，火苗跳动），火区扩散，附橙色闪烁 PointLight + 顶部黑烟，持续约 7s 后熄灭
4. **保持 spawnLandingEffect(u, pt) 签名和 effects[] 生命周期机制不变**，只改内部实现与 tick 回调
5. 性能：同屏 ≤4 个效果时保持 60fps（限制粒子数、共享几何/材质，避免每帧 new 对象）
6. 战术推演与 demo 回放两处调用均生效

验收：
- 三种道具落地观感接近游戏内效果（可以录屏对比）
- 效果按时长消散、不残留对象
- 多个效果同屏不卡顿
- tsc 0 错误，vite build 通过
- 完成后列出改动的文件

---

## 注意事项（对 Codex）

- 项目是 git 仓库，改动后不要自动 commit，列出改动等用户确认
- 前端构建验证命令：cd web && npx tsc --noEmit && npx vite build
- 后端不要动数据库表结构（models.py / alembic 迁移），除非任务明确要求
- 项目风格：模块化 TS（web/src/ 下按功能拆文件）、中文注释、简洁实现
- 若某个要求与现有代码冲突，先说明冲突再选合理方案，不要静默跳过
