from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _new_id() -> str:
    return str(uuid4())


class Principal(Base):
    __tablename__ = "principals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    client_devices: Mapped[list["ClientDevice"]] = relationship(back_populates="principal")
    agent_devices: Mapped[list["AgentDevice"]] = relationship(back_populates="owner")


class ClientDevice(Base):
    __tablename__ = "client_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    principal_id: Mapped[str] = mapped_column(String(36), ForeignKey("principals.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(60), nullable=False)
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    device_secret_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    principal: Mapped[Principal] = relationship(back_populates="client_devices")


class PairingSession(Base):
    __tablename__ = "pairing_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    device_name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(60), nullable=False)
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    pairing_code: Mapped[str] = mapped_column(String(10), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    approved_by_principal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class AgentDevice(Base):
    __tablename__ = "agent_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    owner_principal_id: Mapped[str] = mapped_column(String(36), ForeignKey("principals.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    base_url: Mapped[str] = mapped_column(String(300), nullable=False)
    visibility: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    online_state: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    owner: Mapped[Principal] = relationship(back_populates="agent_devices")
    shares: Mapped[list["Share"]] = relationship(back_populates="agent_device", cascade="all,delete-orphan")


class Share(Base):
    __tablename__ = "shares"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    agent_device_id: Mapped[str] = mapped_column(String(36), ForeignKey("agent_devices.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    root_path: Mapped[str] = mapped_column(String(500), nullable=False)
    read_only: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    agent_device: Mapped[AgentDevice] = relationship(back_populates="shares")
    acl_grants: Mapped[list["AclGrant"]] = relationship(back_populates="share", cascade="all,delete-orphan")


class AclGrant(Base):
    __tablename__ = "acl_grants"
    __table_args__ = (UniqueConstraint("principal_id", "share_id", name="uq_acl_principal_share"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    principal_id: Mapped[str] = mapped_column(String(36), ForeignKey("principals.id"), nullable=False)
    share_id: Mapped[str] = mapped_column(String(36), ForeignKey("shares.id"), nullable=False)
    permissions_raw: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    share: Mapped[Share] = relationship(back_populates="acl_grants")


class TransferRequest(Base):
    __tablename__ = "transfer_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    sender_principal_id: Mapped[str] = mapped_column(String(36), ForeignKey("principals.id"), nullable=False)
    receiver_device_id: Mapped[str] = mapped_column(String(36), ForeignKey("agent_devices.id"), nullable=False)
    receiver_share_id: Mapped[str] = mapped_column(String(36), ForeignKey("shares.id"), nullable=False)
    state: Mapped[str] = mapped_column(String(40), default="pending_receiver_approval", nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    items: Mapped[list["TransferItem"]] = relationship(back_populates="transfer_request", cascade="all,delete-orphan")
    passcode_window: Mapped["PasscodeWindow | None"] = relationship(
        back_populates="transfer_request",
        cascade="all,delete-orphan",
        uselist=False,
    )


class TransferItem(Base):
    __tablename__ = "transfer_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    transfer_request_id: Mapped[str] = mapped_column(String(36), ForeignKey("transfer_requests.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str] = mapped_column(String(30), default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    transfer_request: Mapped[TransferRequest] = relationship(back_populates="items")


class PasscodeWindow(Base):
    __tablename__ = "passcode_windows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    transfer_request_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("transfer_requests.id"),
        nullable=False,
        unique=True,
    )
    passcode_hash: Mapped[str] = mapped_column(Text, nullable=False)
    attempts_left: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    failure_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_by_principal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    transfer_request: Mapped[TransferRequest] = relationship(back_populates="passcode_window")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    actor_principal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(80), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(60), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
