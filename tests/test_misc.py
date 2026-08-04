"""整库备份 / demo 列表 / 对齐图导出 测试"""


def test_export_import_roundtrip(client):
    client.post("/api/utilities", json={"name": "A大烟", "type": "smoke"})
    client.post("/api/tactics", json={"name": "T1"})
    out = client.get("/api/export").json()
    assert len(out["utilities"]) == 1
    assert len(out["tactics"]) == 1
    assert out["annotations"] == {}

    # 清空后导入恢复
    client.post("/api/import", json={"utilities": [], "tactics": [], "tactic_steps": []})
    assert client.get("/api/utilities").json() == []
    r = client.post("/api/import", json=out)
    assert r.status_code == 200
    assert len(client.get("/api/utilities").json()) == 1


def test_demos_empty_and_404(client):
    assert client.get("/api/demos").json() == []
    assert client.delete("/api/demos/9999").status_code == 404
    assert client.get("/api/demos/9999/pack").status_code == 404


def test_export_align(client, tmp_path, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "ROOT", str(tmp_path))
    r = client.post("/api/export-align", content=b"\x89PNG\r\n\x1a\nfake")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert (tmp_path / "check_align.png").read_bytes() == b"\x89PNG\r\n\x1a\nfake"


def test_export_align_empty(client):
    r = client.post("/api/export-align")
    assert r.status_code == 400
