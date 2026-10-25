# Put Gridiron online (free) so friends can join from their own devices

The GitHub Pages site keeps leagues inside each browser. The online version runs one shared
server and database, so invite codes work from any phone or computer, and scores update live
during games. Free hosting: **Render** runs the app, **Neon** stores the data.

## 1. Database (Neon), about 3 minutes
1. Go to **neon.tech** → **Sign up** (use "Continue with GitHub").
2. Create a project: name `gridiron`, any region close to you (e.g. Frankfurt), Postgres 17. Click **Create**.
3. On the project dashboard click **Connect**, and copy the **connection string**.
   It looks like `postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require&channel_binding=require`.
   Keep it private: it is the password to your data.

## 2. App (Render), about 5 minutes plus a build
1. Go to **render.com** → **Get started** → sign up with **GitHub**.
2. Click **New** → **Blueprint**, connect GitHub if asked, and pick the **gridiron-fantasy** repository.
3. Render reads `render.yaml` and shows one service, `gridiron-fantasy` (Free). It asks for
   **DATABASE_URL**: paste the Neon connection string. Click **Apply** / **Deploy Blueprint**.
4. The first build takes 5–10 minutes. When the service shows **Live**, its address is at the top,
   e.g. `https://gridiron-fantasy.onrender.com`. Open it, create your account, and share the address
   with friends. Invite codes now work for everyone.

## 3. Keep it awake (optional, recommended)
Free Render servers sleep after 15 minutes without visitors (the next visit then takes about a
minute, and draft timers, waivers and live scoring pause meanwhile). To keep it awake:
GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab →
**New repository variable**: name `SERVER_URL`, value your Render address (no trailing slash).
The `Keep server awake` workflow then pings it every 10 minutes.

## Updates
Every push to `main` redeploys the online version automatically (and republishes the Pages site).
Accounts and leagues live in Neon and survive redeploys.

## Notes
- Real NFL data comes from nflverse (after games) plus Sleeper (live in-game stats, unofficial).
- Password-reset emails need a mail service (`RESEND_API_KEY`, optional). Without it, ask the
  league commissioner or recreate the account.
- Neon's free plan includes 0.5 GB of storage, plenty for many leagues.
