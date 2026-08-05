"""点位标注 CRUD 测试"""


def test_annotations_crud(client):
    # 初始为空
    r = client.get("/api/annotations")
    assert r.status_code == 200
    assert r.json() == []

    # 创建
    body = {"name": "A大", "type": "point", "x": 1232.0, "y": 1616.0, "z": 128.0, "color": "#ff5252"}
    r = client.post("/api/annotations", json=body)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "A大"
    assert data["x"] == 1232.0
    assert data["y"] == 1616.0
    assert data["z"] == 128.0
    assert data["color"] == "#ff5252"

    # 重名冲突
    r = client.post("/api/annotations", json=body)
    assert r.status_code == 409

    # 列表
    r = client.get("/api/annotations")
    assert len(r.json()) == 1

    # 更新（只更新 color/y）
    r = client.put("/api/annotations/A大", json={"color": "#5aa9ff", "y": 1700.0})
    assert r.status_code == 200
    up = r.json()
    assert up["color"] == "#5aa9ff"
    assert up["y"] == 1700.0
    assert up["x"] == 1232.0

    # 更新不存在的标注
    r = client.put("/api/annotations/不存在", json={"color": "#fff"})
    assert r.status_code == 404

    # 删除
    r = client.delete("/api/annotations/A大")
    assert r.status_code == 200
    assert client.get("/api/annotations").json() == []

    # 删除不存在的标注
    assert client.delete("/api/annotations/不存在").status_code == 404


def test_annotation_points_roundtrip(client):
    body = {"name": "区域", "type": "region", "points": [[-50.0, 20.0], [30.0, -10.0]]}
    r = client.post("/api/annotations", json=body)
    assert r.status_code == 201
    assert r.json()["points"] == [[-50.0, 20.0], [30.0, -10.0]]
