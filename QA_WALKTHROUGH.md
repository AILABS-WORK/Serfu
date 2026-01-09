# QA Walkthrough

## 1. Setup
1. Copy `env.sample` to `.env`. Fill in `BOT_TOKEN` and `HELIUS_API_KEY`.
2. Ensure Postgres is running.
3. Run `npx prisma migrate dev --name init`.
4. Run `npm run dev`.

## 2. Bot Integration
1. Open Telegram and find your bot.
2. Ensure Privacy Mode is OFF in BotFather (Send `/setprivacy` -> Disable).
3. Add the bot to a group.

## 3. Signal Detection Test
1. In the group, post a message mimicking a signal:
   ```
   LFG guys buy this gem
   7xKXtg2CSqK3tS9vFk7wFk7wFk7wFk7wFk7wFk7wFk7w
   ```
   (Replace the mint with a valid Solana mint, e.g., BONK: `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`)
2. Verify the bot replies with a **Signal Card** containing:
   - Token Name/Symbol (fetched from Helius/RPC)
   - Entry Price
   - Buttons (Chart, Stats)

## 4. Sampling Test
1. Wait 1-2 minutes.
2. Check logs: "Starting sampling cycle...".
3. Verify it logs "Sampling 1 signals...".
4. Check database `price_samples` table to see new rows.

## 5. Analytics & Charts
1. Click the **Stats** button on the signal card. Verify text response.
2. Click the **Chart** button. Verify it sends a PNG line chart.

## 6. Threshold Alert (Simulation)
1. To test thresholds, you can manually update the `entry_price` in DB to be 50% of current price (so it's 2x).
   ```sql
   UPDATE signals SET entry_price = current_price / 2.1 WHERE id = 1;
   ```
2. Wait for next sampling cycle (1 min).
3. Verify bot posts "🚀 2x HIT!".

## 7. Aggregation
1. Wait for hourly cycle or trigger manually.
2. Send `/leaderboard` (if implemented, check menu).

## 8. Final Check
- Check logs for any errors.




