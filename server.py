"""CS2 战术板本地服务器：静态文件 + SQLite 数据层 + JSON 导入导出备份

数据：board.db（SQLite 单文件）
  annotations    标注表（点位/区域、坐标、层级、样式）
  utilities      道具表（类型、落点标注、投掷方式、轨迹、动画）—— 预留
  tactics        战术表 —— 预留
  tactic_steps   战术-点位/道具关联表 —— 预留

API：
  GET  /api/annotations   全部标注（与前端 positions 结构一致）
  POST /api/annotations   整体替换保存（前端全量提交）
  GET  /api/export        全库导出为 JSON（备份）
  POST /api/import        从 JSON 备份恢复（整体覆盖）
  POST /positions.json    旧接口兼容（同 /api/annotations）
启动时若 annotations 为空且存在 positions.json，自动迁移。
"""
import http.server
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(ROOT, 'board.db')
LEGACY_JSON = os.path.join(ROOT, 'positions.json')

SCHEMA = """
CREATE TABLE IF NOT EXISTS annotations (
  name          TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'point',
  x             REAL,
  y             REAL,
  z             REAL,
  points        TEXT,           -- JSON: 区域多边形 [[x,z],...]
  height        REAL,
  parent        TEXT,
  font_size     REAL,
  color         TEXT,
  label_color   TEXT,
  outline_color TEXT,
  opacity       REAL
);
CREATE TABLE IF NOT EXISTS utilities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT,          -- smoke / flash / molotov
  landing_point   TEXT,          -- 关联落点标注名 annotations.name
  throw_type      TEXT,          -- 投掷方式：站投/跳投/跑投...
  trajectory      TEXT,          -- JSON: 轨迹控制点
  animation       TEXT,          -- 演示动画参数
  created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS tactics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS tactic_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tactic_id   INTEGER NOT NULL REFERENCES tactics(id) ON DELETE CASCADE,
  step_order  INTEGER NOT NULL,
  annotation  TEXT,            -- 关联点位标注名
  utility_id  INTEGER REFERENCES utilities(id) ON DELETE SET NULL,
  note        TEXT
);
"""

ANN_COLS = ['name', 'type', 'x', 'y', 'z', 'points', 'height', 'parent',
            'font_size', 'color', 'label_color', 'outline_color', 'opacity']
# DB 列名 -> 前端字段名（下划线转驼峰差异处理）
COL_TO_KEY = {
    'name': 'name', 'type': 'type', 'x': 'x', 'y': 'y', 'z': 'z',
    'points': 'points', 'height': 'height', 'parent': 'parent',
    'font_size': 'fontSize', 'color': 'color',
    'label_color': 'labelColor', 'outline_color': 'outlineColor', 'opacity': 'opacity',
}
KEY_TO_COL = {v: k for k, v in COL_TO_KEY.items()}


def get_db():
    db = sqlite3.connect(DB_FILE)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def row_to_ann(row):
    ann = {}
    for col in ANN_COLS:
        val = row[col]
        if val is None:
            continue
        key = COL_TO_KEY[col]
        if col == 'points' and isinstance(val, str):
            val = json.loads(val)
        ann[key] = val
    return ann


def ann_to_params(name, ann):
    params = {'name': name}
    for key, col in KEY_TO_COL.items():
        if key == 'name':
            continue
        val = ann.get(key)
        if key == 'points' and val is not None:
            val = json.dumps(val, ensure_ascii=False)
        params[col] = val
    return params


def load_all_annotations(db):
    rows = db.execute(f"SELECT {', '.join(ANN_COLS)} FROM annotations").fetchall()
    return {row['name']: row_to_ann(row) for row in rows}


def replace_all_annotations(db, data):
    with db:
        db.execute('DELETE FROM annotations')
        db.executemany(
            f"INSERT INTO annotations ({', '.join(ANN_COLS)}) "
            f"VALUES ({', '.join(':' + c for c in ANN_COLS)})",
            [ann_to_params(name, ann) for name, ann in data.items()],
        )


def export_all(db):
    out = {'annotations': load_all_annotations(db)}
    for table in ('utilities', 'tactics', 'tactic_steps'):
        out[table] = [dict(r) for r in db.execute(f'SELECT * FROM {table}').fetchall()]
    return out


def import_all(db, data):
    with db:
        if 'annotations' in data:
            replace_all_annotations(db, data['annotations'])
        for table in ('utilities', 'tactics', 'tactic_steps'):
            rows = data.get(table)
            if not isinstance(rows, list):
                continue
            db.execute(f'DELETE FROM {table}')
            for row in rows:
                cols = ', '.join(row.keys())
                db.execute(
                    f'INSERT INTO {table} ({cols}) VALUES ({", ".join("?" * len(row))})',
                    list(row.values()),
                )


def migrate_legacy_json(db):
    count = db.execute('SELECT COUNT(*) FROM annotations').fetchone()[0]
    if count == 0 and os.path.exists(LEGACY_JSON):
        try:
            with open(LEGACY_JSON, encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                replace_all_annotations(db, data)
                print(f'[db] 已从 positions.json 迁移 {len(data)} 条标注')
        except Exception as e:
            print(f'[db] positions.json 迁移失败: {e}')


class Handler(http.server.SimpleHTTPRequestHandler):
    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/annotations':
            db = get_db()
            self._send_json(load_all_annotations(db))
            db.close()
        elif path == '/api/export':
            db = get_db()
            self._send_json(export_all(db))
            db.close()
        else:
            super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if path in ('/api/annotations', '/positions.json'):
                data = self._read_json()
                if not isinstance(data, dict):
                    raise ValueError('annotations must be a JSON object')
                db = get_db()
                replace_all_annotations(db, data)
                db.close()
                self._send_json({'ok': True})
            elif path == '/api/import':
                data = self._read_json()
                db = get_db()
                import_all(db, data)
                db.close()
                self._send_json({'ok': True})
            else:
                self.send_response(404)
                self.end_headers()
        except Exception as e:
            self._send_json({'error': str(e)}, code=400)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    os.chdir(ROOT)
    db = get_db()
    migrate_legacy_json(db)
    db.close()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 8000), Handler)
    print('serving at http://localhost:8000 (db: board.db)')
    server.serve_forever()
