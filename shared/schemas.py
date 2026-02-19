from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class PairingStartRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    device_name: str = Field(min_length=1, max_length=120)
    platform: str = Field(min_length=1, max_length=60)
    public_key: str | None = Field(default=None, max_length=4096)


class PairingStartResponse(BaseModel):
    bootstrap: bool = False
    principal_id: str | None = None
    client_device_id: str | None = None
    access_token: str | None = None
    device_secret: str | None = None
    pending_pairing_id: str | None = None
    pairing_code: str | None = None
    expires_at: datetime | None = None


class PairingConfirmRequest(BaseModel):
    pending_pairing_id: str
    pairing_code: str = Field(min_length=4, max_length=10)


class AuthTokenRequest(BaseModel):
    principal_id: str
    client_device_id: str
    device_secret: str = Field(min_length=8, max_length=256)


class AuthTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    principal_id: str
    client_device_id: str


class EventsWsTokenResponse(BaseModel):
    ws_token: str
    expires_in: int


class TransferItemInput(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)
    sha256: str = Field(min_length=64, max_length=64)
    mime_type: str | None = Field(default=None, max_length=120)


class TransferCreateRequest(BaseModel):
    receiver_device_id: str
    receiver_share_id: str
    items: list[TransferItemInput] = Field(min_length=1, max_length=50)


class TransferApproveRequest(BaseModel):
    passcode: str = Field(pattern=r"^\d{4}$")


class TransferRejectRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class PasscodeOpenRequest(BaseModel):
    passcode: str = Field(pattern=r"^\d{4}$")


class VisibilityRequest(BaseModel):
    visible: bool
