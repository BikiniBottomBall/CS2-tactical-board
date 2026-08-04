"""战术 CRUD + 战术包导出/导入测试"""


def _create(client, name="A 大强攻"):
    return client.post("/api/tactics", json={"name": name}).json()


def test_create_tactic(client):
    r = client.post("/api/tactics", json={"name": "A 大强攻"})
    assert r.status_code == 200
    data = r.json()
    assert data["id"] > 0
    assert data["steps"] == []


def test_create_tactic_no_name(client):
    r = client.post("/api/tactics", json={"description": "no name"})
    assert r.status_code == 422


def test_update_tactic_with_steps(client):
    tid = _create(client)["id"]
    body = {
        "name": "A 大强攻 v2",
        "steps": [
            {
                "step_order": 0,
                "note": "出匪家",
                "duration": 3.0,
                "actors": [{"id": "T1", "x": 1, "y": 2, "z": 3}],
            },
            {"step_order": 1, "note": "烟闪掩护", "utility_ids": [], "duration": 2.0},
        ],
    }
    r = client.put(f"/api/tactics/{tid}", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "A 大强攻 v2"
    assert len(data["steps"]) == 2
    assert data["steps"][0]["actors"][0]["id"] == "T1"


def test_update_tactic_not_found(client):
    assert client.put("/api/tactics/9999", json={"name": "x"}).status_code == 404


def test_export_tactic_pack(client):
    tid = _create(client)["id"]
    client.put(f"/api/tactics/{tid}", json={"steps": [{"step_order": 0, "note": "s1"}]})
    r = client.get(f"/api/tactics/{tid}/pack")
    assert r.status_code == 200
    pack = r.json()
    assert pack["format"] == "cs2-tactic-pack"
    assert pack["version"] == 1
    assert pack["tactic"]["name"] == "A 大强攻"
    assert len(pack["steps"]) == 1


def test_import_tactic_pack_dedup_and_rename(client):
    # 往返测试：建道具+战术 → 导出包 → 导入 → 道具去重、战术重名加后缀、utility_ids 重映射
    util = client.post(
        "/api/utilities",
        json={
            "name": "A大烟",
            "type": "smoke",
            "throw_type": "站投",
            "stand_x": 1.0,
            "stand_y": 2.0,
            "stand_z": 3.0,
            "landing_x": 4.0,
            "landing_y": 5.0,
            "landing_z": 6.0,
        },
    ).json()
    tid = _create(client)["id"]
    client.put(
        f"/api/tactics/{tid}",
        json={
            "steps": [{"step_order": 0, "utility_ids": [util["id"]], "note": "用烟"}],
        },
    )
    pack = client.get(f"/api/tactics/{tid}/pack").json()

    r = client.post("/api/tactics/import", json=pack)
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "A 大强攻(2)"  # 重名加后缀
    assert data["steps"][0]["utility_ids"] == [util["id"]]  # 去重后重映射到已有道具
    assert len(client.get("/api/utilities").json()) == 1  # 道具未重复创建


def test_import_tactic_pack_bad_format(client):
    r = client.post("/api/tactics/import", json={"format": "nope"})
    assert r.status_code == 400


def test_delete_tactic(client):
    tid = _create(client)["id"]
    client.put(f"/api/tactics/{tid}", json={"steps": [{"step_order": 0}]})
    r = client.delete(f"/api/tactics/{tid}")
    assert r.status_code == 200
    assert client.get("/api/tactics").json() == []
