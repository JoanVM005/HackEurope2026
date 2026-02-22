from __future__ import annotations

import logging
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    supabase_url: str = Field(..., alias="SUPABASE_URL")
    supabase_key: str = Field(..., alias="SUPABASE_KEY")
    openai_api_key: str = Field(..., alias="OPENAI_API_KEY")

    openai_model: str = Field(default="gpt-4o-mini", alias="OPENAI_MODEL")
    mem0_api_key: str | None = Field(default=None, alias="MEM0_API_KEY")
    mem0_project_id: str | None = Field(default=None, alias="MEM0_PROJECT_ID")
    mem0_org_id: str | None = Field(default=None, alias="MEM0_ORG_ID")
    default_doctor_id: str = Field(default="demo-doctor", alias="DEFAULT_DOCTOR_ID")
    env: str = Field(default="dev", alias="ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    cors_allow_origins: str | None = Field(default=None, alias="CORS_ALLOW_ORIGINS")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
