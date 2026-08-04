"""配置管理（P10）：环境变量集中读取（Pydantic Settings）

优先级：环境变量 > .env 文件 > 默认值。见 .env.example。
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    board_db_url: str = 'sqlite:///board.db'
    board_secret: str = 'dev-secret-change-me'
    log_level: str = 'INFO'

    class Config:
        env_file = '.env'


settings = Settings()
