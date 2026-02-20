from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import load_config


class Base(DeclarativeBase):
    pass


_config = load_config()
_is_sqlite = _config.database_url.startswith("sqlite")
_connect_args = {"check_same_thread": False, "timeout": 30} if _is_sqlite else {}
engine = create_engine(_config.database_url, future=True, connect_args=_connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA synchronous=NORMAL;")
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.close()


def init_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    if _is_sqlite:
        _ensure_sqlite_runtime_schema()


def _ensure_sqlite_runtime_schema() -> None:
    index_statements = (
        "CREATE INDEX IF NOT EXISTS ix_transfer_requests_sender_principal_id ON transfer_requests (sender_principal_id)",
        "CREATE INDEX IF NOT EXISTS ix_transfer_requests_sender_client_device_id ON transfer_requests (sender_client_device_id)",
        "CREATE INDEX IF NOT EXISTS ix_transfer_requests_receiver_device_id ON transfer_requests (receiver_device_id)",
        "CREATE INDEX IF NOT EXISTS ix_transfer_requests_state ON transfer_requests (state)",
        "CREATE INDEX IF NOT EXISTS ix_transfer_requests_created_at ON transfer_requests (created_at)",
        "CREATE INDEX IF NOT EXISTS ix_transfer_items_transfer_request_id ON transfer_items (transfer_request_id)",
    )
    with engine.begin() as connection:
        columns = {
            str(row[1]).strip().lower()
            for row in connection.execute(text("PRAGMA table_info('transfer_requests')")).fetchall()
        }
        if "sender_client_device_id" not in columns:
            connection.execute(text("ALTER TABLE transfer_requests ADD COLUMN sender_client_device_id VARCHAR(36)"))

        for statement in index_statements:
            connection.execute(text(statement))


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
