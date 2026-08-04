"""匿名鉴权测试"""

from auth import generate_token, get_or_create_user, validate_connection, verify_token


def test_generate_token():
    token = generate_token("user-abc")
    assert len(token) == 32
    int(token, 16)
    # 同输入同输出（确定性 HMAC）
    assert token == generate_token("user-abc")
    assert token != generate_token("user-abd")


def test_validate_connection():
    uid = "user-xyz"
    assert validate_connection(uid, generate_token(uid)) is True
    assert validate_connection(uid, "wrong-token") is False
    assert validate_connection("", "") is False


def test_verify_token_format():
    assert verify_token(generate_token("u")) is not None
    assert verify_token("xyz") is None
    assert verify_token("") is None


def test_get_or_create_user_idempotent(client):
    # client fixture 已 patch auth.engine 到内存库
    u1 = get_or_create_user("anon-1", "小明")
    u2 = get_or_create_user("anon-1")
    assert u1.anonymous_id == u2.anonymous_id == "anon-1"
    # 昵称更新
    u3 = get_or_create_user("anon-1", "小红")
    assert u3.nickname == "小红"
