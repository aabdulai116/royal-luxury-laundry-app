# Supabase setup — the push notification worker

This replaces a Firebase Cloud Function with a Supabase Edge Function that does the same job:
watch for a "please notify someone" request and send a push. Supabase's free tier needs no
credit card. Nothing here touches your orders, customers, or the admin dashboard — those stay
exactly where they are, in Firestore.

## 1. Create the Supabase project (~5 minutes)

1. Go to [supabase.com](https://supabase.com) and sign up (GitHub or email, no card needed).
2. **New project** → name it something like `royal-luxury-laundry-push` → pick a region close
   to Ghana (e.g. an EU region) → set a database password (you won't need it day to day, just
   store it somewhere safe) → create.

## 2. Get a Firebase service account key (~2 minutes)

This is what lets the worker read Firestore and send pushes — treat it like a password.

1. [Firebase console](https://console.firebase.google.com) → the `royal-luxury-laundry`
   project → gear icon → **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → confirm → it downloads a `.json` file.
3. Keep that file somewhere safe and never commit it to any code repository or share it — it
   grants full admin access to your Firebase project.

## 3. Install the Supabase CLI and link the project

On your computer, from inside the `rll-app` folder:

```
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

(`<your-project-ref>` is in the Supabase dashboard URL, e.g.
`supabase.com/dashboard/project/abcdefghijklmno` → the ref is `abcdefghijklmno`.)

## 4. Set the two secrets the worker needs

```
supabase secrets set FIREBASE_SERVICE_ACCOUNT_JSON="$(cat /path/to/the-downloaded-key.json)"
supabase secrets set PUSH_WORKER_SECRET="make-up-a-long-random-password-here"
```

`PUSH_WORKER_SECRET` is a password you invent yourself — write it down, you'll need it again in
step 6. It stops a stranger who finds the function's public URL from triggering it.

## 5. Deploy the function

```
supabase functions deploy send-push --no-verify-jwt
```

`--no-verify-jwt` is needed because the cron job calling this isn't a logged-in Supabase user —
the `PUSH_WORKER_SECRET` check inside the function is what actually protects it.

## 6. Schedule it to run every minute

1. In the Supabase dashboard: **Database → Extensions** → enable `pg_cron` and `pg_net` (both
   free, one click each).
2. **SQL Editor** → new query → paste this, filling in your project ref and the same secret
   from step 4:

```sql
select cron.schedule(
  'send-push-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<your-project-ref>.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Authorization', 'Bearer <your-push-worker-secret>')
  );
  $$
);
```

3. Run it. That's the whole schedule set up — no further steps.

## 7. Test it

1. Book a test order through the app (once Part 2 or 3 of the main handoff has it installed on
   a phone or emulator).
2. Within about a minute, check: did the push arrive? If not, **Supabase dashboard → Edge
   Functions → send-push → Logs** will show what happened — most first-time issues are a typo
   in one of the two secrets.
3. You can also trigger it manually any time, without waiting for the cron job:
   ```
   curl -X POST https://<your-project-ref>.supabase.co/functions/v1/send-push \
     -H "Authorization: Bearer <your-push-worker-secret>"
   ```
   It responds with how many notifications it checked, sent, and skipped.

## What this does and doesn't cost

Supabase's free tier includes 500,000 Edge Function calls a month — this worker calling itself
once a minute uses about 43,000 a month, well inside that, so this should cost $0 indefinitely
at this business's scale. No card is required to stay on the free tier.
