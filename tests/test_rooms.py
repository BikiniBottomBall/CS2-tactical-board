"""房间 REST 测试（WebSocket 连接本身不在此覆盖）"""


def test_create_room(client, rooms_clean, auth_headers):
    r = client.post("/api/rooms", json={**auth_headers, "name": "测试房"})
    assert r.status_code == 200
    code = r.json()["code"]
    assert len(code) == 6
    assert code.isalnum()


def test_create_room_bad_auth(client, rooms_clean):
    r = client.post("/api/rooms", json={"anonymous_id": "x", "token": "wrong"})
    assert r.status_code == 401


def test_get_room(client, rooms_clean, auth_headers):
    code = client.post("/api/rooms", json=auth_headers).json()["code"]
    r = client.get(f"/api/rooms/{code}")
    assert r.status_code == 200
    assert r.json()["code"] == code
    assert r.json()["is_active"] is True


def test_get_room_not_found(client, rooms_clean):
    assert client.get("/api/rooms/ZZZZZZ").status_code == 404


def test_join_room(client, rooms_clean, auth_headers):
    code = client.post("/api/rooms", json=auth_headers).json()["code"]
    r = client.post(f"/api/rooms/{code}/join", json=auth_headers)
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_join_room_not_found(client, rooms_clean, auth_headers):
    r = client.post("/api/rooms/ZZZZZZ/join", json=auth_headers)
    assert r.status_code == 404


def test_close_room(client, rooms_clean, auth_headers):
    code = client.post("/api/rooms", json=auth_headers).json()["code"]
    r = client.request("DELETE", f"/api/rooms/{code}", json=auth_headers)
    assert r.status_code == 200
    assert client.get(f"/api/rooms/{code}").status_code == 404


def test_close_room_not_owner(client, rooms_clean, auth_headers):
    from auth import generate_token

    code = client.post("/api/rooms", json=auth_headers).json()["code"]
    other = {"anonymous_id": "someone-else", "token": generate_token("someone-else")}
    r = client.request("DELETE", f"/api/rooms/{code}", json=other)
    assert r.status_code == 403
