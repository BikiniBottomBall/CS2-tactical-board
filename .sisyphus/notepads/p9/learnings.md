# P9 Learnings

## P9-8: board.ts 线同步
- 画笔线预览帧（pointermove）**不同步**，只在 pointerup 完成时发送整条线
- 乐观渲染：multplayer 模式先本地创建 `'L' + boardSeq` 键的线，服务端 echo 时 `renderRemoteLine` 通过 `boardItems.has(id)` 跳过重复创建
- 线删除需要区分 marker/line 类型，发送对应的 `marker_delete` / `line_delete` op
- 三个删除入口都需处理：eraser（pointerdown）、right-click、undoBoard
- boardSeq 在 multiplayer 和 single-player 模式中独立递增，线条 id 格式统一
