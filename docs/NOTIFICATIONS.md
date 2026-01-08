# Notification System

## Overview

The bot now includes a comprehensive notification system for price alerts and signal events.

## Features

### 1. Price Threshold Alerts

Get notified when signals reach specific price multiples:

- **2x, 3x, 4x, 5x** - Enabled by default
- **10x** - Enabled by default
- **15x, 20x, 30x, 50x, 100x** - Disabled by default (can be enabled)

Alerts are calculated based on the entry price when the signal was detected.

### 2. Event Alerts

- **DEX Payment** - Alert when a DEX payment is detected
- **Bonding** - Alert when a token is bonding
- **Migrating** - Alert when a token is migrating
- **New Signal** - Alert when a new signal is detected (enabled by default)

### 3. Notification Channels

Choose where to receive notifications:

- **In Group** - Send alerts to the source/destination group (default: ON)
- **In DM** - Send alerts directly to you (default: OFF)
- **Destination Groups** - Forward alerts to your destination groups (default: ON)

## How It Works

1. **Price Monitoring**: The bot continuously monitors all active signals
2. **Threshold Detection**: When a signal reaches a configured threshold, an alert is sent
3. **Duplicate Prevention**: Each alert is sent only once per threshold
4. **User Preferences**: Each user can customize which alerts they receive

## Configuration

Notification settings are created automatically when you first interact with the bot. Defaults are:
- Price alerts: 2x-10x enabled
- Event alerts: All enabled
- Channels: Group and destination enabled, DM disabled

## Future Enhancements

- Custom threshold values
- Alert frequency limits
- Alert grouping/batching
- Webhook notifications
- Email notifications

---

**Last Updated**: January 2025

