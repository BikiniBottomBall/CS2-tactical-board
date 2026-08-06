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
SAMPLE_STATS = 8  # P12.1 HUD 统计采样（64tick → 8Hz）

EVENT_NAMES = [
    'round_start', 'round_end', 'player_death', 'bomb_planted', 'bomb_defused',
    'smokegrenade_detonate', 'flashbang_detonate', 'inferno_startburn',
]


def r1(v):
    return round(float(v), 1)


def _fstr(v):
    """NaN/None -> None，否则字符串（demoparser2 缺失列常返回 NaN）"""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    s = str(v)
    return s if s and s != 'nan' else None


def _fbool(v):
    if v is None:
        return False
    if isinstance(v, float) and math.isnan(v):
        return False
    return bool(v)


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
    df = parser.parse_ticks(['X', 'Y', 'Z', 'yaw', 'steamid', 'team_num', 'name', 'flash_duration'])
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
    flash_state = {}  # slot -> {prev, start, dur}：推算递减的被白剩余秒数
    for tick, g in df.groupby('tick'):
        arr = [None] * len(players)
        for row in g.itertuples():
            slot = slot_of.get(str(row.steamid))
            if slot is None:
                continue
            raw_flash = 0.0 if math.isnan(row.flash_duration) else float(row.flash_duration)
            if math.isnan(row.X) or math.isnan(row.Y) or math.isnan(row.Z):
                flash_state[slot] = {'prev': 0.0, 'start': tick, 'dur': 0.0}  # 死亡/未入场：清被闪区段
                continue  # 死亡/未入场的实体坐标为 NaN，跳过（帧存 null）
            yaw = 0.0 if math.isnan(row.yaw) else row.yaw
            st = flash_state.get(slot)
            if raw_flash > 0:
                # 新被闪区段：记录起点与满值；之后按时间递减（demoparser2 给的是区段恒定值）
                if st is None or st['prev'] <= 0:
                    st = flash_state[slot] = {'prev': raw_flash, 'start': tick, 'dur': raw_flash}
                remaining = max(st['dur'] - (tick - st['start']) / tick_rate, 0)
                st['prev'] = raw_flash
            else:
                flash_state[slot] = {'prev': 0.0, 'start': tick, 'dur': 0.0}
                remaining = 0.0
            arr[slot] = [r1(row.X), r1(row.Y), r1(row.Z), r1(yaw), r1(remaining)]
        frames.append({'t': int(tick), 'p': arr})

    # ---- P12.1 对局 HUD 统计：8Hz 采样 经济/血量/护甲/武器/存活 ----
    stats = []
    weapons = []
    wpn_idx = {}
    try:
        sdf = parser.parse_ticks(['health', 'armor', 'is_alive', 'active_weapon_name'])
        sdf = sdf[sdf['tick'] % SAMPLE_STATS == 0]
        # 友好名 'money' 会被该库静默丢弃，需用原始 netprop 名并重命名
        money_prop = 'CCSPlayerController.CCSPlayerController_InGameMoneyServices.m_iAccount'
        mdf = parser.parse_ticks([money_prop]).rename(columns={money_prop: 'money'})
        mdf = mdf[mdf['tick'] % SAMPLE_STATS == 0]
        money_map = {}
        for r in mdf.itertuples():
            m = r.money
            money_map[(int(r.tick), str(r.steamid))] = (
                0 if (isinstance(m, float) and math.isnan(m)) else int(round(float(m))))
        for tick, g in sdf.groupby('tick'):
            arr = [None] * len(players)
            for row in g.itertuples():
                slot = slot_of.get(str(row.steamid))
                if slot is None:
                    continue
                wpn = _fstr(row.active_weapon_name)
                if wpn is not None:
                    if wpn not in wpn_idx:
                        wpn_idx[wpn] = len(weapons)
                        weapons.append(wpn)
                h = row.health
                hp = 0 if (isinstance(h, float) and math.isnan(h)) else int(round(float(h)))
                a = row.armor
                ap = 0 if (isinstance(a, float) and math.isnan(a)) else int(round(float(a)))
                money = money_map.get((int(tick), str(row.steamid)), 0)
                arr[slot] = [hp, ap, money, 1 if _fbool(row.is_alive) else 0,
                             wpn_idx[wpn] if wpn is not None else None]
            stats.append({'t': int(tick), 'p': arr})
    except Exception as e:
        print(f'[parse] HUD 统计解析失败（继续）: {e}', file=sys.stderr)

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
            hd = getattr(r, 'headshot', False)
            headshot = bool(hd) if not (isinstance(hd, float) and math.isnan(hd)) else False
            label = f'{attacker} 击杀 {user}（{weapon}）'
            if headshot:
                label += '（爆头）'
            assister_sid = getattr(r, 'assister_steamid', None)
            if assister_sid is not None and not (isinstance(assister_sid, float) and math.isnan(assister_sid)):
                assister = slot_of.get(str(assister_sid))
            else:
                assister = None
            events.append({
                'tick': int(r.tick),
                'type': 'kill',
                'label': label,
                'attacker': str(attacker),
                'user': str(user),
                'weapon': weapon,
                'headshot': headshot,
                'assister': assister,
            })
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

    # ---- P12.1 回合元数据（与回放 round 模型一致：round_start[i] ↔ round_end[i]） ----
    rs_list = []
    if rs is not None and hasattr(rs, 'itertuples'):
        rs_list = sorted({int(r.tick) for r in rs.itertuples()})
    re_list = []
    re_winner = {}
    if re_df is not None and hasattr(re_df, 'itertuples'):
        for r in re_df.itertuples():
            winner = getattr(r, 'winner', None)
            if winner is None or str(winner) == 'nan':
                continue
            s = str(winner).upper()
            team = 'T' if s in ('2', 'T', 'TERRORIST') else (
                'CT' if s in ('3', 'CT', 'COUNTER_TERRORISTS') else None)
            re_list.append(int(r.tick))
            re_winner[int(r.tick)] = team
        re_list.sort()
    rounds = []
    for i, start in enumerate(rs_list):
        end = re_list[i] if i < len(re_list) else None
        rounds.append({
            'start': start,
            'freeze_end': start + 15 * tick_rate,  # CS2 默认准备时长 15s
            'end': end,
            'winner': re_winner.get(end) if end is not None else None,
        })

    pack = {
        'meta': {
            'name': stem,
            'map': map_name,
            'tick_rate': tick_rate,  # 假定值（header 不含），可用 --tick-rate 覆盖
            'sample_every': SAMPLE_EVERY,
            'sample_stats': SAMPLE_STATS,
            'max_tick': max_tick,
            'duration_s': round(max_tick / tick_rate, 1),
            'coord_space': 'source',  # 原始 Source 单位/坐标系，前端负责转换
        },
        'players': players,
        'frames': frames,
        'grenades': grenades,
        'utility_events': utility_events,
        'events': events,
        'stats': stats,
        'rounds': rounds,
        'weapons': weapons,
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
    meta['stats'] = len(stats)
    meta['rounds'] = len(rounds)
    meta['weapons'] = len(weapons)
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
