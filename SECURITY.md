# Security Policy

## Reporting a vulnerability

Please do not publish sensitive security vulnerabilities in a public GitHub issue.

Report security concerns privately to the repository owner through GitHub. Include:

- A clear description of the vulnerability
- Steps to reproduce it
- The affected component or file
- The potential impact
- Any useful logs or proof of concept

Do not include passwords, API keys, access tokens, M-Pesa credentials, Supabase secret keys, or other private credentials in a report.

## Secrets

Never commit:

- Supabase service-role or secret keys
- M-Pesa consumer secrets or passkeys
- Gemini API keys
- Personal access tokens
- Database credentials

Client-side Supabase publishable configuration is intentionally used by the application. It must never be replaced with a privileged Supabase secret key.
