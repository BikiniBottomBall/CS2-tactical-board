"""SQLModel 表结构与数据库连接

annotations    标注表（已废弃：P10 起停用，表结构保留）
utilities      道具表
tactics        战术表
tactic_steps   战术步骤表

连接串走 config.settings.board_db_url（环境变量 BOARD_DB_URL，默认 sqlite:///board.db）
"""

from sqlmodel import Field, SQLModel, create_engine

from config import settings

engine = create_engine(settings.board_db_url, echo=False)


class Annotation(SQLModel, table=True):
    __tablename__ = "annotations"

    name: str = Field(primary_key=True)
    type: str = Field(default="point")
    x: float | None = None
    y: float | None = None
    z: float | None = None
    points: str | None = None  # JSON 字符串：区域多边形 [[x,z],...]
    height: float | None = None
    floorY: float | None = None  # noqa: N815  # 楼层选择（前后端 API 字段名兼容）
    parent: str | None = None
    font_size: float | None = None
    color: str | None = None
    label_color: str | None = None
    outline_color: str | None = None
    opacity: float | None = None


class Utility(SQLModel, table=True):
    __tablename__ = "utilities"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    type: str | None = None  # smoke / flash / molotov
    landing_point: str | None = None  # 关联落点标注名 annotations.name
    throw_type: str | None = None  # 投掷方式：站投/跳投/跑投...
    trajectory: str | None = None  # JSON: 轨迹控制点
    animation: str | None = None  # 演示动画参数
    stand_x: float | None = None  # 站位（世界坐标）
    stand_y: float | None = None
    stand_z: float | None = None
    landing_x: float | None = None  # 落点（世界坐标）
    landing_y: float | None = None
    landing_z: float | None = None
    created_at: str | None = None


class Tactic(SQLModel, table=True):
    __tablename__ = "tactics"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    description: str | None = None
    created_at: str | None = None


class TacticStep(SQLModel, table=True):
    __tablename__ = "tactic_steps"

    id: int | None = Field(default=None, primary_key=True)
    tactic_id: int = Field(foreign_key="tactics.id")
    step_order: int
    annotation: str | None = None  # 关联点位标注名
    utility_id: int | None = Field(default=None, foreign_key="utilities.id")
    note: str | None = None
    actors: str | None = None  # JSON: [{"id":"T1","x":..,"y":..,"z":..}, ...]
    utility_ids: str | None = None  # JSON 数组：该步投出的道具 id
    duration: float | None = 2.0  # 该步移动时长（秒）


class Match(SQLModel, table=True):
    """demo 对局登记（P7）"""

    __tablename__ = "matches"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    map: str | None = None
    duration_s: float | None = None
    file_raw: str | None = None  # data/demos/raw/xxx.dem
    file_parsed: str | None = None  # data/demos/parsed/xxx.json.gz
    created_at: str | None = None


class DemoEvent(SQLModel, table=True):
    """demo 书签事件（P7）：round_start/kill/plant/defuse/round_end"""

    __tablename__ = "demo_events"

    id: int | None = Field(default=None, primary_key=True)
    match_id: int = Field(foreign_key="matches.id")
    tick: int
    type: str  # round_start / kill / plant / defuse / round_end
    label: str | None = None


class ModelRecord(SQLModel, table=True):
    """地图模型登记（data/models/ 管线产物）"""

    __tablename__ = "models"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)  # de_dust2
    path: str  # data/models/de_dust2.glb
    version: str | None = None
    size_bytes: int | None = None
    bbox: str | None = None  # JSON: 归一化包围盒
    created_at: str | None = None


class ShareLink(SQLModel, table=True):
    """战术板分享链接（P8）"""

    __tablename__ = "share_links"

    id: int | None = Field(default=None, primary_key=True)
    share_id: str = Field(index=True, unique=True)  # uuid4 hex[:8]，唯一
    tactic_data: str | None = None  # JSON 字符串：完整战术包
    created_at: str | None = None


class User(SQLModel, table=True):
    """用户表（P9 多人协同 — 匿名鉴权）"""

    __tablename__ = "users"

    id: int | None = Field(default=None, primary_key=True)
    anonymous_id: str = Field(unique=True)  # HMAC 签名 token，客户端 localStorage 生成
    nickname: str | None = None  # 昵称，可随时改
    created_at: str | None = None


class Room(SQLModel, table=True):
    """房间表（P9 多人协同）"""

    __tablename__ = "rooms"

    id: int | None = Field(default=None, primary_key=True)
    code: str = Field(max_length=6, index=True, unique=True)  # 6 位房间码 A-Z0-9
    name: str | None = None
    owner_id: int | None = Field(default=None, foreign_key="users.id")
    board_state: str | None = None  # JSON 字符串（标记/线快照）
    tactic_id: int | None = Field(default=None, foreign_key="tactics.id")
    is_active: bool = True
    created_at: str | None = None
    closed_at: str | None = None


class RoomMember(SQLModel, table=True):
    """房间成员记录表（P9 多人协同）"""

    __tablename__ = "room_members"

    id: int | None = Field(default=None, primary_key=True)
    room_id: int = Field(foreign_key="rooms.id")
    user_id: int = Field(foreign_key="users.id")
    joined_at: str | None = None
    left_at: str | None = None
