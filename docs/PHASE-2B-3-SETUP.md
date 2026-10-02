# FieldInspect Pro — Billing & Phase 3 Setup

## Phase 2B: M-Pesa billing

The repository now contains:

- `supabase/migrations/202610020001_billing.sql`
- `supabase/functions/mpesa-stk-push/index.ts`
- `supabase/functions/mpesa-callback/index.ts`
- `supabase/functions/.env.example`
- `supabase/config.toml`

The browser only uses the Supabase publishable key. M-Pesa credentials and Supabase secret keys belong in Supabase Edge Function secrets.

### 1. Apply the database migrations

From the repository root:

```bash
npx supabase db push --project-ref aynlfxquofvlnthxuqcl
```

If the CLI asks for authentication, authenticate with the Supabase CLI first.

### 2. Configure Daraja secrets

Create the following secrets in Supabase Edge Functions:

```text
MPESA_ENV=sandbox
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://aynlfxquofvlnthxuqcl.supabase.co/functions/v1/mpesa-callback
```

For local development, copy the values into `supabase/functions/.env`. Never commit that file.

### 3. Deploy the functions

```bash
npx supabase functions deploy mpesa-stk-push --project-ref aynlfxquofvlnthxuqcl
npx supabase functions deploy mpesa-callback --project-ref aynlfxquofvlnthxuqcl
```

### 4. Test in sandbox first

Use the Daraja sandbox credentials and a supported test number. Do not switch `MPESA_ENV` to `live` until the full callback flow has been verified.

The application calls:

```text
/functions/v1/mpesa-stk-push
```

and Safaricom calls:

```text
/functions/v1/mpesa-callback
```

### Phase 3: cloud inspection sync

The repository also contains:

- `supabase/migrations/202610020002_phase3_cloud_inspections.sql`

This creates:

- cloud inspection records
- per-user Row Level Security
- profile records
- automatic profile creation for new accounts
- timestamps for synchronization

The next implementation step is to connect the existing Inspection History UI to this cloud table so an authenticated user can move between the web app and Windows app without losing inspection records.

## Security rules

Never place any of these in `index.html`, `auth-config.js`, Electron files, GitHub Actions source, or other shipped frontend code:

- M-Pesa consumer secret
- M-Pesa passkey
- Supabase secret key
- Supabase service-role key

Only the Supabase publishable key belongs in client code.
