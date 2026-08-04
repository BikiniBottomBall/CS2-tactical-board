"""道具库 CRUD 测试"""


def _smoke(name="A大烟"):
    return {
        "name": name,
        "type": "smoke",
        "throw_type": "站投",
        "stand_x": 1.0,
        "stand_y": 2.0,
        "stand_z": 3.0,
        "landing_x": 4.0,
        "landing_y": 5.0,
        "landing_z": 6.0,
    }


def test_list_utilities_empty(client):
    r = client.get("/api/utilities")
    assert r.status_code == 200
    assert r.json() == []


def test_create_utility(client):
    r = client.post("/api/utilities", json=_smoke())
    assert r.status_code == 200
    data = r.json()
    assert data["id"] > 0
    assert data["name"] == "A大烟"
    assert data["created_at"]


def test_create_utility_no_name(client):
    r = client.post("/api/utilities", json={"type": "smoke"})
    assert r.status_code == 422  # Pydantic 校验


def test_update_utility(client):
    uid = client.post("/api/utilities", json=_smoke()).json()["id"]
    r = client.put(f"/api/utilities/{uid}", json=_smoke("A大烟·改"))
    assert r.status_code == 200
    assert r.json()["name"] == "A大烟·改"


def test_update_not_found(client):
    r = client.put("/api/utilities/9999", json=_smoke())
    assert r.status_code == 404


def test_delete_utility(client):
    uid = client.post("/api/utilities", json=_smoke()).json()["id"]
    r = client.delete(f"/api/utilities/{uid}")
    assert r.status_code == 200
    assert client.get("/api/utilities").json() == []


def test_delete_not_found(client):
    assert client.delete("/api/utilities/9999").status_code == 404
