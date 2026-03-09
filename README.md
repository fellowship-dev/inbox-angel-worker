# inbox-angel-worker

Cloudflare Workers backend for [InboxAngel](https://github.com/Fellowship-dev/inbox-angel).
Handles inbound email parsing, DMARC aggregate report processing, DNS provisioning, and the API surface consumed by the frontend.

## Philosophy

Run it yourself or use our hosted service. Either way, your data lives in a database you control and can export at any time. Open source, no lock-in.

---

## Self-hosting

### Before you start — create your Cloudflare API token

The Worker needs a token at runtime to manage Email Routing rules and DNS records. This is **separate** from the token Cloudflare auto-creates when you click the deploy button (that one is only for deploying the Worker).

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**
2. Give it a name (e.g. `inbox-angel-runtime`)
3. Set these permissions:

| Scope | Resource | Permission |
|---|---|---|
| Account | Account Settings | Read |
| Account | Email Sending | Edit |
| Zone | Email Routing Rules | Edit |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |

4. Under **Zone Resources**, select the zone where your `REPORTS_DOMAIN` subdomain will live (e.g. `yourdomain.com`)
5. Click **Continue to summary** → **Create Token** — copy it, you'll paste it as `CLOUDFLARE_API_TOKEN` below

You'll also need your **Zone ID**: go to [dash.cloudflare.com](https://dash.cloudflare.com) → click your domain → scroll down the right sidebar. Copy the Zone ID.

---

### Step 1 — Deploy

**Option A — one click (recommended):**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Fellowship-dev/inbox-angel-worker)

The button forks the repo, creates a D1 database, and prompts for all secrets before deploying. Fill in the secrets form with the values from the section above. The Worker auto-migrates the database schema on first request — no extra step needed.

**Option B — CLI:**

```bash
npm install && npm install --prefix dashboard

# Edit wrangler.jsonc — update account_id, name, and routes for your domain
# Then deploy:
npm run deploy
```

Set secrets:

```bash
wrangler secret put CLOUDFLARE_API_TOKEN # the runtime token you created above
wrangler secret put CLOUDFLARE_ZONE_ID   # your zone ID (right sidebar on dash.cloudflare.com → your domain)
wrangler secret put REPORTS_DOMAIN       # subdomain for reports, e.g. reports.yourdomain.com
wrangler secret put FROM_EMAIL           # e.g. noreply@reports.yourdomain.com
wrangler secret put CUSTOMER_DOMAIN      # your domain, e.g. yourdomain.com
wrangler secret put CUSTOMER_EMAIL       # your email address
wrangler secret put CUSTOMER_NAME        # your org display name
```

---

### Step 2 — Create your account

Open your worker URL. On first visit you'll see a setup form — enter your name, email, and a password. That's your admin account. No `API_KEY` needed.

On first domain add, the Worker automatically:
- Enables Email Routing on your Cloudflare zone
- Adds MX records for `REPORTS_DOMAIN`
- Sets the catch-all rule: `*@REPORTS_DOMAIN` → this Worker

---

### Step 3 — Update your DMARC record

After adding the domain, the dashboard shows your `rua` address. Append it to your existing DMARC record — don't replace it:

```
_dmarc.yourdomain.com TXT "v=DMARC1; p=none; rua=mailto:<existing>,mailto:rua@reports.yourdomain.com"
```

Reports from receiving mail servers worldwide will start arriving within 24 hours.

---

## Two Core Flows

### 1. Free Check (the hook)

User sends one email → Worker receives it → analyzes headers → result appears in dashboard.

```
User sends email to {token}@reports.yourdomain.com
  └── Cloudflare Email Worker receives it
        ├── Reads authentication results from headers:
        │   ├── SPF (pass/fail/softfail + which server sent it)
        │   ├── DKIM (pass/fail + signing domain)
        │   └── DMARC (pass/fail + policy in effect)
        └── Stores result → dashboard polls and displays report
```

No account required. Generate a check address from the Email check page.

### 2. Domain Monitoring (the product)

Customer configures their DMARC record to report back to InboxAngel. Receiving mail servers worldwide send XML aggregate reports. Worker parses, stores in D1, surfaces in dashboard.

```
Customer DNS:
  _dmarc.company.com  TXT  "v=DMARC1; p=none; rua=mailto:abc123@reports.yourdomain.com"

Receiving mail servers → send XML aggregate reports → Cloudflare Email Worker
  └── Worker parses XML
        ├── Extracts: sending IPs, pass/fail rates, policy disposition
        └── Stores in D1 → dashboard shows trends
```

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Compute | Cloudflare Workers | Edge runtime, zero cold start |
| Inbound email | Cloudflare Email Workers | Receives `*@REPORTS_DOMAIN` |
| Outbound email | Cloudflare Email Workers | Sends digests and alerts |
| Storage | Cloudflare D1 | SQLite at the edge |
| DNS provisioning | Cloudflare DNS API | Provisions per-domain authorization records |
| Auth | Email + password | Admin account created on first visit |
| Frontend | Embedded SPA | Built from `dashboard/`, served as static assets |

---

## Local Development

```bash
npm install
npm install --prefix dashboard
npm run dev:dashboard   # Vite dev server on :5173
wrangler dev            # Worker on :8787
```

---

## DNS Provisioning

Each monitored domain gets a third-party reporting authorization record (RFC 7489 §7.1):

```
company.com._report._dmarc.reports.yourdomain.com  TXT  "v=DMARC1"
```

Without this, receiving mail servers silently reject the external RUA address. The worker provisions it automatically via the Cloudflare DNS API when you add a domain. If your domain is on external DNS, the dashboard shows the record value to add manually.

---

## Uninstalling

No lock-in. Here's how to leave cleanly.

**1. Export your data first**

Dashboard → any domain → Settings → Export. Downloads a full JSON export of all reports, sources, and stats for that domain. Do this for each domain before proceeding.

**2. Remove your domains from the dashboard**

Dashboard → each domain → Settings → Delete domain. This automatically removes the DNS authorization records the worker provisioned (`company.com._report._dmarc.reports.yourdomain.com`).

**3. Update your DMARC records**

Remove the `rua@reports.yourdomain.com` address from each domain's `_dmarc` TXT record. Leave any other `rua` addresses intact.

**4. Delete the Worker and database**

```bash
wrangler delete                        # removes the Worker and its routes
wrangler d1 delete inbox-angel         # permanently deletes the D1 database + all data
```

**5. Clean up email routing**

In the Cloudflare dashboard → your zone → Email → Routing:
- Delete or update the catch-all rule that points to this Worker
- Delete the MX records added for your `REPORTS_DOMAIN` subdomain (e.g. `reports.yourdomain.com`)

**6. Delete the API tokens**

Cloudflare dashboard → My Profile → API Tokens → delete the token you created for this Worker.

---

## Related

- [RFC 7489](https://datatracker.ietf.org/doc/html/rfc7489) — DMARC specification
- [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
