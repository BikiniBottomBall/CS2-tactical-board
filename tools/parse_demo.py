"""P7 demo 解析管线：.dem → 轨迹包 JSON（gzip）

用法：.venv/Scripts/python.exe tools/parse_demo.py <demo.dem> [--tick-rate 64]
输出：data/demos/parsed/<文件名>.json.gz，stdout 最后一行打印 meta JSON（供 API 登记）

已知降级/假设（阶段A 验证结论）：
- header 不含 tickrate → 默认 64（5E/CS2），可用 --tick-rate 覆盖，存入 meta
- molotov_detonate 事件不存在 → 燃烧/火瓶爆点用 inferno_startburn
- 道具弹道逐点用 parse_grenades 真实采样（非贝塞尔拟合）
- 队伍归属：该玩家采样帧中 team_num 多数队（处理半场换边），兜底 parse_player_info
"""
import argparse
import gzip
import json
import math
import os
import sys

from demoparser2 import DemoParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARSED_DIR = os.path.join(ROOT, 'data', 'demos', 'parsed')
SAMPLE_EVERY = 4  # 64tick → 16Hz

EVENT_NAMES = [
    'round_start', 'round_end', 'player_death', 'bomb_planted', 'bomb_defused',
    'smokegrenade_detonate', 'flashbang_detonate', 'inferno_startburn',
]


def r1(v):
    return round(float(v), 1)


def map_grenade_type(cls: str) -> str:
    s = str(cls).lower()
    if 'smoke' in s:
        return 'smoke'
    if 'flash' in s:
        return 'flash'
    if 'molotov' in s or 'incendiary' in s:
        return 'molotov'
    if 'hegrenade' in s or s.endswith('_he') or 'he_grenade' in s:
        return 'he'
    return 'other'


def normalize_events(res, names):
    """parse_events 返回形状防御性归一化 → {name: DataFrame}"""
    out = {}
    if isinstance(res, dict):
        for n in names:
            if n in res:
                out[n] = res[n]
        return out
    if isinstance(res, (list, tuple)):
        for i, item in enumerate(res):
            if isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[0], str):
                out[item[0]] = item[1]
            elif i < len(names):
                out[names[i]] = item
    return out


def parse_demo(dem_path: str, out_dir: str = PARSED_DIR, tick_rate: int = 64) -> dict:
    stem = os.path.splitext(os.path.basename(dem_path))[0]
    parser = DemoParser(dem_path)

    header = parser.parse_header()
    map_name = header.get('map_name')

    # ---- 玩家 ----
    try:
        info = parser.parse_player_info()
        info_team = {str(r.steamid): int(r.team_number) for r in info.itertuples()}
        info_name = {str(r.steamid): str(r.name) for r in info.itertuples()}
    except Exception as e:
        print(f'[parse] parse_player_info 失败（继续）: {e}', file=sys.stderr)
        info_team, info_name = {}, {}

    # ---- 逐 tick 位置（全量解析后按 SAMPLE_EVERY 抽帧） ----
    df = parser.parse_ticks(['X', 'Y', 'Z', 'yaw', 'steamid', 'team_num', 'name'])
    df = df[df['tick'] % SAMPLE_EVERY == 0]
    max_tick = int(df['tick'].max())

    # 队伍多数队（team_num 2=T 3=CT）
    team_vote = {}
    for sid, g in df.groupby('steamid'):
        nums = g['team_num'].dropna().astype(int)
        nums = nums[nums.isin([2, 3])]
        team_vote[str(sid)] = int(nums.mode().iloc[0]) if len(nums) else None

    players = []
    for sid in sorted(team_vote.keys(), key=str):
        tn = team_vote.get(sid) or info_team.get(sid)
        if tn not in (2, 3):
            continue
        names = df[df['steamid'].astype(str) == sid]['name'].dropna()
        players.append({
            'steamid': sid,
            'name': str(names.iloc[0]) if len(names) else info_name.get(sid, sid),
            'team': 'T' if tn == 2 else 'CT',
        })
    # T 在前 CT 在后，各队内按名字排序，slot 稳定
    players.sort(key=lambda p: (0 if p['team'] == 'T' else 1, p['name']))
    for i, p in enumerate(players):
        p['slot'] = i
    slot_of = {p['steamid']: p['slot'] for p in players}

    # ---- 帧 ----
    frames = []
    for tick, g in df.groupby('tick'):
        arr = [None] * len(players)
        for row in g.itertuples():
            slot = slot_of.get(str(row.steamid))
            if slot is None:
                continue
            if math.isnan(row.X) or math.isnan(row.Y) or math.isnan(row.Z):
                continue  # 死亡/未入场的实体坐标为 NaN，跳过（帧存 null）
            yaw = 0.0 if math.isnan(row.yaw) else row.yaw
            arr[slot] = [r1(row.X), r1(row.Y), r1(row.Z), r1(yaw)]
        frames.append({'t': int(tick), 'p': arr})

    # ---- 道具弹道（真实逐点，抽帧） ----
    grenades = []
    try:
        gdf = parser.parse_grenades()
        gdf = gdf.dropna(subset=['x', 'y', 'z'])
        gdf = gdf[gdf['tick'] % SAMPLE_EVERY == 0]
        for (cls, eid), gg in gdf.groupby(['grenade_type', 'grenade_entity_id']):
            gg = gg.sort_values('tick')
            if len(gg) < 2:
                continue
            grenades.append({
                'type': map_grenade_type(cls),
                'entity': int(eid),
                'by': str(gg['name'].iloc[0]) if 'name' in gg.columns else None,
                'points': [[int(r.tick), r1(r.x), r1(r.y), r1(r.z)] for r in gg.itertuples()],
            })
    except Exception as e:
        print(f'[parse] parse_grenades 失败（继续）: {e}', file=sys.stderr)

    # ---- 事件 ----
    ev = normalize_events(parser.parse_events(EVENT_NAMES), EVENT_NAMES)
    utility_events = []
    for df_name, t in (('smokegrenade_detonate', 'smoke'), ('flashbang_detonate', 'flash'),
                       ('inferno_startburn', 'molotov')):
        edf = ev.get(df_name)
        if edf is None or not hasattr(edf, 'iterrows') or not len(edf):
            continue
        for r in edf.itertuples():
            if math.isnan(r.x) or math.isnan(r.y) or math.isnan(r.z):
                continue
            utility_events.append({
                'tick': int(r.tick), 'type': t,
                'x': r1(r.x), 'y': r1(r.y), 'z': r1(r.z),
                'by': str(getattr(r, 'user_name', '') or ''),
            })

    events = []
    rs = ev.get('round_start')
    if rs is not None and hasattr(rs, 'itertuples'):
        for i, r in enumerate(rs.itertuples()):
            events.append({'tick': int(r.tick), 'type': 'round_start', 'label': f'第 {i + 1} 回合开始'})
    re_df = ev.get('round_end')
    if re_df is not None and hasattr(re_df, 'itertuples'):
        for r in re_df.itertuples():
            winner = getattr(r, 'winner', None)
            if winner is None or str(winner) == 'nan':
                continue
            events.append({'tick': int(r.tick), 'type': 'round_end', 'label': f'回合结束 {winner} 胜'})
    pd_df = ev.get('player_death')
    if pd_df is not None and hasattr(pd_df, 'itertuples'):
        for r in pd_df.itertuples():
            attacker = getattr(r, 'attacker_name', None)
            user = getattr(r, 'user_name', None)
            weapon = str(getattr(r, 'weapon', '') or '').replace('weapon_', '')
            if not attacker or str(attacker) == 'nan':
                continue
            events.append({'tick': int(r.tick), 'type': 'kill',
                           'label': f'{attacker} 击杀 {user}（{weapon}）'})
    bp = ev.get('bomb_planted')
    if bp is not None and hasattr(bp, 'itertuples'):
        for r in bp.itertuples():
            events.append({'tick': int(r.tick), 'type': 'plant',
                           'label': f'{getattr(r, "user_name", "")} 下包'})
    bd = ev.get('bomb_defused')
    if bd is not None and hasattr(bd, 'itertuples'):
        for r in bd.itertuples():
            events.append({'tick': int(r.tick), 'type': 'defuse',
                           'label': f'{getattr(r, "user_name", "")} 拆包'})
    events.sort(key=lambda e: e['tick'])

    pack = {
        'meta': {
            'name': stem,
            'map': map_name,
            'tick_rate': tick_rate,  # 假定值（header 不含），可用 --tick-rate 覆盖
            'sample_every': SAMPLE_EVERY,
            'max_tick': max_tick,
            'duration_s': round(max_tick / tick_rate, 1),
            'coord_space': 'source',  # 原始 Source 单位/坐标系，前端负责转换
        },
        'players': players,
        'frames': frames,
        'grenades': grenades,
        'utility_events': utility_events,
        'events': events,
    }

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, stem + '.json.gz')
    with gzip.open(out_path, 'wt', encoding='utf-8') as f:
        json.dump(pack, f, ensure_ascii=False, separators=(',', ':'))

    meta = dict(pack['meta'])
    meta['file_parsed'] = os.path.relpath(out_path, ROOT).replace('\\', '/')
    meta['frames'] = len(frames)
    meta['grenades'] = len(grenades)
    meta['utility_events'] = len(utility_events)
    meta['events'] = len(events)
    return meta, events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dem')
    ap.add_argument('--tick-rate', type=int, default=64)
    args = ap.parse_args()
    meta, events = parse_demo(args.dem, tick_rate=args.tick_rate)
    meta['_events'] = events  # API 登记 demo_events 用
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == '__main__':
    main()
