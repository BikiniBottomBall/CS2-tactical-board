"""CS2 战术板后端（FastAPI 版，取代 server.py）

静态文件 + annotations CRUD + JSON 备份导入导出
启动：.venv\\Scripts\\uvicorn app:app --host 127.0.0.1 --port 8000
文档：http://localhost:8000/docs
"""
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

from fastapi import Body, FastAPI, File, UploadFile
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, SQLModel, select

from models import Annotation, DemoEvent, Match, Tactic, TacticStep, Utility, engine

ROOT = os.path.dirname(os.path.abspath(__file__))
LEGACY_JSON = os.path.join(ROOT, 'positions.json')

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


def migrate_legacy_json():
    """老 positions.json 自动迁移（仅当库为空）"""
    with Session(engine) as db:
        count = len(db.exec(select(Annotation)).all())
        if count > 0 or not os.path.exists(LEGACY_JSON):
            return
        try:
            with open(LEGACY_JSON, encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                replace_all_annotations(data)
                print(f'[db] 已从 positions.json 迁移 {len(data)} 条标注')
        except Exception as e:
            print(f'[db] positions.json 迁移失败: {e}')


@app.on_event('startup')
def startup():
    SQLModel.metadata.create_all(engine)  # 新库建表；老库由 Alembic 管迁移
    migrate_legacy_json()


@app.get('/api/annotations')
def get_annotations():
    return load_all_annotations()


@app.post('/api/annotations')
def save_annotations(data: dict = Body(...)):
    if not isinstance(data, dict):
        return {'error': 'annotations must be a JSON object'}
    replace_all_annotations(data)
    return {'ok': True}


@app.post('/positions.json')
def save_legacy(data: dict = Body(...)):
    """旧接口兼容"""
    return save_annotations(data)


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


# 静态文件必须最后挂载（API 路由优先）
# 前端已迁移到 web/（Vite 构建产物 web/dist）；模型/解码器仍按原相对路径提供
app.mount('/data', StaticFiles(directory=os.path.join(ROOT, 'data')), name='data')
app.mount('/libs', StaticFiles(directory=os.path.join(ROOT, 'libs')), name='libs')
app.mount('/', StaticFiles(directory=os.path.join(ROOT, 'web', 'dist'), html=True), name='static')
