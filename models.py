"""SQLModel 表结构与数据库连接

annotations    标注表（点位/区域、坐标、层级、样式）
utilities      道具表（预留）
tactics        战术表（预留）
tactic_steps   战术-点位/道具关联表（预留）

连接串走环境变量 BOARD_DB_URL，默认 sqlite:///board.db
"""
import os
from typing import Optional

from sqlmodel import Field, SQLModel, create_engine

DB_URL = os.environ.get('BOARD_DB_URL', 'sqlite:///board.db')
engine = create_engine(DB_URL, echo=False)


class Annotation(SQLModel, table=True):
    __tablename__ = 'annotations'

    name: str = Field(primary_key=True)
    type: str = Field(default='point')
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    points: Optional[str] = None      # JSON 字符串：区域多边形 [[x,z],...]
    height: Optional[float] = None
    floorY: Optional[float] = None    # 楼层选择（上下层同屏时按此高度层投影）
    parent: Optional[str] = None
    font_size: Optional[float] = None
    color: Optional[str] = None
    label_color: Optional[str] = None
    outline_color: Optional[str] = None
    opacity: Optional[float] = None


class Utility(SQLModel, table=True):
    __tablename__ = 'utilities'

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    type: Optional[str] = None          # smoke / flash / molotov
    landing_point: Optional[str] = None  # 关联落点标注名 annotations.name
    throw_type: Optional[str] = None     # 投掷方式：站投/跳投/跑投...
    trajectory: Optional[str] = None     # JSON: 轨迹控制点
    animation: Optional[str] = None      # 演示动画参数
    stand_x: Optional[float] = None      # 站位（世界坐标）
    stand_y: Optional[float] = None
    stand_z: Optional[float] = None
    landing_x: Optional[float] = None    # 落点（世界坐标）
    landing_y: Optional[float] = None
    landing_z: Optional[float] = None
    created_at: Optional[str] = None


class Tactic(SQLModel, table=True):
    __tablename__ = 'tactics'

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    description: Optional[str] = None
    created_at: Optional[str] = None


class TacticStep(SQLModel, table=True):
    __tablename__ = 'tactic_steps'

    id: Optional[int] = Field(default=None, primary_key=True)
    tactic_id: int = Field(foreign_key='tactics.id')
    step_order: int
    annotation: Optional[str] = None     # 关联点位标注名
    utility_id: Optional[int] = Field(default=None, foreign_key='utilities.id')
    note: Optional[str] = None
    actors: Optional[str] = None         # JSON: [{"id":"T1","x":..,"y":..,"z":..}, ...]
    utility_ids: Optional[str] = None    # JSON 数组：该步投出的道具 id
    duration: Optional[float] = 2.0      # 该步移动时长（秒）


class Match(SQLModel, table=True):
    """demo 对局登记（P7）"""
    __tablename__ = 'matches'

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    map: Optional[str] = None
    duration_s: Optional[float] = None
    file_raw: Optional[str] = None        # data/demos/raw/xxx.dem
    file_parsed: Optional[str] = None     # data/demos/parsed/xxx.json.gz
    created_at: Optional[str] = None


class DemoEvent(SQLModel, table=True):
    """demo 书签事件（P7）：round_start/kill/plant/defuse/round_end"""
    __tablename__ = 'demo_events'

    id: Optional[int] = Field(default=None, primary_key=True)
    match_id: int = Field(foreign_key='matches.id')
    tick: int
    type: str                             # round_start / kill / plant / defuse / round_end
    label: Optional[str] = None


class ModelRecord(SQLModel, table=True):
    """地图模型登记（data/models/ 管线产物）"""
    __tablename__ = 'models'

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)          # de_dust2
    path: str                              # data/models/de_dust2.glb
    version: Optional[str] = None
    size_bytes: Optional[int] = None
    bbox: Optional[str] = None             # JSON: 归一化包围盒
    created_at: Optional[str] = None


class ShareLink(SQLModel, table=True):
    """战术板分享链接（P8）"""
    __tablename__ = 'share_links'

    id: Optional[int] = Field(default=None, primary_key=True)
    share_id: str = Field(index=True, unique=True)   # uuid4 hex[:8]，唯一
    tactic_data: Optional[str] = None                 # JSON 字符串：完整战术包
    created_at: Optional[str] = None
