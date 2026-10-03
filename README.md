# Sentry — Increment 2

Emergency incident reporting with Supabase Auth/Postgres/Storage/Realtime and a Node/Express server. `supabase/schema.sql` is the application schema; reconciling the report's ERD is deferred.

## Included

- Anonymous reporting and email/password civilian registration/login.
- Manual address/landmark entry, optional manual coordinates, and GPS capture. Coordinates of zero are valid. Text locations are preserved without claiming to geocode them.
- PNG/JPEG attachments during submission (including anonymous submission) and additional attachments by the identified reporter or staff. Up to five images per upload, 5 MB each. Images are private, with ten-minute signed viewing URLs.
- My reports with public incident history, live updates and active public broadcasts.
- Browser push opt-in for broadcasts and updates to the user's identified reports. Sign-out removes this device's subscription. Notifications about private reports contain no description/location/staff notes.
- Admin-only named assignment to active operators/responders/admins. Staff can edit status, severity and category. Database enforcement complements the UI controls.
- Atomic edits and audit events, a stale-edit conflict check, private notes by default, and optional notes visible to the reporter.
- Capitalised severity labels; timeline headings such as **STATUS CHANGED**.
- An accessible dashboard button opening a blank incident-map window for the next increment.
- Search, category/severity filters, counters for the whole queue, rate limiting, checked errors, and a periodic refresh fallback.

## Upgrade an existing Supabase project

1. Review and run **only** `supabase/migrations/002_increment2.sql` in Supabase's SQL Editor. Do not rerun the complete schema on existing tables. The migration is transactional and repeatable, preserves incident data, adds `location_text` and `is_public`, creates private image storage and push subscriptions, and replaces the five application tables' old access policies.
2. Deploy the frontend and server together. The previous frontend inserted directly into Supabase; this increment submits through the server. The migration intentionally revokes client write access to incidents/history/media/notifications. Reads and Realtime remain controlled by RLS. Staff edits use the authenticated `save_incident_update` function, which writes the incident and timeline in one transaction.
3. Existing notes remain staff-only (`is_public=false`). New status/category/severity changes are public to the identified reporter. New notes are public only when staff explicitly choose that option. Assignment history stays private.
4. The `incident-media` bucket is private and is managed through the server. `incident_media.file_url` stores an object path, not a permanent public URL. This implementation assumes the original repository schema and no additional Storage policies; inspect any locally added Storage policies before deployment. Legacy external/public file URLs are displayed as unavailable until migrated into the private bucket.

For a **new** project, run all of `supabase/schema.sql` instead; it includes Increment 2. No production records are created automatically. `supabase/demo_seed.sql` is optional fictional demo data for a development project.

## Configure and run

Node.js 22 or newer is recommended.

```bash
npm ci
cp .env.example .env
npm start
```

On Windows, use `Copy-Item .env.example .env`. Fill in these server variables:

- `SUPABASE_URL`: your project URL.
- `SUPABASE_ANON_KEY`: public/anon key (needed for authenticated database RPC calls).
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key for validated submissions, attachments and subscription management. Never put this in frontend code, commit it, or send it in chat.
- `ANTHROPIC_API_KEY`: optional; the keyword fallback works without it. AI requests time out after ten seconds and fall back.

Set the project URL and public key in `public/config.js` as well. The repository already contains a public project configuration; verify it matches the server. The frontend SDK is served locally from the installed dependency, so it does not depend on a CDN script.

Open http://localhost:3000. Static pages can load without credentials, but API writes report a clear configuration error until the server is configured. `/api/health` reports database/AI/push configuration availability, not a successful connection test.

If deploying behind a reverse proxy, set `TRUST_PROXY` to the actual number of trusted proxy hops so rate limits identify the caller correctly. Serve over HTTPS. Start the server as a persistent Node service and restart it after changing environment variables.

## Authentication and staff accounts

In Supabase Authentication, enable email/password signup and configure the Site URL and allowed redirect URL for your app (include `http://localhost:3000` during development). If email confirmation is enabled, the UI asks new users to confirm their email before login. Supabase supplies password storage and authentication; `public.users` stores profiles and roles.

Match the UI's password requirement in Supabase Auth settings: at least eight characters with a letter, number and symbol. The browser's validation is guidance; the Auth provider must enforce the rule too.

Create staff accounts through Supabase Authentication, or register them normally and promote them using the SQL Editor:

```sql
update public.users set role = 'admin' where email = 'your-admin@example.com';
update public.users set role = 'responder' where email = 'your-responder@example.com';
```

Only promote trusted accounts. Signup metadata cannot select a staff role. Suspended/disabled accounts cannot use staff APIs or read incident data through RLS. The migration backfills profiles for Auth users with no profile and preserves existing roles. Create at least one admin and one responder to demonstrate named assignment.

## Browser push setup

Generate one VAPID keypair locally after installing dependencies:

```bash
npx web-push generate-vapid-keys
```

Copy the values into the ignored `.env` file as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Set `VAPID_SUBJECT` to a real contact such as `mailto:project-contact@example.com`. Restart the server. Keep the private key server-only and retain the same keypair across deployments; rotating it requires devices to resubscribe.

Log in, open **Report / My account** if you are staff, and click **Enable push notifications**. The user must allow the browser permission prompt. Push uses a service worker and requires HTTPS, except on localhost. Browser/OS settings can suppress delivery; iOS/iPadOS may require installing the web app to the Home Screen. See [MDN's Push API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) and the [web-push library](https://github.com/web-push-libs/web-push).

Publishing a broadcast sends it to every active subscribed account. Updating status/category/severity, or adding a public note, sends a generic update to the identified reporter's subscribed devices. Anonymous reports cannot be linked to an account and do not receive private report notifications. Area targeting is deferred with the interactive map. Internal notes and assignment changes do not trigger private reporter notifications.

Push is best effort: the database remains authoritative. Failed delivery never undoes a saved report/update/broadcast. Expired subscriptions (HTTP 404/410) are removed, and transient failures surface a warning to staff. This version does not have a persistent notification outbox or automatic retry queue. Existing subscriptions are resynchronised on login. If the browser removes a subscription, opt in again.

For private storage and Auth configuration, see [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control) and [password-based Auth](https://supabase.com/docs/guides/auth/passwords).

## Verification

```bash
npm test
```

Tests run the baseline and migration against embedded PostgreSQL (PGlite) with minimal Auth/Storage fixtures. They exercise repeated migrations, actual database role checks, civilian privacy, assignment, timestamps and public notes. API tests use a fake Supabase client to cover authentication, validation, upload failure, edit conflicts and push triggers. Push tests mock the delivery service; no real emergency reports or notifications are sent.

Before deployment, verify with a development Supabase project:

1. Register/confirm a civilian account. Log in and submit an identified report with manual location and an image. Confirm My reports shows it.
2. Submit anonymously while logged in. Confirm it never appears in My reports. Staff can see the incident and image.
3. As admin, assign an active responder, change category/severity and add both a private and a public note. Confirm the reporter sees only public history. As responder, confirm assignment cannot be changed, including through a direct RPC call.
4. Open a stale incident in another browser, update it elsewhere and attempt to save. Confirm the stale save is rejected. Refresh and retry.
5. Opt in to push on the civilian device, close/minimise the app, then make a staff status change. Verify the device notification and click-through. Publish a broadcast and verify it reaches subscribed devices. Sign out and confirm this device stops receiving notifications.
6. Verify expired broadcasts disappear and the map placeholder is reachable on desktop/mobile.

## Remaining small/medium improvements

- Unread indicators and notification preferences by category/severity.
- A durable push outbox and retry worker for delivery after server/network failures.
- CAPTCHA and deployment-wide rate limiting before opening the service publicly (the current limiter is in-memory per server).
- Duplicate-incident linking, staff escalation reminders, and pagination for larger queues.
- Password reset and email-change flows; phone/OTP authentication remains deferred.
- Offline draft saving, then queued submission with clear sync status.

Interactive mapping/geocoding and the report/schema reconciliation remain outside this increment.
