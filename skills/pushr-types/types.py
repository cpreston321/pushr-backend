"""pushr HTTP API types for Python 3.9+. Reference: https://pushr.sh/llms-full.txt"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

# 1-3 passive, 4-6 normal (default), 7-10 time-sensitive.
Priority = Union[Literal["low", "normal", "default", "high"], int]


class OpenUrlAction(TypedDict, total=False):
    kind: Literal["open_url"]
    id: str
    label: str
    url: str
    destructive: bool


class CallbackAction(TypedDict, total=False):
    kind: Literal["callback"]
    id: str
    label: str
    callbackUrl: str  # public https:// only
    destructive: bool
    authRequired: bool


class ReplyAction(TypedDict, total=False):
    kind: Literal["reply"]
    id: str
    label: str
    callbackUrl: str
    placeholder: str


Action = Union[OpenUrlAction, CallbackAction, ReplyAction]


class AckConfig(TypedDict):
    timeoutSec: int  # 10-86400
    maxAttempts: int  # 1-20 re-pushes after the first send


class LiveActivityState(TypedDict, total=False):
    title: str
    status: str
    progress: float  # 0-1
    icon: str  # SF Symbol name
    outcome: Literal["success", "failure"]  # on end


class LiveActivityPayload(TypedDict, total=False):
    action: Literal["start", "update", "end"]  # required
    activityId: str  # required
    state: LiveActivityState  # required on every action
    attributes: Dict[str, str]  # start only: name, logoUrl
    staleDate: int  # ms since epoch
    relevanceScore: float  # 0-1
    dismissAfter: int  # on end: seconds a finished activity stays, 0-14400


class NotifyInput(TypedDict, total=False):
    title: str  # required
    body: str  # required
    priority: Priority
    url: str
    image: str
    data: Dict[str, Any]
    actions: List[Action]  # at most 4
    ack: AckConfig
    liveActivity: LiveActivityPayload
    deliverAt: int  # ms since epoch; must be a number
    replaceKey: str  # <= 128 chars; a newer push with the same key replaces this one
    critical: bool  # rings through mute where the app allows critical alerts


class NotifyResponse(TypedDict):
    id: str
    scheduledFor: Optional[int]


class HeartbeatResponse(TypedDict):
    ok: bool
    name: str
    status: Literal["up", "down", "paused"]
    everySec: int
    graceSec: int
    dueAt: Optional[int]  # ms since epoch; None while down or paused


class UptimeCheckInput(TypedDict, total=False):
    url: str  # required
    every: Union[str, int]  # required: "1m".."1h" or seconds
    method: Literal["GET", "HEAD"]
    keyword: str
    timeout: int  # seconds, 1-30
    confirmAfter: int  # 1-5


class ActionCallbackPayload(TypedDict, total=False):
    notificationId: str
    actionId: str
    respondedAt: int
    reply: str  # kind="reply" only
