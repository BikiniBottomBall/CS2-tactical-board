"""从出生帧提取 T/CT 出生点精确坐标（Source 世界坐标）

用法：.venv/Scripts/python.exe tools/extract_spawns.py <parsed.json.gz>
逻辑：每个 round_start 后的冻结时间窗口（0~2s）内，玩家都站在出生点；
按队伍聚合所有回合的帧位置，取均值簇中心。
"""
import gzip
import json
import sys
from collections import defaultdict


def main(path):
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        pack = json.load(f)

    rate = pack['meta']['tick_rate']
    players = pack['players']
    teams = {p['slot']: p['team'] for p in players}

    round_starts = [e['tick'] for e in pack['events'] if e['type'] == 'round_start']
    window = int(rate * 2)  # 冻结时间 2s

    # slot -> 回合开始帧位置列表
    spawn_pts = defaultdict(list)
    frame_by_tick = {fr['t']: fr['p'] for fr in pack['frames']}
    for rs in round_starts:
        for fr in pack['frames']:
            if not (rs <= fr['t'] <= rs + window):
                continue
            for slot, p in enumerate(fr['p']):
                if p:
                    spawn_pts[slot].append(p)

    agg = defaultdict(list)
    for slot, pts in spawn_pts.items():
        team = teams.get(slot)
        if team:
            agg[team].extend(pts)

    for team in ('T', 'CT'):
        pts = agg[team]
        if not pts:
            print(f'{team}: 无数据')
            continue
        n = len(pts)
        mx = sum(p[0] for p in pts) / n
        my = sum(p[1] for p in pts) / n
        mz = sum(p[2] for p in pts) / n
        # 散布范围（检查簇是否集中）
        sx = max(p[0] for p in pts) - min(p[0] for p in pts)
        sy = max(p[1] for p in pts) - min(p[1] for p in pts)
        print(f'{team} 出生点中心: ({mx:.0f}, {my:.0f}, {mz:.0f})  '
              f'帧数={n} 散布 x={sx:.0f} y={sy:.0f}')


if __name__ == '__main__':
    main(sys.argv[1])
