"""OpenClaw conversation agent for Home Assistant."""
from __future__ import annotations

import logging
from typing import Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    intent,
)
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_OPENCLAW_URL, CONF_OPENCLAW_TOKEN, DOMAIN

_LOGGER = logging.getLogger(__name__)

MATCH_ALL = "*"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up OpenClaw conversation entity."""
    async_add_entities([OpenClawConversationEntity(hass, config_entry)])


class OpenClawConversationEntity(conversation.ConversationEntity):
    """OpenClaw AI conversation agent."""

    _attr_has_entity_name = True
    _attr_name = "OpenClaw"
    _attr_supports_streaming = False  # v0.1 — add streaming later

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialise."""
        self.hass = hass
        self.entry = entry
        self._openclaw_url = entry.data[CONF_OPENCLAW_URL]
        self._openclaw_token = entry.data.get(CONF_OPENCLAW_TOKEN)
        self._attr_unique_id = f"{entry.entry_id}_conversation"

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Support all languages — OpenClaw handles translation."""
        return MATCH_ALL

    async def async_added_to_hass(self) -> None:
        """Register as conversation agent when added."""
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_will_remove_from_hass(self) -> None:
        """Unregister as conversation agent when removed."""
        conversation.async_unset_agent(self.hass, self.entry)
        await super().async_will_remove_from_hass()

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Forward conversation to OpenClaw and return response."""

        # Resolve area from the voice satellite's device
        area_id = None
        area_name = None
        if user_input.device_id:
            dev_reg = dr.async_get(self.hass)
            device = dev_reg.async_get(user_input.device_id)
            if device and device.area_id:
                area_id = device.area_id
                area_reg = ar.async_get(self.hass)
                area = area_reg.async_get_area(device.area_id)
                area_name = area.name if area else None

        # Build payload for the OpenClaw plugin
        payload = {
            "text": user_input.text,
            "conversation_id": user_input.conversation_id,
            "device_id": user_input.device_id,
            "satellite_id": getattr(user_input, "satellite_id", None),
            "area_id": area_id,
            "area_name": area_name,
            "language": user_input.language,
        }

        # Forward to OpenClaw
        try:
            async with aiohttp.ClientSession() as session:
                headers = {"Content-Type": "application/json"}
                if self._openclaw_token:
                    headers["Authorization"] = f"Bearer {self._openclaw_token}"

                async with session.post(
                    f"{self._openclaw_url.rstrip('/')}/ha/conversation",
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        raise Exception(
                            f"OpenClaw returned {resp.status}: {error_text}"
                        )
                    result = await resp.json()

        except aiohttp.ClientError as err:
            _LOGGER.error("Network error communicating with OpenClaw: %s", err)
            return self._error_response(
                user_input, "Sorry, I can't reach OpenClaw right now."
            )
        except Exception as err:
            _LOGGER.error("Error communicating with OpenClaw: %s", err)
            return self._error_response(
                user_input, "Sorry, something went wrong."
            )

        # Build HA response from OpenClaw's reply
        intent_response = intent.IntentResponse(language=user_input.language)
        intent_response.async_set_speech(result.get("text", ""))

        return conversation.ConversationResult(
            response=intent_response,
            conversation_id=result.get(
                "conversation_id", user_input.conversation_id
            ),
            continue_conversation=result.get("continue_conversation", False),
        )

    @staticmethod
    def _error_response(
        user_input: conversation.ConversationInput, message: str
    ) -> conversation.ConversationResult:
        """Build an error response."""
        intent_response = intent.IntentResponse(language=user_input.language)
        intent_response.async_set_error(
            intent.IntentResponseErrorCode.UNKNOWN, message
        )
        return conversation.ConversationResult(
            response=intent_response,
            conversation_id=user_input.conversation_id,
        )
