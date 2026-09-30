# InTheLoop CRM

Restaurant loyalty + CRM for Tap to Regular: lead pipeline, guest check-in with Reward IDs,
staff redeem page, texts/emails to guests, monthly owner reports and daily backups.

## Folder layout (keep it exactly like this)
```
server.js        the app (routes, reward IDs, messages, reports, backups)
sms.js           texting via Twilio (simulated until Twilio variables are set)
email.js         email via Brevo or Resend API (simulated until a key is set)
package.json
public/          every page the browser loads
  index.html       CRM (password protected)
  checkin.html     guest sign-up page  -> /checkin/<restaurant id>
  redeem.html      staff redeem page   -> /redeem/<restaurant id>
  welcome.html     landing page        -> /welcome
  js/              app.js, checkin.js, redeem.js, welcome.js
  media/           put intheloop-vsl.mp4 here for the landing page video
data/            local data folder (on Railway this is the mounted volume)
```

## Pages
- CRM: `/` (browser asks for the ADMIN_PASSWORD)
- Guest sign-up: `/checkin/<restaurant id>`: guests fill the form once, then their phone is remembered
- Staff redeem: `/redeem/<restaurant id>`: Reward ID + staff PIN, max once per guest per day, never on sign-up day
- Landing page: `/welcome`: bookings become New Leads
- Email unsubscribe: `/unsubscribe/<token>` (linked in every guest email)

## Messages to guests
Texts go out when Twilio is set up. Until then, guests who gave an email get **emails** instead
(welcome with Reward ID, 48-hour reminder, review request, promotions). Every email has an unsubscribe link
and your mailing address, as US email law (CAN-SPAM) requires.

## Owner report
On the 1st of each month (after 9am) every **Onboarding** or **Live Client** restaurant with an owner email
gets last month's results: new members, check-ins, tracked return visits, and estimated revenue
(return visits x average check). Set each restaurant's average check in its panel. Preview or send any time
from the CRM.

## Backups
Every day after 3am a dated copy of all data is saved on the volume (last 14 kept) and, if `BACKUP_EMAIL`
is set, emailed to you as an attachment. "Download full backup" in the CRM grabs the current data any time.

## Railway variables
| Variable | What it's for |
| --- | --- |
| `ADMIN_PASSWORD` | CRM login |
| `DATA_DIR` | `/app/data` (the mounted volume) |
| `TIMEZONE` | `America/New_York` |
| `BREVO_API_KEY` *or* `RESEND_API_KEY` | turns on real emails |
| `EMAIL_FROM` | sender address verified with Brevo/Resend |
| `EMAIL_FROM_NAME` | optional, default "InTheLoop" |
| `BUSINESS_ADDRESS` | your mailing address, shown in guest emails (required by CAN-SPAM) |
| `BACKUP_EMAIL` | where the daily backup is emailed |
| `REPORT_COPY_TO` | gets a copy of every owner report |
| `DEFAULT_AVG_CHECK` | optional, default 25 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | turns on real texts (needs carrier registration) |

Railway's Free/Hobby plans block SMTP, which is why email goes through an HTTPS API.
