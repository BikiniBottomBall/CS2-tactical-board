FROM python:3.12-slim

WORKDIR /app

# 安装系统依赖（psycopg2 需要 libpq-dev）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 项目代码（排除 .git .venv node_modules）
COPY app.py server.py models.py ./
COPY alembic/ ./alembic/
COPY alembic.ini .
COPY auth.py room_manager.py op_handler.py ./
COPY tools/ ./tools/
COPY libs/ ./libs/
COPY data/models/ ./data/models/

# 前端构建产物
COPY web/dist/ ./web/dist/

# 数据库迁移 + 启动
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
