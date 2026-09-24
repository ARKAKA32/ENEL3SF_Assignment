# Sentry — Emergency Incident Reporting Application

Built to match the group report's Architecture (Supabase + Node/Express
classification service) and Database Design (five-table schema) sections.

## 1. Create your Supabase project (2 minutes, free)

1. Go to https://supabase.com → sign up → "New project"
2. Once it's created, go to the **SQL Editor** and paste in the entire
   contents of `supabase/schema.sql`, then run it. This creates all five
   tables, the RLS policies, and enables realtime.
3. Go to **Project Settings → API**. You'll need two values:
   - **Project URL**
   - **anon / public key**
   - **service_role key** (keep this one secret — server only)

## 2. Configure the app

**Frontend** — edit `public/config.js`:
```js
window.SENTRY_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key',
};
```

**Backend** — copy `.env.example` to `.env` and fill in:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ANTHROPIC_API_KEY=            # optional — leave blank to use the keyword fallback
```

## 3. Create a staff account

Public sign-up isn't wired into the UI yet (civilians don't need
accounts — anonymous reporting is a core feature). To create an
operator/admin account for the dashboard:

1. In Supabase, go to **Authentication → Users → Add user**, create an
   account with an email + password.
2. In the **SQL Editor**, run:
   ```sql
   update public.users set role = 'admin' where email = 'your-email@example.com';
   ```
3. Log in via the "Staff login" button on the app's homepage.

## 4. Run it

```bash
npm install
npm start
```
Open http://localhost:3000 — this is the public reporting page.
Click "Staff login" to access the dispatch console.

## What changed from the earlier SQLite version

- Database is now PostgreSQL via Supabase, matching the report's ERD exactly
- Row-Level Security replaces manual access checks: civilians can insert
  but not read/update incidents; only operator/responder/admin roles can
  manage them
- Realtime dashboard updates now use Supabase's native WebSocket
  subscriptions instead of 15-second polling
- The public report form no longer collects a name/contact field — this
  matches the schema, since anonymous reports (`is_anon = true`) have no
  identifying data at all, and identified reports link to a real
  `reporter_id` via login instead

## Known gap to flag before this is "done"

The report's Acceptance Criteria for account registration (password
rules, login error handling) assumes civilians can create accounts
in-app. Right now, sign-up is only possible via the Supabase dashboard.
If your group wants that Acceptance Criteria fully met, the reporting
form needs a "create an account" option using `supabase.auth.signUp()`
— happy to add it, just say so.
