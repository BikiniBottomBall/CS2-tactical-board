"""API 契约（P10）：所有 endpoint 的 Pydantic Request/Response 模型

与 app.py 一一对应；复杂嵌套（战术步骤 PUT、战术包导入）仍保留 dict 接收。
"""

from typing import Any

from pydantic import BaseModel


class UtilityBase(BaseModel):
    name: str
    type: str | None = None
    landing_point: str | None = None
    throw_type: str | None = None
    trajectory: str | None = None
    animation: str | None = None
    stand_x: float | None = None
    stand_y: float | None = None
    stand_z: float | None = None
    landing_x: float | None = None
    landing_y: float | None = None
    landing_z: float | None = None


class UtilityCreate(UtilityBase):
    pass


class UtilityOut(UtilityBase):
    id: int
    created_at: str | None = None


class TacticCreate(BaseModel):
    name: str
    description: str | None = None


class TacticStepBase(BaseModel):
    step_order: int
    annotation: str | None = None
    utility_id: int | None = None
    note: str | None = None
    actors: list[dict[str, Any]] | None = None
    utility_ids: list[int] | None = None
    duration: float = 2.0


class TacticStepOut(TacticStepBase):
    id: int


class TacticOut(BaseModel):
    id: int
    name: str
    description: str | None = None
    created_at: str | None = None
    steps: list[TacticStepOut] = []


class MatchOut(BaseModel):
    id: int
    name: str
    map: str | None = None
    duration_s: float | None = None
    file_raw: str | None = None
    file_parsed: str | None = None
    created_at: str | None = None


class ShareCreate(BaseModel):
    tactic_data: dict[str, Any]


class ShareOut(BaseModel):
    share_id: str


class RoomCreate(BaseModel):
    anonymous_id: str
    token: str
    name: str | None = ""
    nickname: str | None = ""


class RoomJoin(BaseModel):
    anonymous_id: str
    token: str
    nickname: str | None = ""


class RoomClose(BaseModel):
    anonymous_id: str
    token: str
