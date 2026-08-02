"""CS2 战术板后端（FastAPI 版，取代 server.py）

静态文件 + 道具/战术/demo REST API + JSON 备份导入导出 + 对齐校验图写盘
启动：.venv\\Scripts\\uvicorn app:app --host 127.0.0.1 --port 8000
文档：http://localhost:8000/docs
"""
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime

from fastapi import Body, FastAPI, File, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, SQLModel, select

from models import Annotation, DemoEvent, Match, ShareLink, Tactic, TacticStep, Utility, engine
from auth import validate_connection, get_or_create_user
from room_manager import create_room, join_room, leave_room, broadcast, get_room, room_count
from op_handler import handle_message

ROOT = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title='CS2 战术板 API', version='1.0.0')

# DB 列名 <-> 前端字段名（下划线 <-> 驼峰）
COL_TO_KEY = {
    'name': 'name', 'type': 'type', 'x': 'x', 'y': 'y', 'z': 'z',
    'points': 'points', 'height': 'height', 'floorY': 'floorY', 'parent': 'parent',
    'font_size': 'fontSize', 'color': 'color',
    'label_color': 'labelColor', 'outline_color': 'outlineColor', 'opacity': 'opacity',
}
KEY_TO_COL = {v: k for k, v in COL_TO_KEY.items()}


def row_to_ann(row: Annotation) -> dict:
    ann = {}
    for col, key in COL_TO_KEY.items():
        val = getattr(row, col)
        if val is None:
            continue
        if col == 'points' and isinstance(val, str):
            val = json.loads(val)
        ann[key] = val
    return ann


def ann_to_params(name: str, ann: dict) -> dict:
    params = {'name': name}
    for key, col in KEY_TO_COL.items():
        if key == 'name':
            continue
        val = ann.get(key)
        if key == 'points' and val is not None:
            val = json.dumps(val, ensure_ascii=False)
        params[col] = val
    return params


def load_all_annotations() -> dict:
    with Session(engine) as db:
        rows = db.exec(select(Annotation)).all()
        return {r.name: row_to_ann(r) for r in rows}


def replace_all_annotations(data: dict):
    with Session(engine) as db:
        for row in db.exec(select(Annotation)).all():
            db.delete(row)
        for name, ann in data.items():
            db.add(Annotation(**ann_to_params(name, ann)))
        db.commit()


@app.on_event('startup')
def startup():
    SQLModel.metadata.create_all(engine)  # 新库建表；老库由 Alembic 管迁移


# ---- utilities 道具库 CRUD ----
UTILITY_FIELDS = set(Utility.model_fields.keys()) - {'id'}


def utility_params(data: dict) -> dict:
    return {k: v for k, v in data.items() if k in UTILITY_FIELDS}


@app.get('/api/utilities')
def list_utilities():
    with Session(engine) as db:
        return [r.model_dump() for r in db.exec(select(Utility)).all()]


@app.post('/api/utilities')
def create_utility(data: dict = Body(...)):
    params = utility_params(data)
    if not params.get('name'):
        return {'error': 'name is required'}
    params.setdefault('created_at', datetime.now().isoformat(timespec='seconds'))
    with Session(engine) as db:
        u = Utility(**params)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u.model_dump()


@app.put('/api/utilities/{uid}')
def update_utility(uid: int, data: dict = Body(...)):
    with Session(engine) as db:
        u = db.get(Utility, uid)
        if not u:
            return {'error': 'not found'}
        for k, v in utility_params(data).items():
            setattr(u, k, v)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u.model_dump()


@app.delete('/api/utilities/{uid}')
def delete_utility(uid: int):
    with Session(engine) as db:
        u = db.get(Utility, uid)
        if not u:
            return {'error': 'not found'}
        db.delete(u)
        db.commit()
        return {'ok': True}


# ---- tactics 战术编排 CRUD（步骤随战术整体存取） ----
def step_to_dict(row: TacticStep) -> dict:
    d = row.model_dump()
    for key in ('actors', 'utility_ids'):
        if isinstance(d.get(key), str):
            try:
                d[key] = json.loads(d[key])
            except Exception:
                pass
    return d


def tactic_to_dict(row: Tactic, steps) -> dict:
    d = row.model_dump()
    d['steps'] = [step_to_dict(s) for s in steps]
    return d


def get_tactic_steps(db: Session, tid: int):
    return db.exec(
        select(TacticStep).where(TacticStep.tactic_id == tid).order_by(TacticStep.step_order)
    ).all()


@app.get('/api/tactics')
def list_tactics():
    with Session(engine) as db:
        return [tactic_to_dict(t, get_tactic_steps(db, t.id)) for t in db.exec(select(Tactic)).all()]


@app.post('/api/tactics')
def create_tactic(data: dict = Body(...)):
    name = (data.get('name') or '').strip()
    if not name:
        return {'error': 'name is required'}
    with Session(engine) as db:
        t = Tactic(
            name=name,
            description=data.get('description'),
            created_at=datetime.now().isoformat(timespec='seconds'),
        )
        db.add(t)
        db.commit()
        db.refresh(t)
        return tactic_to_dict(t, [])


@app.put('/api/tactics/{tid}')
def update_tactic(tid: int, data: dict = Body(...)):
    with Session(engine) as db:
        t = db.get(Tactic, tid)
        if not t:
            return {'error': 'not found'}
        if 'name' in data:
            t.name = data['name']
        if 'description' in data:
            t.description = data['description']
        db.add(t)
        if isinstance(data.get('steps'), list):
            # steps 给了就全量替换该战术的步骤
            for row in get_tactic_steps(db, tid):
                db.delete(row)
            for i, s in enumerate(data['steps']):
                if not isinstance(s, dict):
                    continue
                db.add(TacticStep(
                    tactic_id=tid,
                    step_order=s.get('step_order', i),
                    annotation=s.get('annotation'),
                    utility_id=s.get('utility_id'),
                    note=s.get('note'),
                    actors=json.dumps(s['actors'], ensure_ascii=False) if s.get('actors') is not None else None,
                    utility_ids=json.dumps(s['utility_ids'], ensure_ascii=False) if s.get('utility_ids') is not None else None,
                    duration=s.get('duration', 2.0),
                ))
        db.commit()
        return tactic_to_dict(t, get_tactic_steps(db, tid))


@app.delete('/api/tactics/{tid}')
def delete_tactic(tid: int):
    with Session(engine) as db:
        t = db.get(Tactic, tid)
        if not t:
            return {'error': 'not found'}
        for row in get_tactic_steps(db, tid):  # 先删步骤（外键）
            db.delete(row)
        db.delete(t)
        db.commit()
        return {'ok': True}


# ---- P6 战术包：自包含导出/导入（道具按内容哈希去重） ----
def utility_content_hash(u: Utility) -> str:
    """道具内容指纹：同一份 lineup 在不同库中哈希一致"""
    payload = {
        'name': u.name, 'type': u.type, 'throw_type': u.throw_type,
        'stand_x': u.stand_x, 'stand_y': u.stand_y, 'stand_z': u.stand_z,
        'landing_x': u.landing_x, 'landing_y': u.landing_y, 'landing_z': u.landing_z,
        'landing_point': u.landing_point, 'trajectory': u.trajectory,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode('utf-8')
    ).hexdigest()[:16]


@app.get('/api/tactics/{tid}/pack')
def export_tactic_pack(tid: int):
    with Session(engine) as db:
        t = db.get(Tactic, tid)
        if not t:
            return {'error': 'not found'}
        steps = [step_to_dict(s) for s in get_tactic_steps(db, tid)]

        # 收集步骤引用的道具与标注，全部内嵌（自包含）
        util_ids = sorted({uid for s in steps for uid in (s.get('utility_ids') or [])})
        utils = []
        ann_names = set()
        for uid in util_ids:
            u = db.get(Utility, uid)
            if not u:
                continue
            d = u.model_dump()
            d['content_hash'] = utility_content_hash(u)
            utils.append(d)
            if u.landing_point:
                ann_names.add(u.landing_point)
        for s in steps:
            if s.get('annotation'):
                ann_names.add(s['annotation'])
        anns = [row_to_ann(r) for r in db.exec(select(Annotation)).all()
                if r.name in ann_names]
        for a in anns:
            a['_name'] = a.pop('name')

        return {
            'format': 'cs2-tactic-pack',
            'version': 1,
            'exported_at': datetime.now().isoformat(timespec='seconds'),
            'tactic': {'name': t.name, 'description': t.description},
            'steps': steps,
            'utilities': utils,
            'annotations': anns,
        }


@app.post('/api/tactics/import')
def import_tactic_pack(pack: dict = Body(...)):
    if pack.get('format') != 'cs2-tactic-pack':
        return {'error': 'not a cs2-tactic-pack'}

    with Session(engine) as db:
        # 1) 标注：缺的补（按名字）
        existing = {r.name for r in db.exec(select(Annotation)).all()}
        for a in pack.get('annotations') or []:
            name = a.pop('_name', None)
            if name and name not in existing:
                db.add(Annotation(**ann_to_params(name, a)))

        # 2) 道具：按内容哈希去重，建立 旧id -> 新id 映射
        existing_utils = db.exec(select(Utility)).all()
        hash_to_id = {utility_content_hash(u): u.id for u in existing_utils}
        id_map = {}
        for d in pack.get('utilities') or []:
            old_id = d.pop('id', None)
            ch = d.pop('content_hash', None)
            d.pop('created_at', None)
            if ch and ch in hash_to_id:
                id_map[old_id] = hash_to_id[ch]
                continue
            params = {k: v for k, v in d.items() if k in UTILITY_FIELDS}
            u = Utility(**params)
            u.created_at = datetime.now().isoformat(timespec='seconds')
            db.add(u)
            db.commit()
            db.refresh(u)
            id_map[old_id] = u.id
            hash_to_id[ch or utility_content_hash(u)] = u.id

        # 3) 战术：重名自动加后缀，步骤里的 utility_ids 重映射
        base = (pack.get('tactic') or {}).get('name') or '导入战术'
        name = base
        names = {t.name for t in db.exec(select(Tactic)).all()}
        n = 2
        while name in names:
            name = f'{base}({n})'
            n += 1
        t = Tactic(name=name, description=(pack.get('tactic') or {}).get('description'),
                   created_at=datetime.now().isoformat(timespec='seconds'))
        db.add(t)
        db.commit()
        db.refresh(t)

        for i, s in enumerate(pack.get('steps') or []):
            uids = [id_map.get(uid) for uid in (s.get('utility_ids') or [])]
            uids = [uid for uid in uids if uid is not None]
            db.add(TacticStep(
                tactic_id=t.id,
                step_order=s.get('step_order', i),
                annotation=s.get('annotation'),
                utility_id=s.get('utility_id'),
                note=s.get('note'),
                actors=json.dumps(s['actors'], ensure_ascii=False) if s.get('actors') is not None else None,
                utility_ids=json.dumps(uids, ensure_ascii=False),
                duration=s.get('duration', 2.0),
            ))
        db.commit()
        return tactic_to_dict(t, get_tactic_steps(db, t.id))


# ---- 战术板分享链接（P8） ----

@app.post('/api/share')
def create_share(data: dict = Body(...)):
    """创建战术板分享链接，返回 share_id"""
    with Session(engine) as db:
        for _ in range(3):
            sid = uuid.uuid4().hex[:8]
            existing = db.get(ShareLink, sid)
            if not existing:
                break
        sl = ShareLink(
            share_id=sid,
            tactic_data=json.dumps(data, ensure_ascii=False),
            created_at=datetime.now().isoformat(timespec='seconds'),
        )
        db.add(sl)
        db.commit()
        return {'share_id': sid}


@app.get('/api/share/{share_id}')
def get_share(share_id: str):
    """按 share_id 获取完整战术包"""
    with Session(engine) as db:
        sl = db.get(ShareLink, share_id)
        if not sl:
            return {'error': 'not found'}
        return json.loads(sl.tactic_data)


@app.get('/view/{share_id}')
def view_share(share_id: str):
    """分享查看页面"""
    share_html = os.path.join(ROOT, 'web', 'dist', 'share.html')
    if not os.path.exists(share_html):
        return {'error': 'share page not built, run: cd web && npm run build'}
    return FileResponse(share_html)


# ---- 房间管理（P9） ----

@app.post('/api/rooms')
def api_create_room(data: dict = Body(...)):
    """创建房间。需 anonymous_id + token 验证。"""
    anonymous_id = data.get('anonymous_id', '')
    token = data.get('token', '')
    if not validate_connection(anonymous_id, token):
        return {'error': 'auth failed'}
    user = get_or_create_user(anonymous_id, data.get('nickname', ''))
    # create_room is async, run in event loop
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        code = loop.run_until_complete(create_room(anonymous_id, data.get('name', '')))
    finally:
        loop.close()
    return {'code': code}


@app.get('/api/rooms/{code}')
def api_get_room(code: str):
    """查询房间信息"""
    room = get_room(code)
    if not room:
        return {'error': 'not found'}
    return {
        'code': room.code,
        'name': room.name,
        'player_count': len(room.players),
        'is_active': True,
    }


@app.post('/api/rooms/{code}/join')
def api_join_room(code: str, data: dict = Body(...)):
    """加入房间验证——仅验证 token，不建立 WebSocket。实际连接走 /ws/"""
    anonymous_id = data.get('anonymous_id', '')
    token = data.get('token', '')
    if not validate_connection(anonymous_id, token):
        return {'error': 'auth failed'}
    room = get_room(code)
    if not room:
        return {'error': 'room not found'}
    get_or_create_user(anonymous_id, data.get('nickname', ''))
    return {'ok': True, 'code': code}


@app.delete('/api/rooms/{code}')
def api_close_room(code: str, data: dict = Body(...)):
    """关闭房间（需 owner 验证）"""
    anonymous_id = data.get('anonymous_id', '')
    token = data.get('token', '')
    if not validate_connection(anonymous_id, token):
        return {'error': 'auth failed'}
    room = get_room(code)
    if not room:
        return {'error': 'not found'}
    if room.owner_id != anonymous_id:
        return {'error': 'only room owner can close'}
    # 踢所有人
    import asyncio
    async def kick_all():
        for uid in list(room.players.keys()):
            await leave_room(code, uid)
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(kick_all())
    finally:
        loop.close()
    return {'ok': True}


# ---- demos 回放（P7） ----
DEMOS_RAW = os.path.join(ROOT, 'data', 'demos', 'raw')
DEMOS_PARSED = os.path.join(ROOT, 'data', 'demos', 'parsed')
PARSE_SCRIPT = os.path.join(ROOT, 'tools', 'parse_demo.py')


def safe_stem(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(filename or ''))[0]
    stem = re.sub(r'[^\w\-.]+', '_', stem, flags=re.UNICODE)
    return stem or 'demo'


def run_parse_pipeline(raw_path: str) -> dict:
    """调 tools/parse_demo.py（子进程隔离内存），返回 meta（含 _events）"""
    proc = subprocess.run(
        [sys.executable, PARSE_SCRIPT, raw_path],
        capture_output=True, text=True, cwd=ROOT, timeout=3600,
    )
    if proc.returncode != 0:
        raise RuntimeError('解析失败: ' + (proc.stderr or proc.stdout)[-500:])
    return json.loads(proc.stdout.strip().splitlines()[-1])


def register_demo(match: Match):
    """已存在同名 match 则复用（重传幂等），刷新 demo_events"""
    with Session(engine) as db:
        row = db.exec(select(Match).where(Match.name == match.name)).first()
        if row:
            return row, False
        db.add(match)
        db.commit()
        db.refresh(match)
        return match, True


@app.post('/api/demos/upload')
def upload_demo(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith('.dem'):
        return {'error': '只接受 .dem 文件'}
    os.makedirs(DEMOS_RAW, exist_ok=True)
    os.makedirs(DEMOS_PARSED, exist_ok=True)
    stem = safe_stem(file.filename)
    raw_path = os.path.join(DEMOS_RAW, stem + '.dem')
    with open(raw_path, 'wb') as f:
        shutil.copyfileobj(file.file, f)

    parsed_path = os.path.join(DEMOS_PARSED, stem + '.json.gz')
    try:
        if os.path.exists(parsed_path):
            # 已解析过同名文件：直接复用结果登记
            with gzip.open(parsed_path, 'rt', encoding='utf-8') as f:
                pack = json.load(f)
            meta = dict(pack['meta'])
            meta['file_parsed'] = os.path.relpath(parsed_path, ROOT).replace('\\', '/')
            events = pack.get('events', [])
        else:
            meta = run_parse_pipeline(raw_path)
            events = meta.pop('_events', [])
    except Exception as e:
        return {'error': str(e)}

    rel_raw = os.path.relpath(raw_path, ROOT).replace('\\', '/')
    m = Match(
        name=meta.get('name', stem),
        map=meta.get('map'),
        duration_s=meta.get('duration_s'),
        file_raw=rel_raw,
        file_parsed=meta.get('file_parsed'),
        created_at=datetime.now().isoformat(timespec='seconds'),
    )
    row, is_new = register_demo(m)
    if is_new:
        with Session(engine) as db:
            for ev in events:
                db.add(DemoEvent(match_id=row.id, tick=ev['tick'], type=ev['type'], label=ev.get('label')))
            db.commit()
    return row.model_dump()


@app.get('/api/demos')
def list_demos():
    with Session(engine) as db:
        return [r.model_dump() for r in db.exec(select(Match)).all()]


@app.get('/api/demos/{mid}/pack')
def get_demo_pack(mid: int):
    with Session(engine) as db:
        m = db.get(Match, mid)
        if not m:
            return {'error': 'not found'}
        path = m.file_parsed
    if not path:
        return {'error': 'no parsed file'}
    abs_path = path if os.path.isabs(path) else os.path.join(ROOT, path)
    if not os.path.exists(abs_path):
        return {'error': 'parsed file missing'}
    with gzip.open(abs_path, 'rt', encoding='utf-8') as f:
        return json.load(f)


@app.delete('/api/demos/{mid}')
def delete_demo(mid: int):
    with Session(engine) as db:
        m = db.get(Match, mid)
        if not m:
            return {'error': 'not found'}
        for row in db.exec(select(DemoEvent).where(DemoEvent.match_id == mid)).all():
            db.delete(row)
        db.delete(m)
        db.commit()
        for rel in (m.file_raw, m.file_parsed):
            if not rel:
                continue
            p = rel if os.path.isabs(rel) else os.path.join(ROOT, rel)
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return {'ok': True}


@app.get('/api/export')
def export_all():
    out = {'annotations': load_all_annotations()}
    with Session(engine) as db:
        out['utilities'] = [r.model_dump() for r in db.exec(select(Utility)).all()]
        out['tactics'] = [r.model_dump() for r in db.exec(select(Tactic)).all()]
        out['tactic_steps'] = [r.model_dump() for r in db.exec(select(TacticStep)).all()]
    return out


@app.post('/api/import')
def import_all(data: dict = Body(...)):
    if 'annotations' in data and isinstance(data['annotations'], dict):
        replace_all_annotations(data['annotations'])
    with Session(engine) as db:
        for model, table in ((Utility, 'utilities'), (Tactic, 'tactics'), (TacticStep, 'tactic_steps')):
            rows = data.get(table)
            if not isinstance(rows, list):
                continue
            for row in db.exec(select(model)).all():
                db.delete(row)
            for row in rows:
                db.add(model(**row))
        db.commit()
    return {'ok': True}


@app.post('/api/export-align')
async def export_align(request: Request):
    """对齐校验图：前端画布 PNG 写盘到项目根目录 check_align.png"""
    data = await request.body()
    if not data:
        return {'error': 'empty body'}
    out = os.path.join(ROOT, 'check_align.png')
    with open(out, 'wb') as f:
        f.write(data)
    return {'ok': True, 'path': 'check_align.png', 'bytes': len(data)}


@app.websocket('/ws/{room_code}')
async def room_websocket(ws: WebSocket, room_code: str):
    # 浏览器 WebSocket API 不支持自定义 header，改为连接建立后读首条 _auth JSON 消息
    await ws.accept()
    try:
        first = await ws.receive_json()
    except Exception:
        await ws.close(code=4001, reason='no auth message')
        return
    if first.get('_auth'):
        anonymous_id = first['_auth'].get('anonymous_id', '')
        token = first['_auth'].get('token', '')
        nickname = first['_auth'].get('nickname', '游客')
    else:
        await ws.close(code=4001, reason='auth required')
        return

    if not validate_connection(anonymous_id, token):
        await ws.close(code=4001, reason='auth failed')
        return

    user = get_or_create_user(anonymous_id, nickname)
    room = get_room(room_code)
    if not room:
        await ws.close(code=4004, reason='room not found')
        return

    await join_room(room_code, anonymous_id, ws)

    # 发给新用户：当前房间完整状态
    await ws.send_json({
        'op': 'room_state',
        'board': room.board_state,
        'tactic_id': room.tactic_id,
        'players': [{'user_id': uid, 'nickname': '玩家'} for uid in room.players],
        'my_user_id': anonymous_id,
    })
    # 广播给其他人
    await broadcast(room, {
        'op': 'player_joined',
        'user_id': anonymous_id,
        'nickname': nickname,
    }, exclude_user=anonymous_id)

    try:
        while True:
            msg = await ws.receive_json()
            await handle_message(room, anonymous_id, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await leave_room(room_code, anonymous_id)
        await broadcast(room, {
            'op': 'player_left',
            'user_id': anonymous_id,
        })


# 静态文件必须最后挂载（API 路由优先）
# 前端已迁移到 web/（Vite 构建产物 web/dist）；模型/解码器仍按原相对路径提供
app.mount('/data', StaticFiles(directory=os.path.join(ROOT, 'data')), name='data')
app.mount('/libs', StaticFiles(directory=os.path.join(ROOT, 'libs')), name='libs')
app.mount('/', StaticFiles(directory=os.path.join(ROOT, 'web', 'dist'), html=True), name='static')
