"""Config flow for OpenClaw integration."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries

from .const import DOMAIN, CONF_OPENCLAW_URL, CONF_OPENCLAW_TOKEN


class OpenClawConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for OpenClaw."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step — configure OpenClaw connection."""
        errors: dict[str, str] = {}

        if user_input is not None:
            # Test connection to OpenClaw plugin
            try:
                async with aiohttp.ClientSession() as session:
                    headers = {}
                    token = user_input.get(CONF_OPENCLAW_TOKEN)
                    if token:
                        headers["Authorization"] = f"Bearer {token}"

                    url = user_input[CONF_OPENCLAW_URL].rstrip("/")
                    async with session.get(
                        f"{url}/ha/ping",
                        headers=headers,
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status != 200:
                            errors["base"] = "cannot_connect"
                        else:
                            data = await resp.json()
                            if not data.get("ok"):
                                errors["base"] = "cannot_connect"
            except aiohttp.ClientError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                errors["base"] = "unknown"

            if not errors:
                return self.async_create_entry(
                    title="OpenClaw",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_OPENCLAW_URL,
                        default="http://localhost:3000",
                    ): str,
                    vol.Optional(CONF_OPENCLAW_TOKEN): str,
                }
            ),
            errors=errors,
        )
