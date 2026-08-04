"""分享链接测试"""


def test_create_share(client):
    r = client.post("/api/share", json={"tactic_data": {"format": "cs2-tactic-pack", "version": 1}})
    assert r.status_code == 200
    sid = r.json()["share_id"]
    assert len(sid) == 8
    int(sid, 16)  # hex


def test_get_share(client):
    payload = {"format": "cs2-tactic-pack", "version": 1, "tactic": {"name": "T"}}
    sid = client.post("/api/share", json={"tactic_data": payload}).json()["share_id"]
    r = client.get(f"/api/share/{sid}")
    assert r.status_code == 200
    assert r.json()["tactic"]["name"] == "T"


def test_get_share_not_found(client):
    assert client.get("/api/share/deadbeef").status_code == 404
