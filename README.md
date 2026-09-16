# DailyEarn NG

A Render-ready Node.js + PostgreSQL daily rewards platform.

## Features
- 20 daily task slots
- ₦50 reward per task
- 24-hour cycle reset
- Referral code system (referral reward logic is ready to be extended to the provider's definition of an eligible referral)
- Monthly withdrawal requests
- User dashboard
- Admin dashboard
- PostgreSQL persistence
- Rewarded-ad URL configuration

## Important advertising integration
Do not use an ordinary ad network's display/click inventory as a paid-to-click or paid-to-view scheme unless its terms explicitly permit incentivized traffic. Set `REWARDED_AD_URL` only to a provider/offer that permits rewarded tasks.

The demo currently credits a task after the user confirms completion. For production, replace that confirmation with the ad/offer provider's server-to-server callback or signed completion event so users cannot self-credit rewards.

## Render
1. Push the project to GitHub.
2. Create a Render Blueprint from `render.yaml`, or create a Node web service and PostgreSQL database.
3. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `SESSION_SECRET`.
4. Set `REWARDED_AD_URL` to your compliant rewarded-ad/offer URL.
5. Deploy.

## Admin
Visit `/admin/login`.
