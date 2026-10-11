# Computer Institution Management System

This project has two parts:

- **Google Apps Script:** backend API only, connected to the spreadsheet database and Google Drive.
- **Vercel:** separate frontend (`frontend/html`, `frontend/css`, `frontend/js`) and a small serverless proxy that securely connects it to the Apps Script API without browser CORS problems.

## VS Code project folders

```text
backend/
  Auth.gs
  Code.gs
  Config.gs
  Database.gs
  DriveManager.gs
  Finance.gs
frontend/
  html/
    index.html
  css/
    styles.css
  js/
    app.js
    modules.js
api/
  gas-api.js
build.js
vercel.json
appsscript.json
package.json
```

Do not paste the frontend into Apps Script. Google Sheets holds the data, Apps Script runs the API, and Vercel hosts the web UI.

## Part 1 — make the spreadsheet and paste the API into Apps Script

1. Sign in to the Google account that will own the system and create one Google Spreadsheet.
2. In the spreadsheet choose **Extensions → Apps Script**.
3. In the VS Code project folder run `npm.cmd run build`. This creates one combined API file at `dist/Code.gs`.
4. In Apps Script open the default `Code.gs`. Open `dist/Code.gs` from VS Code, copy all its content, and replace the default file contents. **This is the only code file you paste into Apps Script. Do not create any other Script or HTML files there.**
5. Set the Apps Script project's time zone to `Asia/Kolkata` in **Project Settings**. Optionally, enable the manifest editor and copy `dist/appsscript.json` there.
6. Click **Save**. Select `setupDatabase` from the function dropdown, press **Run**, and approve the Sheets authorization.
7. Run `setupDriveFolders` and approve the Drive authorization.
8. Run `createAdminUser`. Enter the administrator email, name, and a strong password of at least 12 characters in the prompts. The password is hashed; never paste a password into code.
9. Select **Deploy → New deployment → Web app**:
   - **Execute as:** Me (the spreadsheet owner)
   - **Who has access:** Anyone
10. Deploy, approve the access prompt, and copy the web app URL ending in `/exec`. The API proxy is already configured with the URL you provided. If you later redeploy the Apps Script API, update the fallback in `api/gas-api.js` or override it with the Vercel environment variable below.

### Important access warning

The Apps Script web-app endpoint must accept unauthenticated HTTP requests so Vercel can reach it. The application API requires its own login for all non-login operations, but the endpoint itself is public. Use a strong administrator password, restrict application accounts, and do not share the API URL unnecessarily. Google account/domain-only deployment access will block Vercel's server-to-server call.

## Part 2 — build the separated VS Code frontend

1. Install Node.js if it is not already installed.
2. Open VS Code Terminal in this project folder:

   ```powershell
   cd "D:\Website\Computer Management"
   ```

3. Build the frontend files:

   ```powershell
   npm.cmd run build
   ```

   The single combined Apps Script API file will be `dist/Code.gs`. The Vercel static site will be in `dist/frontend/`.

## Part 3 — push to GitHub and connect Vercel

### Test locally first

1. From the project folder build the static site:

   ```powershell
   npm.cmd run build
   ```

2. Install the Vercel CLI dependency from the project:

   ```powershell
   npm.cmd install
   ```

3. Set the Apps Script endpoint in the current PowerShell window. This keeps the URL out of source and GitHub:

   ```powershell
   $env:GAS_WEB_APP_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
   ```

   Replace the example URL with your deployed Apps Script `/exec` URL. You can use the endpoint you already provided.
4. Start the local Vercel server:

   ```powershell
   npx.cmd vercel dev --local --listen 3000
   ```

5. Open `http://localhost:3000`. Sign in using the admin email/password created with `createAdminUser()` in Apps Script. Test by adding sample data first.
6. To stop the local server press **Ctrl+C**. The environment variable is only set in that PowerShell window; set it again in a new terminal.

If the local API says the endpoint is not configured, confirm `GAS_WEB_APP_URL` was set in the same PowerShell window, then restart `npx.cmd vercel dev --local --listen 3000`.

1. On GitHub, create a new empty repository. Do not initialize it with a README, license, or GitHub-generated `.gitignore`.
2. In VS Code Terminal, run these commands from the project folder:

   ```text
   git init -b main
   git add .
   git commit -m "Initial institution management app"
   git remote add origin https://github.com/YOUR_GITHUB_NAME/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   Replace the remote URL with the URL of the empty GitHub repository. If Git says your name or email is not configured, set them with `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then repeat the commit and push.
3. Sign in to Vercel in your browser. Choose **Add New → Project**, import the GitHub repository, and authorize Vercel to access it.
4. Keep the project root as `./`. Vercel reads `vercel.json` and uses `npm run build`, publishes `dist/frontend`, and deploys `api/gas-api.js` as `/api/gas-api`.
5. Before deploying, set the private Vercel environment variable:

   ```text
   Name:  GAS_WEB_APP_URL
   Value: paste the Apps Script web-app /exec URL
   ```

   Apply it to **Production**. Do not add this URL to frontend files or commit it to GitHub. The Vercel API function reads it from the environment. Redeploy the first deployment after setting the variable if Vercel has already started a deployment.
6. Open the Vercel deployment URL and sign in with the administrator email and password created in Apps Script.

After this connection, every push to GitHub's `main` branch starts a Vercel production deployment automatically. Pull requests get preview deployments. GitHub Actions also checks that `npm run build` succeeds.

The browser calls the same-origin `/api/gas-api` Vercel function; that function forwards requests to Apps Script. This avoids exposing the Apps Script URL in frontend source and avoids browser CORS configuration.

## When you change code

- Edit server-side logic in `backend/`.
- Edit page markup in `frontend/html/`.
- Edit styles in `frontend/css/`.
- Edit browser behavior in `frontend/js/`.
- Edit the Vercel-to-Apps-Script connection in `api/gas-api.js`.
- Push changes to the connected GitHub `main` branch. Vercel builds and deploys them automatically.
- If a backend `.gs` file changed, rebuild and replace the complete Apps Script `Code.gs` with the new `dist/Code.gs`, then **Deploy → Manage deployments → Edit → New version → Deploy**.
- If `GAS_WEB_APP_URL` changes, update the Vercel environment variable and redeploy.

## Current features

- 38 Google Sheets database tabs; Google Drive folder setup and file metadata.
- Password-hashed administrator login, expiring sessions, basic role checks, and audit logging.
- Academic sessions, courses, batches, fee rules, student admission/profile/edit/disable.
- Fee collection, capped fee refunds, concessions, income and refunds, expenses and reversals, staff records, payroll and salary payment.
- Central transaction ledger, account balances, cash book, date/session-filtered reports, CSV export, print-to-PDF receipt layouts, and spreadsheet copy backup.
- Student/staff documents and image uploads are limited to 3 MB to fit typical serverless request-body limits.

This is a starter implementation, not a fully audited production ERP. Attendance, certificates/ID cards, SMS/email/WhatsApp, chart dashboards, Excel export, advanced fee schedules, and complete user/role editing are not implemented. Test with sample data and verify backups before recording real financial data.
