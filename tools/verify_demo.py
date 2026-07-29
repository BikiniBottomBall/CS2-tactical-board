# P7 阶段A 技术验证：demoparser2 能读到什么
# 用法：.venv/Scripts/python.exe tools/verify_demo.py <demo.dem>
import sys

from demoparser2 import DemoParser

path = sys.argv[1]
parser = DemoParser(path)

print('== header ==')
header = parser.parse_header()
print(header)

print('\n== 玩家列表（parse_ticks 第一帧拿 name/steamid/team） ==')
props = ['X', 'Y', 'Z', 'yaw', 'pitch', 'name', 'steamid', 'team_name', 'team_num', 'health', 'is_alive']
try:
    df = parser.parse_ticks(props, ticks=[100])
    print(df)
except Exception as e:
    print('parse_ticks(ticks=[100]) 失败:', e)
    print('尝试全量小范围…')
    df = parser.parse_ticks(props)
    print(df.head(20))
    print('总行数:', len(df))

print('\n== 事件探测 ==')
for ev in ['round_start', 'round_end', 'player_death', 'bomb_planted', 'bomb_defused',
           'smokegrenade_detonate', 'flashbang_detonate', 'inferno_startburn',
           'molotov_detonate', 'hegrenade_detonate', 'weapon_fire']:
    try:
        edf = parser.parse_event(ev)
        print(f'{ev}: {len(edf)} 行, 列={list(edf.columns)[:14]}')
        if len(edf):
            print(edf.head(2).to_string())
    except Exception as e:
        print(f'{ev}: 失败 {type(e).__name__}: {e}')

print('\n== tick 范围 ==')
try:
    df2 = parser.parse_ticks(['X'])
    print('min tick:', df2['tick'].min(), 'max tick:', df2['tick'].max(), '帧数:', df2['tick'].nunique())
except Exception as e:
    print('失败:', e)
