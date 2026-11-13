# Telegram Bot

## Setup

1. Create a bot with BotFather.
2. In **Notifications and Telegram**, add the bot token and numeric Telegram user IDs, then enable the bot. Deployments can supply `QB_TELEGRAM_TOKEN_FILE`.
3. Each authorized user opens a private conversation with the bot and sends `/start`. The bot responds only to authorized private chats.
4. Set notification severity, categories, minimum interval, and quiet hours. Use the Web console to check connection status and history.

An environment-provided token takes precedence. The token saved from the Web console is kept in the private database and read by the service to send messages. Agent Bearer credentials are separate.

## Navigation and commands

| Command | Purpose |
|---|---|
| `/menu`, `/use`, `/status` | Browse and select strategies. Inspect connections, entry permissions, risk locks, and reported data. |
| `/positions`, `/orders`, `/chart` | View strategy and broker positions, orders, and equity history. |
| `/events`, `/alerts [category]` | View recent events and alerts. |
| `/controls` | Open dynamic controls in their declared group and order. |
| `/pause`, `/resume` | Request a pause or resume of new entries. |
| `/refresh`, `/action <ID> name=value` | Invoke a declared refresh or business action. |
| `/flatten`, `/cancel`, `/close`, `/set`, `/buy`, `/sell` | Invoke declared session capabilities. |
| `/operations` | View command state and receipts or cancel eligible requests. |
| `/notifications on`, `/notifications off` | View or change notification delivery. |
| `/web`, `/quickstart` | Get a one-time login link or HTTP integration instructions. |

The strategy list can pause new entries for all capable strategies. One-time actions bound to dynamic controls run from the control panel. Control buttons are bound to the current user, strategy, and registry revision and expire after three minutes. Follow prompts to fill values or forms. Go back or cancel before submitting. High-risk operations require confirmation before a permit can be claimed.

Delivery, execution, actual receipt, unknown outcome, and expiration have separate states. Both consoles display the strategy's reported values. Administrators can reconcile unknown outcomes with evidence in the Web console.

## Notifications

Connection changes, fills, trade exceptions, risk events, authorization expiry, important custom events, and command outcomes can enter the notification queue. Strategy alert rules and Telegram filters control delivery. Deduplication merges repeated keys within the window. Network failures retry with backoff. Error and critical notifications remain audible during quiet hours. Recipient progress persists across restarts.
